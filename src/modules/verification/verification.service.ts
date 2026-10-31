import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { VerificationStatus } from '../users/user.enums.js';
import { DiditApiError } from './didit/didit-api.error.js';
import { DiditClient } from './didit/didit-client.js';
import { DiditStatus, type DiditSession } from './didit/didit.types.js';
import { VerificationOutcome } from './verification.enums.js';
import {
  alreadyVerified,
  verificationInReview,
  verificationProviderUnavailable,
  verificationRetryLimit,
  verificationUnavailable,
} from './verification.errors.js';
import { VerificationStatusService } from './verification-status.service.js';

/** V2: a pending attempt younger than this is resumed instead of starting a new session. */
export const RESUME_WINDOW_MINUTES = 30;
/** V3: at most this many created sessions per rolling window. */
export const MAX_SESSIONS_PER_WINDOW = 3;
export const SESSION_WINDOW_HOURS = 24;

export interface StartedSession {
  verificationUrl: string;
  sessionToken: string;
}

/** User-safe reason for a declined verification (never for blocked or manual_review). */
export enum VerificationReasonCode {
  Underage = 'UNDERAGE',
  DocumentNotVerified = 'DOCUMENT_NOT_VERIFIED',
}

/** GET /verification/status (spec §4 flow step 6). */
export interface VerificationStatusView {
  status: VerificationStatus;
  /** POST /verification/sessions would start or resume a session right now. */
  canRetry: boolean;
  retriesLeftToday: number;
  canRequestManualReview: boolean;
  reasonCode?: VerificationReasonCode;
}

/**
 * What POST /verification/sessions may do for this user right now (V1, V13, V2, V3). The one
 * source of truth for both starting a session and the status endpoint's canRetry.
 */
type Eligibility =
  | { kind: 'refused'; status: VerificationStatus }
  | { kind: 'resume'; session: StartedSession }
  | { kind: 'limit'; manualReviewAvailable: boolean; retryAfterSeconds: number }
  | { kind: 'create' };

type StartOutcome =
  { kind: 'ok'; session: StartedSession } | { kind: 'conflict' };

interface LatestAttempt {
  id: string;
  outcome: VerificationOutcome;
  provider_status: string;
  decided_by_staff: boolean;
}

/**
 * Local outcomes that can be resumed when Didit says the session is still unfinished. Expired is
 * included: V16 expires attempts after 24 hours, but Didit sessions currently last 7 days.
 */
const RESUMABLE = [
  VerificationOutcome.Pending,
  VerificationOutcome.Abandoned,
  VerificationOutcome.Expired,
];

