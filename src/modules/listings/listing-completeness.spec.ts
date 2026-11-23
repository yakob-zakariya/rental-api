import type { Point } from 'typeorm';
import { missingFields } from './listing-completeness.js';
import { ListerRelation, PropertyType } from './listings.enums.js';

const point: Point = { type: 'Point', coordinates: [38.7606, 9.0102] };

const complete = {
  listing: {
    monthlyRentBirr: 25000,
    advanceMonths: 2,
    negotiable: false,
    availableFrom: '2026-12-01',
  },
  property: {
    neighbourhoodId: 'n',
    type: PropertyType.Apartment,
    bedrooms: 0,
    bathrooms: 0,
    furnished: false,
    separateWaterMeter: false,
    separateElectricityMeter: false,
    description: 'A flat',
    location: point,
    landmark: 'Blue gate',
    listerRelation: ListerRelation.Owner,
  },
};

describe('missingFields (L2, decided 2026-11-23)', () => {
  it('nothing missing when everything required is filled; 0 and false count as filled', () => {
    expect(missingFields(complete.listing, complete.property)).toEqual([]);
  });

  it('lists empty required fields in the form order, property first', () => {
    expect(
      missingFields(
        { ...complete.listing, monthlyRentBirr: null },
        { ...complete.property, landmark: null, type: null },
      ),
    ).toEqual(['type', 'landmark', 'monthlyRentBirr']);
  });

  it('refuses to guess when location or landmark were not loaded (select: false)', () => {
    const { location: _location, ...withoutLocation } = complete.property;
    expect(() =>
      missingFields(
        complete.listing,
        withoutLocation as unknown as typeof complete.property,
      ),
    ).toThrow('needs location and landmark loaded');
  });
});
