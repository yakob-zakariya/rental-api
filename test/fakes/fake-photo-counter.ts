import { PhotoCounter } from '../../src/modules/listings/photo-counter.js';

/**
 * Stands in for photos until Step 3 (T2.3): every property has `photos` photos, unless a test
 * sets a count for one property. Swap it in with `b.overrideProvider(PhotoCounter).useValue(fake)`;
 * call `reset()` between tests.
 */
export class FakePhotoCounter extends PhotoCounter {
  photos = 3;
  private readonly byProperty = new Map<string, number>();

  count(_manager: unknown, propertyId: string): Promise<number> {
    return Promise.resolve(this.byProperty.get(propertyId) ?? this.photos);
  }

  set(propertyId: string, count: number): void {
    this.byProperty.set(propertyId, count);
  }

  reset(): void {
    this.photos = 3;
    this.byProperty.clear();
  }
}
