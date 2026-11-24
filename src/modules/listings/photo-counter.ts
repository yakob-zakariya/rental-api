import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/** Photos a listing needs before it can be submitted (L2, P2-4). */
export const MIN_PHOTOS_TO_SUBMIT = 3;

/**
 * How many photos a property has, for the submit checks (L2). Asked inside the caller's
 * transaction. An abstract class so Nest can inject it by type and tests can swap it.
 */
export abstract class PhotoCounter {
  abstract count(manager: EntityManager, propertyId: string): Promise<number>;
}

/**
 * Until photos exist (T3.2 replaces this with a count of property_photos): no property has any,
 * so outside the tests nothing can be submitted, even by accident (decided 2026-11-23).
 */
@Injectable()
export class NoPhotosYet extends PhotoCounter {
  count(): Promise<number> {
    return Promise.resolve(0);
  }
}
