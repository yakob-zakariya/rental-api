import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { PhotoStorage } from '../photos/photo-storage.js';
import { PropertyPhoto } from '../photos/property-photo.entity.js';
import { PublicCache } from '../photos/public-cache.js';

/**
 * A listing's photos are public only while it is live (P5, G5). Every move into live publishes
 * them inside its transaction, so a listing never goes live without its photos; every move out
 * of live unpublishes them after the commit. Moves into live so far: approve (T4.2), reopen
 * (T2.4); restore from stale comes with T6.3. Moves out: back to review after an edit or a photo
 * change, close, takedown; stale, expiry and ban come with T6.3 and T7.1. Anything a failed or
 * half-done step leaves public is removed by the reconciliation job (T4.4).
 */
@Injectable()
export class PublicPhotos {
  private readonly logger = new Logger(PublicPhotos.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: PhotoStorage,
    private readonly cache: PublicCache,
  ) {}

  /**
   * Inside the transaction that makes the listing live: copies every photo to the public bucket.
   * A storage failure aborts the transaction (503 STORAGE_UNAVAILABLE), and the caller retries.
   */
  async publish(manager: EntityManager, propertyId: string): Promise<void> {
    const photos = await manager.findBy(PropertyPhoto, { propertyId });
    try {
      for (const photo of photos) await this.storage.publish(photo.storageKey);
    } catch (error) {
      this.logger.error(
        `Publishing photos of property ${propertyId} failed: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException({ code: 'STORAGE_UNAVAILABLE' });
    }
  }

  /**
   * After the transaction that took the listing out of live: removes the public copies, and for a
   * staff takedown also asks the CDN to forget them. Best effort: a failure is logged and left for
   * the reconciliation job (T4.4).
   */
  async unpublish(
    propertyId: string,
    { purgeCdn = false } = {},
  ): Promise<void> {
    const photos = await this.dataSource.manager.findBy(PropertyPhoto, {
      propertyId,
    });
    for (const photo of photos) {
      try {
        await this.storage.unpublish(photo.storageKey);
      } catch (error) {
        this.logger.warn(
          `Unpublishing ${photo.storageKey} failed (the reconciliation job will retry): ${(error as Error).message}`,
        );
      }
    }
    if (purgeCdn)
      await this.cache
        .purge(photos.map((photo) => this.storage.publicUrl(photo.storageKey)))
        .catch((error: Error) =>
          this.logger.warn(`CDN purge failed: ${error.message}`),
        );
  }
}