const manualReviewNotAvailable = () =>
  new ConflictException({ code: 'MANUAL_REVIEW_NOT_AVAILABLE' });

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly didit: DiditClient,
    private readonly status: VerificationStatusService,
  ) {}

  /**
   * POST /verification/sessions (spec §4 flow step 1): checks V1, V13, V2, V3 in that order,
   * then creates (or, if Didit reuses one, resumes) a Didit session, supersedes older pending
   * attempts (V14) and recomputes. Runs under a per-user lock; note the transaction stays open
   * during the Didit call (see the deployment checklist).
   */
  async startSession(userId: string): Promise<StartedSession> {
    // Decided inside the transaction, thrown after commit, so a conflict flag is kept.
    const outcome = await this.dataSource.transaction((manager) =>
      this.startLocked(manager, userId),
    );
    if (outcome.kind === 'conflict') throw verificationProviderUnavailable();
    return outcome.session;
  }

  /** GET /verification/status. Blocked users learn nothing beyond "blocked" (hard rule 10). */
  async getStatus(userId: string): Promise<VerificationStatusView> {
    const manager = this.dataSource.manager;
    const eligibility = await this.eligibility(manager, userId);
    const status = await this.userStatus(manager, userId);

    if (status === VerificationStatus.Blocked) {
      return {
        status,
        canRetry: false,
        retriesLeftToday: 0,
        canRequestManualReview: false,
      };
    }

    const { count } = await this.window(manager, userId);
    const view: VerificationStatusView = {
      status,
      canRetry: eligibility.kind === 'resume' || eligibility.kind === 'create',
      retriesLeftToday: Math.max(0, MAX_SESSIONS_PER_WINDOW - count),
      canRequestManualReview:
        eligibility.kind === 'limit' && eligibility.manualReviewAvailable,
    };
    if (status === VerificationStatus.Declined) {
      view.reasonCode = await this.reasonCode(manager, userId);
    }
    return view;
  }

  /**
   * POST /verification/manual-review-request (spec §4 flow step 7): only at the V3 limit, and only
   * when the most recent attempt was declined by Didit (not by us, not by staff). Moves that
   * attempt to manual_review for staff and recomputes.
   */
  async requestManualReview(userId: string): Promise<VerificationStatusView> {
    await this.dataSource.transaction(async (manager) => {
      await this.lockUser(manager, userId);
      const eligibility = await this.eligibility(manager, userId);
      if (eligibility.kind === 'refused') throw refusal(eligibility.status);
      if (eligibility.kind !== 'limit' || !eligibility.manualReviewAvailable) {
        throw manualReviewNotAvailable();
      }

      const latest = (await this.latestAttempt(manager, userId))!;
      // Guarded on the current outcome too, so it's safe even if two requests got this far.
      const updated = await manager.query<{ id: string }[]>(
        `UPDATE identity_verifications
         SET outcome = 'manual_review', manual_review_requested_at = clock_timestamp()
         WHERE id = $1 AND outcome = 'declined'
         RETURNING id`,
        [latest.id],
      );
      if (updated.length === 0) throw verificationInReview();
      await this.status.recomputeVerificationStatus(userId, manager);
      this.logger.log(`Attempt ${latest.id}: manual review requested`);
    });
    return this.getStatus(userId);
  }

  private async startLocked(
    manager: EntityManager,
    userId: string,
  ): Promise<StartOutcome> {
    await this.lockUser(manager, userId);

    const eligibility = await this.eligibility(manager, userId);
    switch (eligibility.kind) {
      case 'refused':
        throw refusal(eligibility.status);
      case 'resume':
        return { kind: 'ok', session: eligibility.session };
      case 'limit':
        throw verificationRetryLimit(
          eligibility.manualReviewAvailable,
          eligibility.retryAfterSeconds,
        );
      case 'create':
        return this.createOrResumeAtDidit(manager, userId);
    }
  }

  private async eligibility(
    manager: EntityManager,
    userId: string,
  ): Promise<Eligibility> {
    // V1, then V13.
    const status = await this.userStatus(manager, userId);
    if (
      status === VerificationStatus.Approved ||
      status === VerificationStatus.ManualReview ||
      status === VerificationStatus.Blocked
    ) {
      return { kind: 'refused', status };
    }

    // V2: resume a recent pending attempt. Not a new session, so not counted toward V3.
    const recent = await this.latestPendingSession(
      manager,
      userId,
      RESUME_WINDOW_MINUTES,
    );
    if (recent) return { kind: 'resume', session: recent };

    const { count, retryAfterSeconds } = await this.window(manager, userId);
    if (count >= MAX_SESSIONS_PER_WINDOW) {
      // At the V3 limit, a pending attempt of any age is resumed from what we stored, without
      // calling Didit: a call could create a 4th session if Didit has finished the old one.
      const pending = await this.latestPendingSession(manager, userId);
      if (pending) return { kind: 'resume', session: pending };
      const latest = await this.latestAttempt(manager, userId);
      return {
        kind: 'limit',
        manualReviewAvailable: !!latest && isDiditDecline(latest),
        retryAfterSeconds,
      };
    }
    return { kind: 'create' };
  }

  private async createOrResumeAtDidit(
    manager: EntityManager,
    userId: string,
  ): Promise<StartOutcome> {
    let session: DiditSession;
    try {
      session = await this.didit.createSession({ vendorData: userId });
    } catch (error) {
      if (!(error instanceof DiditApiError)) throw error;
      // Kind only: Didit errors never carry bodies, but keep the log minimal anyway.
      this.logger.warn(`Didit createSession failed: ${error.kind}`);
      throw verificationProviderUnavailable(error.retryAfterSeconds);
    }

    const [existing] = await manager.query<
      {
        id: string;
        user_id: string;
        outcome: VerificationOutcome;
        flagged: boolean;
      }[]
    >(
      `SELECT id, user_id, outcome, flagged_at IS NOT NULL AS flagged
       FROM identity_verifications WHERE provider_session_id = $1 FOR UPDATE`,
      [session.sessionId],
    );

    let attemptId: string;
    if (existing) {
      if (
        existing.user_id !== userId ||
        !RESUMABLE.includes(existing.outcome)
      ) {
        await this.flagStateConflict(manager, existing, session);
        return { kind: 'conflict' };
      }
      // Didit reused an unfinished session we already have: a resume (V2, V14), not counted.
      // An abandoned or expired attempt is reopened, since Didit says it is still live; its
      // polling/V16 clock restarts (pending_since), so it isn't expired again on the next pass.
      await manager.query(
        `UPDATE identity_verifications
         SET pending_since = CASE WHEN outcome = 'pending' THEN pending_since
                                  ELSE clock_timestamp() END,
             outcome = 'pending', verification_url = $2, session_token = $3, provider_status = $4
         WHERE id = $1`,
        [existing.id, session.url, session.sessionToken, session.status],
      );
      attemptId = existing.id;
    } else {
      const [inserted] = await manager.query<{ id: string }[]>(
        `INSERT INTO identity_verifications
           (user_id, provider_session_id, provider_status, verification_url, session_token)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          userId,
          session.sessionId,
          session.status,
          session.url,
          session.sessionToken,
        ],
      );
      attemptId = inserted.id;
    }

    // V14: every other pending attempt is superseded. A late final Didit decision for one is
    // still processed (T2.6).
    await manager.query(
      `UPDATE identity_verifications
       SET outcome = 'abandoned', verification_url = NULL, session_token = NULL
       WHERE user_id = $1 AND outcome = 'pending' AND id <> $2`,
      [userId, attemptId],
    );

    await this.status.recomputeVerificationStatus(userId, manager);
    return {
      kind: 'ok',
      session: {
        verificationUrl: session.url,
        sessionToken: session.sessionToken,
      },
    };
  }

  /** Serialises a user's starts and manual-review requests. */
  private async lockUser(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    await manager.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`verification:${userId}`],
    );
  }

  private async userStatus(
    manager: EntityManager,
    userId: string,
  ): Promise<VerificationStatus> {
    const [user] = await manager.query<
      { verification_status: VerificationStatus }[]
    >(`SELECT verification_status FROM users WHERE id = $1`, [userId]);
    return user.verification_status;
  }

  /** The newest pending attempt's stored URL and token; optionally only if younger than N minutes. */
  private async latestPendingSession(
    manager: EntityManager,
    userId: string,
    withinMinutes?: number,
  ): Promise<StartedSession | null> {
    const [row] = await manager.query<
      { verification_url: string | null; session_token: string | null }[]
    >(
      `SELECT verification_url, session_token FROM identity_verifications
       WHERE user_id = $1 AND outcome = 'pending'
         AND ($2::int IS NULL
              OR created_at > clock_timestamp() - make_interval(mins => $2::int))
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [userId, withinMinutes ?? null],
    );
    return row?.verification_url && row.session_token
      ? {
          verificationUrl: row.verification_url,
          sessionToken: row.session_token,
        }
      : null;
  }

  /**
   * V3's rolling window: sessions created in the last 24 hours (every attempt row counts), and
   * the seconds until the oldest of them leaves the window.
   */
  private async window(
    manager: EntityManager,
    userId: string,
  ): Promise<{ count: number; retryAfterSeconds: number }> {
    const [window] = await manager.query<
      { count: number; retry_after: number | null }[]
    >(
      `SELECT count(*)::int AS count,
              ceil(extract(epoch FROM min(created_at) + make_interval(hours => $2)
                - clock_timestamp()))::int AS retry_after
       FROM identity_verifications
       WHERE user_id = $1 AND created_at > clock_timestamp() - make_interval(hours => $2)`,
      [userId, SESSION_WINDOW_HOURS],
    );
    return {
      count: window.count,
      retryAfterSeconds: Math.max(1, window.retry_after ?? 1),
    };
  }

  private async latestAttempt(
    manager: EntityManager,
    userId: string,
  ): Promise<LatestAttempt | undefined> {
    const [latest] = await manager.query<LatestAttempt[]>(
      `SELECT id, outcome, provider_status,
              decided_by_admin_id IS NOT NULL AS decided_by_staff
       FROM identity_verifications
       WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [userId],
    );
    return latest;
  }

  /** The declined attempt recompute used (newest that isn't abandoned/expired). */
  private async reasonCode(
    manager: EntityManager,
    userId: string,
  ): Promise<VerificationReasonCode> {
    const [row] = await manager.query<{ decline_reason: string | null }[]>(
      `SELECT decline_reason FROM identity_verifications
       WHERE user_id = $1 AND outcome NOT IN ('abandoned', 'expired')
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [userId],
    );
    // Only our own reasons are specific; Didit's warnings aren't mapped yet (after T2.9).
    return row?.decline_reason === 'UNDERAGE'
      ? VerificationReasonCode.Underage
      : VerificationReasonCode.DocumentNotVerified;
  }

  /** Didit returned a session that is approved/declined/blocked/manual_review here (or not this user's). */
  private async flagStateConflict(
    manager: EntityManager,
    existing: { id: string; outcome: VerificationOutcome; flagged: boolean },
    session: DiditSession,
  ): Promise<void> {
    this.logger.error(
      `Didit returned session ${session.sessionId} (status "${session.status}") for attempt ` +
        `${existing.id}, which is ${existing.outcome} locally; flagged for staff`,
    );
    // Never overwrite an existing flag (e.g. DUPLICATE_IDENTITY): staff would lose it.
    if (existing.flagged) return;
    await manager.query(
      `UPDATE identity_verifications
       SET flagged_at = clock_timestamp(), flag_reason = 'PROVIDER_SESSION_STATE_CONFLICT'
       WHERE id = $1`,
      [existing.id],
    );
  }
}

/** Declined by Didit itself: not by our checks (e.g. UNDERAGE) and not by staff. */
function isDiditDecline(attempt: LatestAttempt): boolean {
  return (
    attempt.outcome === VerificationOutcome.Declined &&
    attempt.provider_status === DiditStatus.Declined &&
    !attempt.decided_by_staff
  );
}

/** V1 / V13 errors for a refused user. */
function refusal(status: VerificationStatus) {
  if (status === VerificationStatus.Approved) return alreadyVerified();
  if (status === VerificationStatus.ManualReview) return verificationInReview();
  return verificationUnavailable();
}
