import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { PhotoStorage, type PublicObject } from '../photos/photo-storage.js';
import { PublicCache } from '../photos/public-cache.js';
import { ListingStatus } from './listings.enums.js';

const LOCK_KEY = 'public-photo-reconciliation';

/** The only keys we ever write to the public bucket (T3.2); anything else is left alone. */
const OUR_PREFIX = 'properties/';
const OUR_KEY = /^properties\/([0-9a-f-]{36})\//;

/**
 * Copies this young are left alone: an approval or a reopen publishes inside its transaction a
 * moment before the listing becomes live, and must not lose its fresh copies. Picked up next hour.
 */
export const RECONCILE_GRACE_MS = 15 * 60_000;

export interface ReconcileSummary {
  /** Another instance held the lock, so this pass did nothing. */
  skipped: boolean;
  checked: number;
  kept: number;
  removed: number;
  /** Younger than the grace period. */
  recent: number;
  /** Not under properties/: logged, never deleted. */
  foreign: number;
  errors: number;
}

interface Verdict {
  storage_key: string;
  thumbnail_key: string;
  listing_status: ListingStatus | null;
}

/**
 * Removes public copies of photos whose listing isn't live (spec R7, T4.4): what a best-effort
 * unpublish left behind (after a takedown the URLs were seen, so they aren't unguessable) or a
 * publish whose transaction then failed. Never touches the private bucket.
 *
 * Races with publishing (decided 2026-11-24): every path that publishes (approve, reopen) holds
 * the property's row lock while it does. For each property with suspicious copies, this job takes
 * that same lock, checks again under it, deletes, and commits. If the job holds the lock first, a
 * publishing transaction waits and publishes after the delete; if the publisher holds it first,
 * the job waits and then sees the listing live and keeps the copies. A delete can never land
 * after a publish of the same key. The job waits for nothing else while holding the lock, so it
 * can't deadlock.
 */
@Injectable()
export class PublicPhotoReconciliation {
  private readonly logger = new Logger('PublicPhotoReconciliation');

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: PhotoStorage,
    private readonly cache: PublicCache,
  ) {}

  /**
   * One pass. Only one instance runs it at a time (session advisory lock). `olderThan`: copies
   * written after it are skipped (default: now minus the grace period).
   */
  async runOnce({
    olderThan = new Date(Date.now() - RECONCILE_GRACE_MS),
  }: { olderThan?: Date } = {}): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = {
      skipped: false,
      checked: 0,
      kept: 0,
      removed: 0,
      recent: 0,
      foreign: 0,
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
        const removedUrls: string[] = [];
        for await (const page of this.storage.listPublic())
          await this.reconcilePage(page, olderThan, summary, removedUrls);
        if (summary.foreign > 0)
          this.logger.warn(
            `${summary.foreign} object(s) in the public bucket outside ${OUR_PREFIX}: left alone`,
          );
        if (removedUrls.length > 0)
          await this.cache
            .purge(removedUrls)
            .catch((error: Error) =>
              this.logger.warn(`CDN purge failed: ${error.message}`),
            );
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

  private async reconcilePage(
    page: PublicObject[],
    olderThan: Date,
    summary: ReconcileSummary,
    removedUrls: string[],
  ): Promise<void> {
    const byProperty = new Map<string, string[]>();
    const candidates: string[] = [];
    for (const object of page) {
      const match = OUR_KEY.exec(object.key);
      if (!match) {
        summary.foreign++;
        continue;
      }
      summary.checked++;
      if (object.lastModified > olderThan) {
        summary.recent++;
        continue;
      }
      candidates.push(object.key);
    }
    if (candidates.length === 0) return;

    // A first look without locks: most copies are fine and are kept here.
    const verdicts = await verdictsFor(this.dataSource.manager, candidates);
    for (const key of candidates) {
      if (verdicts.get(key) === ListingStatus.Live) {
        summary.kept++;
        continue;
      }
      const propertyId = OUR_KEY.exec(key)![1];
      byProperty.set(propertyId, [...(byProperty.get(propertyId) ?? []), key]);
    }

    // The suspicious ones: per property, lock, look again, delete, commit.
    for (const [propertyId, keys] of byProperty) {
      await this.dataSource.transaction(async (manager) => {
        await manager.query(
          `SELECT 1 FROM properties WHERE id = $1 FOR UPDATE`,
          [propertyId],
        );
        const now = await verdictsFor(manager, keys);
        for (const key of keys) {
          const status = now.get(key);
          if (status === ListingStatus.Live) {
            summary.kept++; // went live meanwhile: legitimately public now
            continue;
          }
          try {
            await this.storage.unpublish(key);
            summary.removed++;
            removedUrls.push(this.storage.publicUrl(key));
            this.logger.log(
              `Removed public copy ${key} (${status === undefined ? 'no photo record' : `listing ${status ?? 'gone'}`})`,
            );
          } catch (error) {
            summary.errors++;
            this.logger.warn(
              `Could not remove public copy ${key}: ${(error as Error).message}`,
            );
          }
        }
      });
    }
  }
}

/**
 * For each key with a photo record: the status of its property's current listing (live if any
 * listing of the property is live, else the latest one's status, null if none). A key may be a
 * photo's or its thumbnail's (T3.4): both get the same answer, so they're kept or removed as one
 * photo. Keys with no photo record are absent from the map.
 */
async function verdictsFor(
  manager: EntityManager,
  keys: string[],
): Promise<Map<string, ListingStatus | null>> {
  const rows = await manager.query<Verdict[]>(
    `SELECT ph.storage_key, ph.thumbnail_key,
       CASE WHEN EXISTS (SELECT 1 FROM listings l
                         WHERE l.property_id = ph.property_id AND l.status = 'live')
            THEN 'live'
            ELSE (SELECT l.status::text FROM listings l WHERE l.property_id = ph.property_id
                  ORDER BY l.created_at DESC LIMIT 1)
       END AS listing_status
     FROM property_photos ph
     WHERE ph.storage_key = ANY ($1) OR ph.thumbnail_key = ANY ($1)`,
    [keys],
  );
  return new Map(
    rows.flatMap((r) => [
      [r.storage_key, r.listing_status] as const,
      [r.thumbnail_key, r.listing_status] as const,
    ]),
  );
}
