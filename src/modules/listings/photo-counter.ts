import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { PropertyPhoto } from '../photos/property-photo.entity.js';

/** Photos a listing needs before it can be submitted or reopened (L2, P2-4). */
export const MIN_PHOTOS_TO_SUBMIT = 3;

/** Photos a property may have (P1, P2-4). */
export const MAX_PHOTOS_PER_PROPERTY = 12;

/**
 * How many photos a property has, for the submit and reopen checks (L2), asked inside the
 * caller's transaction. An abstract class so tests that aren't about photos can swap it instead of
 * uploading three photos each time.
 */
export abstract class PhotoCounter {
  abstract count(manager: EntityManager, propertyId: string): Promise<number>;
}

/** The real count: the property's rows in property_photos (T3.2). */
@Injectable()
export class DbPhotoCounter extends PhotoCounter {
  count(manager: EntityManager, propertyId: string): Promise<number> {
    return manager.countBy(PropertyPhoto, { propertyId });
  }
}
