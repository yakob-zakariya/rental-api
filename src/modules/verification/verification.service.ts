import { Injectable, Logger } from '@nestjs/common';
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

type StartOutcome =
  { kind: 'ok'; session: StartedSession } | { kind: 'conflict' };

/**
 * Local outcomes that can be resumed when Didit says the session is still unfinished. Expired is
 * included: V16 expires attempts after 24 hours, but Didit sessions currently last 7 days.
 */
const RESUMABLE = [
  VerificationOutcome.Pending,
  VerificationOutcome.Abandoned,
  VerificationOutcome.Expired,
];

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

  private async startLocked(
    manager: EntityManager,
    userId: string,
  ): Promise<StartOutcome> {
    await manager.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`verification:${userId}`],
    );

    const [user] = await manager.query<
      { verification_status: VerificationStatus }[]
    >(`SELECT verification_status FROM users WHERE id = $1`, [userId]);
    // V1, then V13.
    if (user.verification_status === VerificationStatus.Approved)
      throw alreadyVerified();
    if (user.verification_status === VerificationStatus.ManualReview) {
      throw verificationInReview();
    }
    if (user.verification_status === VerificationStatus.Blocked) {
      throw verificationUnavailable();
    }

    // V2: resume a recent pending attempt. Not a new session, so not counted toward V3.
    const recent = await this.latestPendingSession(
      manager,
      userId,
      RESUME_WINDOW_MINUTES,
    );
    if (recent) return { kind: 'ok', session: recent };

    if (await this.retryLimitReached(manager, userId)) {
      // At the V3 limit, a pending attempt of any age is resumed from what we stored, without
      // calling Didit: a call could create a 4th session if Didit has finished the old one.
      const pending = await this.latestPendingSession(manager, userId);
      if (pending) return { kind: 'ok', session: pending };
      throw await this.retryLimitError(manager, userId);
    }

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
      // An abandoned or expired attempt is reopened, since Didit says it is still live.
      await manager.query(
        `UPDATE identity_verifications
         SET outcome = 'pending', verification_url = $2, session_token = $3, provider_status = $4
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

  /** V3: max 3 created sessions per rolling 24 hours; every attempt row counts. */
  private async retryLimitReached(
    manager: EntityManager,
    userId: string,
  ): Promise<boolean> {
    const [window] = await manager.query<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM identity_verifications
       WHERE user_id = $1 AND created_at > clock_timestamp() - make_interval(hours => $2)`,
      [userId, SESSION_WINDOW_HOURS],
    );
    return window.count >= MAX_SESSIONS_PER_WINDOW;
  }

  private async retryLimitError(manager: EntityManager, userId: string) {
    // Seconds until the oldest counted attempt leaves the window.
    const [window] = await manager.query<{ retry_after: number | null }[]>(
      `SELECT ceil(extract(epoch FROM min(created_at) + make_interval(hours => $2)
                - clock_timestamp()))::int AS retry_after
       FROM identity_verifications
       WHERE user_id = $1 AND created_at > clock_timestamp() - make_interval(hours => $2)`,
      [userId, SESSION_WINDOW_HOURS],
    );

    // Manual review is offered only when the latest attempt was declined by Didit itself.
    const [latest] = await manager.query<
      { outcome: VerificationOutcome; provider_status: string }[]
    >(
      `SELECT outcome, provider_status FROM identity_verifications
       WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [userId],
    );
    const manualReviewAvailable =
      latest?.outcome === VerificationOutcome.Declined &&
      latest.provider_status === DiditStatus.Declined;

    return verificationRetryLimit(
      manualReviewAvailable,
      Math.max(1, window.retry_after ?? 1),
    );
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
