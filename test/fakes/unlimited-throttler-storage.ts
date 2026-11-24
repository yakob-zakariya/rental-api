import type { ThrottlerStorage } from '@nestjs/throttler';

// The record type isn't exported by the package; take it from the interface.
type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

/**
 * A throttler store that never counts: every request is the first. For e2e files that send more
 * than the per-IP limit (100 a minute) from the one test IP; swap it in with
 * `b.overrideProvider(ThrottlerStorage).useValue(new UnlimitedThrottlerStorage())`. Files that
 * test the limits themselves keep the real store.
 */
export class UnlimitedThrottlerStorage implements ThrottlerStorage {
  increment(key: string, ttl: number): Promise<ThrottlerStorageRecord> {
    return Promise.resolve({
      totalHits: 1,
      timeToExpire: ttl,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  }
}
