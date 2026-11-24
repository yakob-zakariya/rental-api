import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ImageProcessor } from '../photos/image-processor.js';
import { PhotoStorage } from '../photos/photo-storage.js';
import { PropertyPhoto } from '../photos/property-photo.entity.js';
import type { MyListingDto } from './dto/listing.dto.js';
import {
  applyChangeEffects,
  lockCurrentListingOfProperty,
  propertyNotFound,
} from './listing-state.js';
import { ListingStatus } from './listings.enums.js';
import { ListingsService } from './listings.service.js';
import { PublicPhotos } from './public-photos.js';
import {
  MAX_PHOTOS_PER_PROPERTY,
  MIN_PHOTOS_TO_SUBMIT,
} from './photo-counter.js';

/**
 * Where deleting below 3 photos is refused (P4, decided 2026-11-24): listings in review or
 * public. A rejected or expired listing may go below 3, since resubmitting and reopening check
 * for 3 again (L2).
 */
const PHOTO_FLOOR_STATES: readonly ListingStatus[] = [
  ListingStatus.PendingReview,
  ListingStatus.Live,
  ListingStatus.Stale,
];

const photoNotFound = () => new NotFoundException({ code: 'PHOTO_NOT_FOUND' });

/**
 * A property's photos (spec P1, P2, P4): upload, delete, reorder. Every change follows L5 through
 * the same helper as other edits: version + 1; adding or deleting a photo of a live or stale
 * listing sends it back to review, of an expired one sets needs_review; reordering applies at
 * once (decided 2026-11-24). Rented and removed listings can't change (relist first).
 */
@Injectable()
export class PropertyPhotosService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly images: ImageProcessor,
    private readonly storage: PhotoStorage,
    private readonly listings: ListingsService,
    private readonly publicPhotos: PublicPhotos,
  ) {}

  /**
   * Adds a photo at the end. The file is re-encoded first (P2: no metadata survives), outside any
   * lock, then stored, then recorded; if recording fails, the stored file is removed again.
   * Errors: 400 from the re-encoding (PHOTO_TYPE_NOT_ALLOWED, PHOTO_TOO_MANY_PIXELS,
   * PHOTO_UNREADABLE), 404 PROPERTY_NOT_FOUND (L3), 409 TOO_MANY_PHOTOS (with `max`),
   * INVALID_LISTING_STATE.
   */
  async add(
    userId: string,
    propertyId: string,
    upload: Buffer,
  ): Promise<MyListingDto> {
    // Cheap ownership check first: nobody can make us decode files for someone else's property.
    await this.assertOwnProperty(userId, propertyId);
    const photo = await this.images.reencode(upload);

    const photoId = randomUUID();
    const storageKey = `properties/${propertyId}/${photoId}.jpg`;
    await this.storage.putPrivate(storageKey, photo.body, 'image/jpeg');

    try {
      const result = await this.dataSource.transaction(async (manager) => {
        const locked = await lockCurrentListingOfProperty(
          manager,
          userId,
          propertyId,
        );
        const count = await manager.countBy(PropertyPhoto, { propertyId });
        if (count >= MAX_PHOTOS_PER_PROPERTY)
          throw new ConflictException({
            code: 'TOO_MANY_PHOTOS',
            max: MAX_PHOTOS_PER_PROPERTY,
          });
        await manager.insert(PropertyPhoto, {
          id: photoId,
          propertyId,
          storageKey,
          width: photo.width,
          height: photo.height,
          bytes: photo.body.length,
          position: count,
        });
        const backToReview = await applyChangeEffects(manager, locked, userId, {
          needsReview: true,
        });
        return { id: locked.id, backToReview };
      });
      // A live listing went back to review: its photos stop being public (P5).
      if (result.backToReview) await this.publicPhotos.unpublish(propertyId);
      return this.listings.getMine(userId, result.id);
    } catch (error) {
      await this.listings.deleteFiles([storageKey]);
      throw error;
    }
  }

  /**
   * Deletes a photo; the ones after it move up. The file goes after the commit (and its public
   * copy, if any). Errors: 404 PROPERTY_NOT_FOUND / PHOTO_NOT_FOUND, 409 NOT_ENOUGH_PHOTOS (with
   * `min`; in review or public only), INVALID_LISTING_STATE.
   */
  async remove(
    userId: string,
    propertyId: string,
    photoId: string,
  ): Promise<MyListingDto> {
    const { listingId, storageKey, backToReview } =
      await this.dataSource.transaction(async (manager) => {
        const locked = await lockCurrentListingOfProperty(
          manager,
          userId,
          propertyId,
        );
        const photo = await manager.findOneBy(PropertyPhoto, {
          id: photoId,
          propertyId,
        });
        if (!photo) throw photoNotFound();

        const count = await manager.countBy(PropertyPhoto, { propertyId });
        if (
          PHOTO_FLOOR_STATES.includes(locked.status) &&
          count - 1 < MIN_PHOTOS_TO_SUBMIT
        )
          throw new ConflictException({
            code: 'NOT_ENOUGH_PHOTOS',
            min: MIN_PHOTOS_TO_SUBMIT,
          });

        await manager.delete(PropertyPhoto, photo.id);
        await manager.query(
          `UPDATE property_photos SET position = position - 1
           WHERE property_id = $1 AND position > $2`,
          [propertyId, photo.position],
        );
        const backToReview = await applyChangeEffects(manager, locked, userId, {
          needsReview: true,
        });
        return {
          listingId: locked.id,
          storageKey: photo.storageKey,
          backToReview,
        };
      });
    await this.listings.deleteFiles([storageKey]);
    if (backToReview) await this.publicPhotos.unpublish(propertyId);
    return this.listings.getMine(userId, listingId);
  }

  /**
   * Puts the photos in the given order (the first is the cover). `photoIds` must be exactly the
   * property's photos. The same order again changes nothing. Errors: 400 PHOTO_ORDER_MISMATCH, 404
   * PROPERTY_NOT_FOUND, 409 INVALID_LISTING_STATE.
   */
  async reorder(
    userId: string,
    propertyId: string,
    photoIds: string[],
  ): Promise<MyListingDto> {
    const listingId = await this.dataSource.transaction(async (manager) => {
      const locked = await lockCurrentListingOfProperty(
        manager,
        userId,
        propertyId,
      );
      const photos = await manager.find(PropertyPhoto, {
        where: { propertyId },
        order: { position: 'ASC' },
      });
      const current = photos.map((photo) => photo.id);
      const sameSet =
        photoIds.length === current.length &&
        [...photoIds].sort().join() === [...current].sort().join();
      if (!sameSet)
        throw new BadRequestException({ code: 'PHOTO_ORDER_MISMATCH' });
      if (photoIds.join() === current.join()) return locked.id;

      // One statement; the unique position is checked at commit (deferred), so swaps are fine.
      await manager.query(
        `UPDATE property_photos p SET position = o.ord - 1
         FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, ord)
         WHERE p.property_id = $1 AND p.id = o.id`,
        [propertyId, photoIds],
      );
      await applyChangeEffects(manager, locked, userId, {
        needsReview: false,
      });
      return locked.id;
    });
    return this.listings.getMine(userId, listingId);
  }

  private async assertOwnProperty(
    userId: string,
    propertyId: string,
  ): Promise<void> {
    const [row] = await this.dataSource.query<unknown[]>(
      `SELECT 1 FROM properties WHERE id = $1 AND lister_id = $2`,
      [propertyId, userId],
    );
    if (!row) throw propertyNotFound();
  }
}
