import type { Listing } from './listing.entity.js';
import type { Property } from './property.entity.js';

/**
 * What must be filled in before a listing can be submitted (L2, decided 2026-11-23): everything
 * except size, floor, amenities and the typed neighbourhood name. Photos are counted separately
 * (NOT_ENOUGH_PHOTOS). Names are the API's field names, in the order the app's form asks.
 */
export const REQUIRED_PROPERTY_FIELDS = [
  'neighbourhoodId',
  'type',
  'bedrooms',
  'bathrooms',
  'furnished',
  'separateWaterMeter',
  'separateElectricityMeter',
  'description',
  'location',
  'landmark',
  'listerRelation',
] as const satisfies readonly (keyof Property)[];

export const REQUIRED_LISTING_FIELDS = [
  'monthlyRentBirr',
  'advanceMonths',
  'negotiable',
  'availableFrom',
] as const satisfies readonly (keyof Listing)[];

/**
 * The required fields that are still empty. Used for `missing` on every listing response and,
 * from T2.3, for 400 LISTING_INCOMPLETE, so the two always agree. The property must be loaded
 * with `location` and `landmark` (select: false): left out, they'd look empty.
 */
export function missingFields(
  listing: Pick<Listing, (typeof REQUIRED_LISTING_FIELDS)[number]>,
  property: Pick<Property, (typeof REQUIRED_PROPERTY_FIELDS)[number]>,
): string[] {
  if (property.location === undefined || property.landmark === undefined)
    throw new Error('missingFields needs location and landmark loaded');
  return [
    ...REQUIRED_PROPERTY_FIELDS.filter((field) => property[field] === null),
    ...REQUIRED_LISTING_FIELDS.filter((field) => listing[field] === null),
  ];
}
