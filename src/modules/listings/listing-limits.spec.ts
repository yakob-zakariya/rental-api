import { BadRequestException } from '@nestjs/common';
import { assertWithinLimits, LISTING_LIMITS } from './listing-limits.js';

describe('assertWithinLimits (decided 2026-11-23)', () => {
  it('has the agreed limits', () => {
    expect(
      Object.fromEntries(
        Object.entries(LISTING_LIMITS).map(([field, { max }]) => [field, max]),
      ),
    ).toEqual({
      bedrooms: 20,
      bathrooms: 20,
      floor: 60,
      sizeM2: 5000,
      monthlyRentBirr: 2_000_000,
    });
  });

  it('accepts every field at its limit, and empty or missing fields', () => {
    expect(() =>
      assertWithinLimits({
        bedrooms: 20,
        bathrooms: 20,
        floor: 60,
        sizeM2: 5000,
        monthlyRentBirr: 2_000_000,
      }),
    ).not.toThrow();
    expect(() => assertWithinLimits({ bedrooms: null })).not.toThrow();
    expect(() => assertWithinLimits({})).not.toThrow();
  });

  it.each(Object.entries(LISTING_LIMITS))(
    '%s one over the limit: 400 with its own code and the limit',
    (field, { max, code }) => {
      const error = (() => {
        try {
          assertWithinLimits({ [field]: max + 1 });
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual({
        code,
        max,
      });
    },
  );
});
