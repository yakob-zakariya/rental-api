import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, type EntityManager } from 'typeorm';
import { isQuietTime } from '../../../common/dates.js';
import { durationToSeconds } from '../../../common/duration.js';
import type { EnvironmentVariables } from '../../../config/env.validation.js';
import type { PushNotice } from '../../push/push-messages.js';
import { PushService } from '../../push/push.service.js';
import { lockListingForStaff, recordStatusChange } from '../listing-state.js';
import { Listing } from '../listing.entity.js';
import { ActorType, ListingStatus, PropertyType } from '../listings.enums.js';
import { PublicPhotos } from '../public-photos.js';
import {
  AvailabilityCheck,
  CheckOutcome,
  PushResult,
} from './availability-check.entity.js';

const LOCK_KEY = 'listings:freshness';
/** Listings handled per step and pass; the next pass (15 minutes later) takes the rest. */
const BATCH = 500;

export interface FreshnessSummary {
  skipped: boolean;
  /** Quiet hours: no new checks and no stale notices this pass. */
  quiet: boolean;
  stale: number;
  expired: number;
  checks: number;
  staleNotices: number;
  errors: number;
}

/**
 * The weekly freshness pass (spec F1–F6; T6.3), every 15 minutes (FreshnessJob). The windows use
 * the database clock. Each listing is handled in its own transaction, under its locks (the lister
 * first, then the listing, as everywhere), and its condition is checked again once locked, so two
 * passes at once, or a pass and the lister's answer, can't both act; a session advisory lock also
 * keeps passes from overlapping.
 *
 * Quiet hours (decided 2026-11-24): between PUSH_QUIET_START and PUSH_QUIET_END in Addis Ababa no
 * new check is made and no stale notice is sent; a check due at night waits until morning, and its
 * answer window starts when it is actually sent. Going stale and expiring happen at any hour.
 */
@Injectable()
export class FreshnessService {
  private readonly logger = new Logger('Freshness');
  private readonly intervalSeconds: number;
  private readonly answerWindowSeconds: number;
  private readonly staleToExpiredSeconds: number;
  private readonly quietStart: string;
  private readonly quietEnd: string;

  constructor(
    private readonly dataSource: DataSource,
    private readonly publicPhotos: PublicPhotos,
    private readonly push: PushService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    const seconds = (
      key:
        | 'LISTING_CHECK_INTERVAL'
        | 'LISTING_CHECK_ANSWER_WINDOW'
        | 'LISTING_STALE_TO_EXPIRED',
    ) => durationToSeconds(config.get(key, { infer: true }));
    this.intervalSeconds = seconds('LISTING_CHECK_INTERVAL');
    this.answerWindowSeconds = seconds('LISTING_CHECK_ANSWER_WINDOW');
    this.staleToExpiredSeconds = seconds('LISTING_STALE_TO_EXPIRED');
    this.quietStart = config.get('PUSH_QUIET_START', { infer: true });
    this.quietEnd = config.get('PUSH_QUIET_END', { infer: true });
  }

