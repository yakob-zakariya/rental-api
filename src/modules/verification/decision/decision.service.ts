import { Injectable, Logger } from '@nestjs/common';
import { EntityManager, QueryFailedError } from 'typeorm';
import { VerificationStatus } from '../../users/user.enums.js';
import { DiditClient } from '../didit/didit-client.js';
import type { DiditIdVerification } from '../didit/didit.types.js';
import { IdentityHasher } from '../identity-hasher.js';
import { VerificationOutcome } from '../verification.enums.js';
import { VerificationStatusService } from '../verification-status.service.js';
import { DECISION_TIME_ZONE, isUnder18, todayIn } from './age.js';
import {
  extractIdentity,
  type ExtractedIdentity,
  IdentityProblem,
} from './identifiers.js';
import { normaliseName } from './name.js';
import { classifyDiditStatus } from './status-mapping.js';
import { decideTransition } from './transition.js';

export interface DecisionInput {
  sessionId: string;
  /** Didit's session status, exactly as received. */
  status: string;
  /** Trimmed documents of the decision; null if not at hand (fetched when needed). */
  idVerifications: DiditIdVerification[] | null;
}

interface AttemptRow {
  id: string;
  user_id: string;
  outcome: VerificationOutcome;
  decided_by_staff: boolean;
  flagged: boolean;
}

/** The result of our own checks on a Didit approval. */
interface Evaluation {
  outcome: VerificationOutcome;
  declineReason: string | null;
  flagReason: string | null;
}

const UNIQUE_VIOLATION = '23505';
const APPROVED_HASH_INDEX = 'UQ_identity_hashes_hash_approved';
const V8_PROBLEMS = [
  IdentityProblem.NoIdentifier,
  IdentityProblem.NoDateOfBirth,
  IdentityProblem.PassportWithoutCountry,
];

/**
 * Applies a Didit decision to an attempt (spec §4 flow step 4), shared by the webhook and the
 * polling job. Always runs inside the caller's transaction, so the attempt lock, the outcome, the
 * hashes, the recompute and the user's fields all commit together.
 */
@Injectable()
export class DecisionService {
  private readonly logger = new Logger('Decisions');

  constructor(
    private readonly didit: DiditClient,
    private readonly hasher: IdentityHasher,
    private readonly status: VerificationStatusService,
  ) {}

  async apply(input: DecisionInput, manager: EntityManager): Promise<void> {
    // FOR UPDATE: the webhook and the polling job never process one session at the same time.
    const [attempt] = await manager.query<AttemptRow[]>(
      `SELECT id, user_id, outcome, decided_by_admin_id IS NOT NULL AS decided_by_staff,
              flagged_at IS NOT NULL AS flagged
       FROM identity_verifications WHERE provider_session_id = $1 FOR UPDATE`,
      [input.sessionId],
    );
    if (!attempt) {
      // E.g. a console "Try Webhook" test, or a session created outside this API.
      this.logger.warn(
        `Ignored a Didit decision for unknown session ${input.sessionId}`,
      );
      return;
    }

    // Always recorded, even when it changes nothing else.
    await manager.query(
      `UPDATE identity_verifications SET provider_status = $2 WHERE id = $1`,
      [attempt.id, input.status],
    );

    const transition = decideTransition({
      outcome: attempt.outcome,
      decidedByStaff: attempt.decided_by_staff,
      status: classifyDiditStatus(input.status),
    });

    if (transition.kind === 'record_only') {
      if (transition.reason === 'unknown_status') {
        this.logger.warn(
          `Unknown Didit status "${input.status}" for attempt ${attempt.id}`,
        );
      }
      return;
    }

    if (transition.kind === 'set_outcome') {
      await this.setOutcome(manager, attempt, {
        outcome: transition.outcome,
        declineReason:
          transition.outcome === VerificationOutcome.Declined
            ? 'DIDIT_DECLINED'
            : null,
        flagReason: null,
      });
      if (attempt.outcome === VerificationOutcome.Approved) {
        await this.reverseApproval(manager, attempt);
      }
    } else {
      const documents =
        input.idVerifications ??
        (await this.didit.getDecision(input.sessionId)).idVerifications;
      await this.evaluateApproval(manager, attempt, extractIdentity(documents));
    }

    await this.syncUser(manager, attempt.user_id);
  }

