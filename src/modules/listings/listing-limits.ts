import { BadRequestException } from '@nestjs/common';

/**
 * Upper limits on listing fields (decided 2026-11-23): generous, so no real home is refused, and
 * they keep nonsense out before review. Change them here; nothing else needs to change (the
 * database doesn't repeat them). Over a limit: 400 with the code below and `max`.
 */
export const LISTING_LIMITS = {
  bedrooms: { max: 20, code: 'BEDROOMS_ABOVE_LIMIT' },
  bathrooms: { max: 20, code: 'BATHROOMS_ABOVE_LIMIT' },
  floor: { max: 60, code: 'FLOOR_ABOVE_LIMIT' },
  sizeM2: { max: 5000, code: 'SIZE_ABOVE_LIMIT' },
  monthlyRentBirr: { max: 2_000_000, code: 'RENT_ABOVE_LIMIT' },
} as const;

export type LimitedField = keyof typeof LISTING_LIMITS;

/** Throws for the first field (in the order above) that is over its limit. */
export function assertWithinLimits(
  fields: Partial<Record<LimitedField, number | null>>,
): void {
  for (const [field, { max, code }] of Object.entries(LISTING_LIMITS)) {
    const value = fields[field as LimitedField];
    if (typeof value === 'number' && value > max)
      throw new BadRequestException({ code, max });
  }
}

/** Text lengths: these match the database columns, so changing one needs a migration too. */
export const TEXT_LIMITS = {
  description: 2000,
  landmark: 200,
  unlistedNeighbourhoodName: 100,
} as const;