  /**
   * One pass. `now` only decides quiet hours (tests set it; otherwise the database's time);
   * every window is measured with the database clock.
   */
  async runOnce({ now }: { now?: Date } = {}): Promise<FreshnessSummary> {
    const summary: FreshnessSummary = {
      skipped: false,
      quiet: false,
      stale: 0,
      expired: 0,
      checks: 0,
      staleNotices: 0,
      errors: 0,
    };
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      const [{ locked }] = (await runner.query(
        `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`,
        [LOCK_KEY],
      )) as { locked: boolean }[];
      if (!locked) return { ...summary, skipped: true };
      try {
        const at =
          now ??
          ((await runner.query(`SELECT now() AS now`)) as { now: Date }[])[0]
            .now;
        summary.quiet = isQuietTime(at, this.quietStart, this.quietEnd);

        await this.each(summary, await this.dueForStale(), async (id) => {
          if (await this.markStale(id)) summary.stale++;
        });
        await this.each(summary, await this.dueForExpiry(), async (id) => {
          if (await this.expire(id)) summary.expired++;
        });
        if (!summary.quiet) {
          // Stale notices first: a listing marked stale above gets its notice in the same pass.
          await this.each(
            summary,
            await this.dueForStaleNotice(),
            async (id) => {
              if (await this.sendStaleNotice(id)) summary.staleNotices++;
            },
          );
          await this.each(summary, await this.dueForCheck(), async (id) => {
            if (await this.sendCheck(id)) summary.checks++;
          });
        }
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

  /** One failing listing is logged and counted; the others still go ahead. */
  private async each(
    summary: FreshnessSummary,
    ids: string[],
    handle: (id: string) => Promise<void>,
  ): Promise<void> {
    for (const id of ids) {
      try {
        await handle(id);
      } catch (error) {
        summary.errors++;
        this.logger.error(`Listing ${id}: ${(error as Error).message}`);
      }
    }
  }

  // --- F3: no answer in the window → stale ---

  private async dueForStale(): Promise<string[]> {
    const rows = await this.dataSource.query<{ id: string }[]>(
      `SELECT c.listing_id AS id FROM availability_checks c
       JOIN listings l ON l.id = c.listing_id
       WHERE c.closed_at IS NULL AND l.status = 'live'
         AND c.sent_at <= now() - make_interval(secs => $1)
       ORDER BY c.sent_at LIMIT $2`,
      [this.answerWindowSeconds, BATCH],
    );
    return rows.map((r) => r.id);
  }

  private async markStale(listingId: string): Promise<boolean> {
    const propertyId = await this.dataSource.transaction(async (manager) => {
      const locked = await lockListingForStaff(manager, listingId);
      if (locked.status !== ListingStatus.Live) return null;
      // Checked again under the lock: the lister may have answered in the meantime.
      const [check] = await manager.query<{ id: string }[]>(
        `SELECT id FROM availability_checks
         WHERE listing_id = $1 AND closed_at IS NULL
           AND sent_at <= now() - make_interval(secs => $2)
         FOR UPDATE`,
        [listingId, this.answerWindowSeconds],
      );
      if (!check) return null;
      // Closed first, so the trigger doesn't record it as cancelled.
      await manager.update(AvailabilityCheck, check.id, {
        closedAt: () => 'now()',
        outcome: CheckOutcome.NoAnswer,
      });
      await this.moveTo(
        manager,
        listingId,
        ListingStatus.Live,
        ListingStatus.Stale,
        {
          staleAt: () => 'now()',
        },
      );
      return locked.property_id;
    });
    if (!propertyId) return false;
    // Hidden from browse: its photos are public only while live (R7).
    await this.publicPhotos.unpublish(propertyId);
    return true;
  }

  // --- F5: stale for 30 days → expired ---

  private async dueForExpiry(): Promise<string[]> {
    const rows = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM listings
       WHERE status = 'stale' AND stale_at <= now() - make_interval(secs => $1)
       ORDER BY stale_at LIMIT $2`,
      [this.staleToExpiredSeconds, BATCH],
    );
    return rows.map((r) => r.id);
  }

  private async expire(listingId: string): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      await lockListingForStaff(manager, listingId);
      const [due] = await manager.query<unknown[]>(
        `SELECT 1 FROM listings
         WHERE id = $1 AND status = 'stale' AND stale_at <= now() - make_interval(secs => $2)`,
        [listingId, this.staleToExpiredSeconds],
      );
      if (!due) return false;
      // Its photos were made private when it went stale.
      await this.moveTo(
        manager,
        listingId,
        ListingStatus.Stale,
        ListingStatus.Expired,
        {
          expiredAt: () => 'now()',
        },
      );
      return true;
    });
  }

  // --- The stale notice (decided 2026-11-24) ---

  /** Stale listings whose latest check ended unanswered and hasn't had its notice yet. */
  private async dueForStaleNotice(): Promise<string[]> {
    const rows = await this.dataSource.query<{ id: string }[]>(
      `SELECT latest.id FROM (
         SELECT DISTINCT ON (c.listing_id) c.id, c.outcome, c.stale_pushed_at
         FROM availability_checks c JOIN listings l ON l.id = c.listing_id
         WHERE l.status = 'stale'
         ORDER BY c.listing_id, c.sent_at DESC
       ) latest
       WHERE latest.outcome = 'no_answer' AND latest.stale_pushed_at IS NULL
       LIMIT $1`,
      [BATCH],
    );
    return rows.map((r) => r.id);
  }

  /** `checkId`: claimed (stale_pushed_at) before sending, so a second pass never sends it again. */
  private async sendStaleNotice(checkId: string): Promise<boolean> {
    const listingId = await this.dataSource.transaction(async (manager) => {
      const [claimed] = await manager.query<{ listing_id: string }[]>(
        `SELECT c.listing_id FROM availability_checks c
         JOIN listings l ON l.id = c.listing_id
         WHERE c.id = $1 AND c.stale_pushed_at IS NULL AND l.status = 'stale'
         FOR UPDATE OF c`,
        [checkId],
      );
      if (!claimed) return null;
      await manager.update(AvailabilityCheck, checkId, {
        stalePushedAt: () => 'now()',
      });
      return claimed.listing_id;
    });
    if (!listingId) return false;
    const result = await this.notify(listingId, 'listing_stale');
    await this.dataSource.manager.update(AvailabilityCheck, checkId, {
      stalePushResult: result,
    });
    return true;
  }

  // --- F1: the weekly check ---

  private async dueForCheck(): Promise<string[]> {
    const rows = await this.dataSource.query<{ id: string }[]>(
      `SELECT l.id FROM listings l
       WHERE ${checkDue('$1')}
       ORDER BY GREATEST(l.published_at, l.last_confirmed_at) LIMIT $2`,
      [this.intervalSeconds, BATCH],
    );
    return rows.map((r) => r.id);
  }

  private async sendCheck(listingId: string): Promise<boolean> {
    const checkId = await this.dataSource.transaction(async (manager) => {
      await lockListingForStaff(manager, listingId);
      const [due] = await manager.query<unknown[]>(
        `SELECT 1 FROM listings l WHERE l.id = $1 AND ${checkDue('$2')}`,
        [listingId, this.intervalSeconds],
      );
      if (!due) return null;
      const { identifiers } = await manager.insert(AvailabilityCheck, {
        listingId,
      });
      return identifiers[0].id as string;
    });
    if (!checkId) return false;
    // After the commit: the answer window has started whatever happens to the push (F3).
    const result = await this.notify(listingId, 'weekly_check');
    await this.dataSource.manager.update(AvailabilityCheck, checkId, {
      pushResult: result,
    });
    return true;
  }

  // --- Shared ---

  private async moveTo(
    manager: EntityManager,
    listingId: string,
    from: ListingStatus,
    to: ListingStatus,
    fields: Parameters<EntityManager['update']>[2],
  ): Promise<void> {
    await manager.update(Listing, listingId, {
      status: to,
      ...(fields as object),
    });
    await recordStatusChange(manager, listingId, from, to, null, {
      actorType: ActorType.System,
    });
  }

  /** N4: the notice is built only from the listing's id, type and neighbourhood. */
  private async notify(
    listingId: string,
    kind: 'weekly_check' | 'listing_stale',
  ): Promise<PushResult> {
    const [row] = await this.dataSource.query<
      {
        lister_id: string;
        type: PropertyType;
        name_en: string;
        name_am: string;
      }[]
    >(
      `SELECT p.lister_id, p.type, n.name_en, n.name_am
       FROM listings l JOIN properties p ON p.id = l.property_id
       JOIN neighbourhoods n ON n.id = p.neighbourhood_id
       WHERE l.id = $1`,
      [listingId],
    );
    const notice: PushNotice = {
      kind,
      listingId,
      type: row.type,
      neighbourhood: { nameEn: row.name_en, nameAm: row.name_am },
    };
    // NotifyResult and PushResult name the same three outcomes.
    return (await this.push.notify(row.lister_id, notice)) as PushResult;
  }
}

/**
 * F1: live, the interval passed since publishing or the last confirmation (approve, answer,
 * restore, reopen), and no open check. `interval`: the query parameter holding it, in seconds.
 */
const checkDue = (interval: string) => `l.status = 'live'
  AND GREATEST(l.published_at, l.last_confirmed_at) <= now() - make_interval(secs => ${interval})
  AND NOT EXISTS (SELECT 1 FROM availability_checks c WHERE c.listing_id = l.id AND c.closed_at IS NULL)`;