  /** Didit approved: our own checks in spec order (first match wins), then approve. */
  private async evaluateApproval(
    manager: EntityManager,
    attempt: AttemptRow,
    identity: ExtractedIdentity,
  ): Promise<void> {
    const hashes = identity.identifiers.map((identifier) => ({
      kind: identifier.kind,
      hash: this.hasher.hash(identifier),
    }));
    // V18: hashed only for V5/V6, never stored.
    const checkOnly = identity.checkOnlyIdentifiers.map((i) =>
      this.hasher.hash(i),
    );
    const allHashes = [...hashes.map((h) => h.hash), ...checkOnly];

    for (const { kind, hash } of hashes) {
      await manager.query(
        `INSERT INTO identity_hashes (verification_id, user_id, kind, hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (verification_id, hash) DO NOTHING`,
        [attempt.id, attempt.user_id, kind, hash],
      );
    }
    // The verified name/DOB/type are kept on every evaluated attempt (staff need them for review).
    // provider_* record exactly what Didit said; only this code writes them (staff corrections
    // change verified_name / date_of_birth only, S4).
    await manager.query(
      `UPDATE identity_verifications
       SET verified_name = $2, date_of_birth = $3, document_type = $4,
           provider_verified_name = $2, provider_date_of_birth = $3
       WHERE id = $1`,
      [
        attempt.id,
        identity.fullName,
        identity.dateOfBirth,
        identity.documentType,
      ],
    );

    const evaluation = await this.runChecks(
      manager,
      attempt,
      identity,
      allHashes,
    );
    if (evaluation.outcome === VerificationOutcome.Approved) {
      // V6 under a race: the partial unique index has the final word.
      if (!(await this.approveHashes(manager, attempt.id))) {
        await this.setOutcome(manager, attempt, {
          outcome: VerificationOutcome.Blocked,
          declineReason: 'DUPLICATE_IDENTITY',
          flagReason: 'DUPLICATE_IDENTITY',
        });
        return;
      }
    }
    await this.setOutcome(manager, attempt, evaluation);
  }

  private async runChecks(
    manager: EntityManager,
    attempt: AttemptRow,
    identity: ExtractedIdentity,
    allHashes: string[],
  ): Promise<Evaluation> {
    const has = (problem: IdentityProblem) =>
      identity.problems.includes(problem);
    const result = (
      outcome: VerificationOutcome,
      declineReason: string | null,
      flagReason: string | null,
    ): Evaluation => ({ outcome, declineReason, flagReason });

    // V5: a banned identity (any hash, including check-only ones).
    if (allHashes.length > 0) {
      const [banned] = await manager.query<unknown[]>(
        `SELECT 1 FROM banned_identities WHERE hash = ANY($1) AND lifted_at IS NULL LIMIT 1`,
        [allHashes],
      );
      if (banned)
        return result(VerificationOutcome.Blocked, 'BANNED_IDENTITY', null);

      // V6: approved for a different user.
      const [duplicate] = await manager.query<unknown[]>(
        `SELECT 1 FROM identity_hashes
         WHERE hash = ANY($1) AND is_approved AND user_id <> $2 LIMIT 1`,
        [allHashes, attempt.user_id],
      );
      if (duplicate) {
        return result(
          VerificationOutcome.Blocked,
          'DUPLICATE_IDENTITY',
          'DUPLICATE_IDENTITY',
        );
      }
    }

    // V8, V18, V17: can't be decided automatically.
    if (V8_PROBLEMS.some(has))
      return result(VerificationOutcome.ManualReview, null, 'MISSING_DATA');
    if (has(IdentityProblem.DocumentDeclined)) {
      return result(
        VerificationOutcome.ManualReview,
        null,
        'DOCUMENT_DECLINED',
      );
    }
    if (has(IdentityProblem.DocumentMismatch)) {
      return result(
        VerificationOutcome.ManualReview,
        null,
        'DOCUMENT_MISMATCH',
      );
    }

    // V4 (the date of birth exists and is valid here, or V8 would have matched).
    if (isUnder18(identity.dateOfBirth!, todayIn(DECISION_TIME_ZONE))) {
      return result(VerificationOutcome.Declined, 'UNDERAGE', null);
    }

    // V7: same normalised name + date of birth as another approved user.
    if (
      identity.fullName &&
      (await this.weakDuplicate(manager, attempt, identity))
    ) {
      return result(
        VerificationOutcome.ManualReview,
        null,
        'POSSIBLE_DUPLICATE',
      );
    }

    return result(VerificationOutcome.Approved, null, null);
  }

