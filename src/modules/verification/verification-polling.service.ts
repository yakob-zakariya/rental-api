import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DecisionService } from './decision/decision.service.js';
import { DiditApiError } from './didit/didit-api.error.js';
import { DiditClient } from './didit/didit-client.js';
import type { DiditDecision } from './didit/didit.types.js';
import { VerificationStatusService } from './verification-status.service.js';

/** Poll attempts that have been pending at least this long (spec flow step 5). */
export const POLL_AFTER_MINUTES = 10;
/** V16: expire attempts still pending this long after pending_since. */
export const EXPIRE_AFTER_HOURS = 24;
/** At most this many Didit calls per pass (Didit allows 600/min). */
export const POLL_BATCH_SIZE = 100;
/** provider_status recorded when Didit no longer knows the session. */
export const NOT_FOUND_STATUS = 'NOT_FOUND';

const LOCK_KEY = 'verification-polling';

export interface PollSummary {
  /** Another pass (instance) held the lock, so this one did nothing. */
  skipped: boolean;
  /** Attempts whose Didit decision was fetched and applied. */
  polled: number;
  /** Expired by V16 (24 h pending). */
  expired: number;
  /** Expired at once because Didit returned 404 for the session. */
  notFound: number;
  /** Didit or processing errors; those attempts are retried on the next pass. */
  errors: number;
}

/**
 * The polling fallback (spec flow step 5, V16): webhooks are a speed-up, not a single point of
 * failure. Didit is called outside any transaction; each result is applied through the same
 * DecisionService as the webhook, so a webhook that already won makes the poll a no-op.
 */
@Injectable()
export class VerificationPollingService {
  private readonly logger = new Logger('VerificationPolling');

  constructor(
    private readonly dataSource: DataSource,
    private readonly didit: DiditClient,
    private readonly decisions: DecisionService,
    private readonly status: VerificationStatusService,
  ) {}

  /** One pass. Only one instance runs it at a time (session-level advisory lock). */
  async runOnce(): Promise<PollSummary> {
    const summary: PollSummary = {
      skipped: false,
      polled: 0,
      expired: 0,
      notFound: 0,
      errors: 0,
    };
    // The lock belongs to one connection, so hold a dedicated one for the whole pass.
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      const [{ locked }] = (await runner.query(
        `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`,
        [LOCK_KEY],
      )) as { locked: boolean }[];
      if (!locked) return { ...summary, skipped: true };
      try {
        await this.pollDue(summary);
        await this.expireStale(summary);
      } finally {
        await runner.query(
          `SELECT pg_advisory_unlock(hashtextextended($1, 0))`,
          [LOCK_KEY],
        );
      }
      return summary;
    } finally {
      await runner.release();
    }
  }

  /** Pending ≥ 10 min, oldest first. Includes ones about to hit V16: they get a last poll. */
  private async pollDue(summary: PollSummary): Promise<void> {
    const due = await this.dataSource.query<
      { id: string; provider_session_id: string }[]
    >(
      `SELECT id, provider_session_id FROM identity_verifications
       WHERE outcome = 'pending'
         AND pending_since <= clock_timestamp() - make_interval(mins => $1)
       ORDER BY pending_since, id
       LIMIT $2`,
      [POLL_AFTER_MINUTES, POLL_BATCH_SIZE],
    );

    for (const attempt of due) {
      let decision: DiditDecision;
      try {
        decision = await this.didit.getDecision(attempt.provider_session_id);
      } catch (error) {
        if (error instanceof DiditApiError && error.kind === 'not_found') {
          // A dead session: expire now, so a resume (e.g. at the V3 limit) never hands the user
          // a broken link. Timeouts, 5xx and 429 are just retried on the next pass.
          if (
            await this.expireIfPending(attempt.id, {
              providerStatus: NOT_FOUND_STATUS,
            })
          ) {
            summary.notFound++;
          }
          continue;
        }
        summary.errors++;
        this.logger.warn(
          `Polling attempt ${attempt.id} failed: ${error instanceof DiditApiError ? error.kind : (error as Error).name}`,
        );
        continue;
      }

      try {
        await this.dataSource.transaction((manager) =>
          this.decisions.apply(
            {
              sessionId: attempt.provider_session_id,
              status: decision.status,
              idVerifications: decision.idVerifications,
            },
            manager,
          ),
        );
        summary.polled++;
      } catch (error) {
        summary.errors++;
        this.logger.error(
          `Applying the polled decision for ${attempt.id} failed: ${(error as Error).message}`,
        );
      }
    }
  }

  /** V16: still pending 24 h after pending_since (after its last poll). */
  private async expireStale(summary: PollSummary): Promise<void> {
    const stale = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM identity_verifications
       WHERE outcome = 'pending'
         AND pending_since <= clock_timestamp() - make_interval(hours => $1)
       ORDER BY pending_since, id
       LIMIT $2`,
      [EXPIRE_AFTER_HOURS, POLL_BATCH_SIZE],
    );
    for (const attempt of stale) {
      if (await this.expireIfPending(attempt.id, { staleOnly: true }))
        summary.expired++;
    }
  }

  /**
   * Locks the attempt and expires it if it is still pending (and, for V16, still stale): clears
   * URL and token, optionally records provider_status, and recomputes. Returns false if a
   * webhook or a reopen got there first.
   */
  private expireIfPending(
    attemptId: string,
    {
      providerStatus,
      staleOnly = false,
    }: { providerStatus?: string; staleOnly?: boolean },
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const [attempt] = await manager.query<
        { user_id: string; expirable: boolean }[]
      >(
        `SELECT user_id,
                outcome = 'pending' AND (NOT $2::boolean
                  OR pending_since <= clock_timestamp() - make_interval(hours => $3)) AS expirable
         FROM identity_verifications WHERE id = $1 FOR UPDATE`,
        [attemptId, staleOnly, EXPIRE_AFTER_HOURS],
      );
      if (!attempt?.expirable) return false;

      await manager.query(
        `UPDATE identity_verifications
         SET outcome = 'expired', completed_at = clock_timestamp(),
             verification_url = NULL, session_token = NULL,
             provider_status = coalesce($2, provider_status)
         WHERE id = $1`,
        [attemptId, providerStatus ?? null],
      );
      await this.status.recomputeVerificationStatus(attempt.user_id, manager);
      this.logger.log(
        `Attempt ${attemptId}: expired${providerStatus ? ` (${providerStatus})` : ''}`,
      );
      return true;
    });
  }
}
