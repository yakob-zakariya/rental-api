import type { DataSource } from 'typeorm';
import { ADDIS_ABABA_TIME_ZONE, todayIn } from '../../src/common/dates.js';

/** YYYY-MM-DD, `days` after today in Addis Ababa (negative: before). */
export const addisDate = (days = 0): string => {
  const [y, m, d] = todayIn(ADDIS_ABABA_TIME_ZONE).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

export const MESKEL_SQUARE = { lat: 9.0102, lng: 38.7606 };

/** A seeded neighbourhood in Bole (the first by English name). */
export const boleNeighbourhoodId = async (db: DataSource): Promise<string> => {
  const [row] = await db.query<{ id: string }[]>(
    `SELECT n.id FROM neighbourhoods n JOIN sub_cities s ON s.id = n.sub_city_id
     WHERE s.name_en = 'Bole' ORDER BY n.name_en LIMIT 1`,
  );
  return row.id;
};

/** A body for POST /listings with every field filled in: nothing `missing`. */
export const fullListing = (neighbourhoodId: string) => ({
  neighbourhoodId,
  type: 'apartment',
  bedrooms: 2,
  bathrooms: 1,
  furnished: false,
  separateWaterMeter: true,
  separateElectricityMeter: false,
  sizeM2: 85,
  floor: 3,
  amenities: ['guard', 'parking'],
  description: 'Bright two-bedroom flat, five minutes from the main road.',
  location: MESKEL_SQUARE,
  landmark: 'Blue gate behind the pharmacy',
  listerRelation: 'owner',
  monthlyRentBirr: 25000,
  advanceMonths: 2,
  negotiable: true,
  availableFrom: addisDate(30),
});