  private async weakDuplicate(
    manager: EntityManager,
    attempt: AttemptRow,
    identity: ExtractedIdentity,
  ): Promise<boolean> {
    const rows = await manager.query<{ verified_name: string }[]>(
      `SELECT verified_name FROM identity_verifications
       WHERE outcome = 'approved' AND user_id <> $1 AND date_of_birth = $2
         AND verified_name IS NOT NULL`,
      [attempt.user_id, identity.dateOfBirth],
    );
    const name = normaliseName(identity.fullName!);
    return rows.some((row) => normaliseName(row.verified_name) === name);
  }

  /**
   * Marks the attempt's hashes approved. Returns false if the partial unique index rejects it:
   * another user got the same identifier approved concurrently (V6). The savepoint keeps the
   * surrounding transaction usable after the violation.
   */
  async approveHashes(
    manager: EntityManager,
    attemptId: string,
  ): Promise<boolean> {
    await manager.query(`SAVEPOINT approve_hashes`);
    try {
      await manager.query(
        `UPDATE identity_hashes SET is_approved = true WHERE verification_id = $1`,
        [attemptId],
      );
      await manager.query(`RELEASE SAVEPOINT approve_hashes`);
      return true;
    } catch (error) {
      await manager.query(`ROLLBACK TO SAVEPOINT approve_hashes`);
      if (isApprovedHashViolation(error)) return false;
      throw error;
    }
  }

  private async setOutcome(
    manager: EntityManager,
    attempt: AttemptRow,
    { outcome, declineReason, flagReason }: Evaluation,
  ): Promise<void> {
    // Final outcome: resume data is cleared (and the DB check requires it).
    await manager.query(
      `UPDATE identity_verifications
       SET outcome = $2, decline_reason = $3, completed_at = clock_timestamp(),
           verification_url = NULL, session_token = NULL
       WHERE id = $1`,
      [attempt.id, outcome, declineReason],
    );
    if (flagReason) await this.flag(manager, attempt, flagReason);
    this.logger.log(
      `Attempt ${attempt.id}: ${outcome}${declineReason ? ` (${declineReason})` : ''}` +
        `${flagReason ? `, flagged ${flagReason}` : ''}`,
    );
  }

  /** V15: Didit moved an approved attempt to declined. */
  private async reverseApproval(
    manager: EntityManager,
    attempt: AttemptRow,
  ): Promise<void> {
    await manager.query(
      `UPDATE identity_hashes SET is_approved = false WHERE verification_id = $1`,
      [attempt.id],
    );
    await this.flag(manager, attempt, 'APPROVAL_REVERSED');
  }

  /** Sets a staff flag, never overwriting one that is already there. */
  async flag(
    manager: EntityManager,
    attempt: { id: string },
    reason: string,
  ): Promise<void> {
    await manager.query(
      `UPDATE identity_verifications
       SET flagged_at = clock_timestamp(), flag_reason = $2
       WHERE id = $1 AND flagged_at IS NULL`,
      [attempt.id, reason],
    );
  }

  /**
   * Recomputes the user's status. If they are approved now, copy verified_at / full_name /
   * date_of_birth from their approved attempt (once). If not, clear verified_at but keep the
   * name and date of birth as history (V15).
   */
  async syncUser(manager: EntityManager, userId: string): Promise<void> {
    const status = await this.status.recomputeVerificationStatus(
      userId,
      manager,
    );
    if (status === VerificationStatus.Approved) {
      await manager.query(
        `UPDATE users u
         SET verified_at = clock_timestamp(), full_name = a.verified_name,
             date_of_birth = a.date_of_birth
         FROM (SELECT verified_name, date_of_birth FROM identity_verifications
               WHERE user_id = $1 AND outcome = 'approved'
               ORDER BY completed_at DESC LIMIT 1) a
         WHERE u.id = $1 AND u.verified_at IS NULL`,
        [userId],
      );
    } else {
      await manager.query(`UPDATE users SET verified_at = NULL WHERE id = $1`, [
        userId,
      ]);
    }
  }
}

function isApprovedHashViolation(error: unknown): boolean {
  const driver = (
    error as QueryFailedError & {
      driverError?: { code?: string; constraint?: string };
    }
  ).driverError;
  return (
    error instanceof QueryFailedError &&
    driver?.code === UNIQUE_VIOLATION &&
    driver.constraint === APPROVED_HASH_INDEX
  );
}
