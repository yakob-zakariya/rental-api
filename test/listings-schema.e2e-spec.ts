import { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import { DataSource, type Point, QueryFailedError } from 'typeorm';
import { ListingHistory } from '../src/modules/listings/listing-history.entity.js';
import { Listing } from '../src/modules/listings/listing.entity.js';
import {
  ActorType,
  Amenity,
  CloseReason,
  ListerRelation,
  ListingHistoryEvent,
  ListingStatus as S,
  OPEN_LISTING_STATUSES,
  PropertyType,
  StaffReasonCode,
} from '../src/modules/listings/listings.enums.js';
import { Property } from '../src/modules/listings/property.entity.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';

// The database rules behind properties, listings and listing_history (spec section 2, T2.1).
// Rows are written straight to the database; the endpoints that write them come in T2.2 onward.

const violates = (constraint: string) => ({ driverError: { constraint } });
const point = (lat: number, lng: number): Point => ({
  type: 'Point',
  coordinates: [lng, lat],
});

/** The listing's own fields, all filled in: what every state past draft needs. */
const COMPLETE = {
  monthlyRentBirr: 15000,
  advanceMonths: 2,
  negotiable: false,
  availableFrom: '2026-12-01',
};

/** A valid listing row in the given state. */
const inState = (status: S): Partial<Listing> => {
  if (status === S.Draft) return { status };
  if (status === S.Rented)
    return {
      ...COMPLETE,
      status,
      closeReason: CloseReason.RentedElsewhere,
      closedAt: new Date(),
    };
  if (status === S.Removed)
    return {
      ...COMPLETE,
      status,
      closeReason: CloseReason.NoLongerForRent,
      closedAt: new Date(),
    };
  return { ...COMPLETE, status };
};

describe('listings: the tables (e2e, spec section 2)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let phones = 0;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DataSource);
  });

  afterEach(async () => {
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const makeUser = async (): Promise<string> => {
    phones += 1;
    const [row] = await db.query<{ id: string }[]>(
      `INSERT INTO users (phone) VALUES ($1) RETURNING id`,
      [`+2519${String(phones).padStart(8, '0')}`],
    );
    return row.id;
  };

  const makeProperty = async (
    fields: Partial<Property> = {},
  ): Promise<string> => {
    const { identifiers } = await db.getRepository(Property).insert({
      listerId: await makeUser(),
      ...fields,
    });
    return identifiers[0].id as string;
  };

  const makeListing = async (
    propertyId: string,
    fields: Partial<Listing> = {},
  ): Promise<string> => {
    const { identifiers } = await db
      .getRepository(Listing)
      .insert({ propertyId, ...fields });
    return identifiers[0].id as string;
  };

  const addHistory = async (fields: Partial<ListingHistory>) => {
    const listingId = await makeListing(await makeProperty());
    return db.getRepository(ListingHistory).insert({
      listingId,
      event: ListingHistoryEvent.Status,
      newStatus: S.Draft,
      actorType: ActorType.User,
      actorId: await makeUser(),
      ...fields,
    });
  };

  describe('Postgres enums match the TypeScript ones', () => {
    it.each([
      ['property_type', PropertyType],
      ['amenity', Amenity],
      ['lister_relation', ListerRelation],
      ['listing_status', S],
      ['listing_close_reason', CloseReason],
      ['staff_reason_code', StaffReasonCode],
      ['listing_history_event', ListingHistoryEvent],
      ['actor_type', ActorType],
    ])('%s', async (type, values) => {
      const [row] = await db.query<{ v: string[] }[]>(
        `SELECT enum_range(NULL::${type})::text[] AS v`,
      );
      expect(row.v).toEqual(Object.values(values));
    });
  });

  describe('drafts may be half-filled (decided 2026-11-23)', () => {
    it('a property with nothing but its lister, and a draft with nothing but its property', async () => {
      const propertyId = await makeProperty();
      const listingId = await makeListing(propertyId);

      const listing = await db
        .getRepository(Listing)
        .findOneByOrFail({ id: listingId });
      expect(listing).toMatchObject({
        status: S.Draft,
        monthlyRentBirr: null,
        negotiable: null,
        needsReview: false,
        version: 1,
      });
      const property = await db
        .getRepository(Property)
        .findOneByOrFail({ id: propertyId });
      // Null on a yes/no field means "not answered yet", never "no".
      expect(property).toMatchObject({ furnished: null, amenities: [] });
    });

    it.each([
      'monthlyRentBirr',
      'advanceMonths',
      'negotiable',
      'availableFrom',
    ] as const)('past draft, the listing needs %s', async (field) => {
      const propertyId = await makeProperty();

      await expect(
        makeListing(propertyId, {
          ...COMPLETE,
          [field]: null,
          status: S.PendingReview,
        }),
      ).rejects.toMatchObject(violates('CHK_listings_complete_unless_draft'));
    });
  });

  describe('L10: at most one open listing per property', () => {
    it.each(OPEN_LISTING_STATUSES)(
      'a property with a %s listing gets no second open one',
      async (status) => {
        const propertyId = await makeProperty();
        await makeListing(propertyId, inState(status));

        await expect(makeListing(propertyId)).rejects.toMatchObject(
          violates('UQ_listings_one_open_per_property'),
        );
      },
    );

    it.each([S.Rented, S.Removed, S.Rejected])(
      'after a %s listing, the property can be listed again; closed ones pile up as history',
      async (status) => {
        const propertyId = await makeProperty();
        await makeListing(propertyId, inState(status));
        await makeListing(propertyId, inState(status));

        await expect(makeListing(propertyId)).resolves.toBeDefined();
      },
    );

    it('other properties are not affected', async () => {
      await makeListing(await makeProperty());

      await expect(makeListing(await makeProperty())).resolves.toBeDefined();
    });
  });

  describe('property values', () => {
    it.each([
      ['bedrooms', { bedrooms: -1 }, 'CHK_properties_bedrooms'],
      ['bathrooms', { bathrooms: -1 }, 'CHK_properties_bathrooms'],
      ['size 0', { sizeM2: 0 }, 'CHK_properties_size_m2'],
      ['floor', { floor: -1 }, 'CHK_properties_floor'],
      [
        'an empty description',
        { description: '' },
        'CHK_properties_description',
      ],
      [
        'a blank description',
        { description: '  \n ' },
        'CHK_properties_description',
      ],
      [
        'a description over 2000 characters',
        { description: 'ሀ'.repeat(2001) },
        'CHK_properties_description',
      ],
      [
        'a blank unlisted neighbourhood name',
        { unlistedNeighbourhoodName: '  ' },
        'CHK_properties_unlisted_neighbourhood_name',
      ],
      ['a blank landmark', { landmark: ' ' }, 'CHK_properties_landmark'],
      [
        'an exact point without its approximate one',
        { location: point(9.0102, 38.7606) },
        'CHK_properties_location_pair',
      ],
      [
        'an approximate point without the exact one',
        { approxLocation: point(9.0102, 38.7606) },
        'CHK_properties_location_pair',
      ],
    ] as [string, Partial<Property>, string][])(
      'refuses %s',
      async (_name, fields, constraint) => {
        await expect(makeProperty(fields)).rejects.toMatchObject(
          violates(constraint),
        );
      },
    );

    it('accepts the edge values: 0 bedrooms, 0 bathrooms (shared), ground floor, 2000 characters', async () => {
      await expect(
        makeProperty({
          bedrooms: 0,
          bathrooms: 0,
          floor: 0,
          sizeM2: 1,
          description: 'ሀ'.repeat(2000),
        }),
      ).resolves.toBeDefined();
    });

    it('a lister and a neighbourhood must exist', async () => {
      await expect(
        db.getRepository(Property).insert({
          listerId: '00000000-0000-4000-8000-000000000000',
        }),
      ).rejects.toMatchObject(violates('FK_properties_lister_id'));
      await expect(
        makeProperty({
          neighbourhoodId: '00000000-0000-4000-8000-000000000000',
        }),
      ).rejects.toMatchObject(violates('FK_properties_neighbourhood_id'));
    });
  });

  describe('listing values', () => {
    it.each([
      ['rent 0', { monthlyRentBirr: 0 }, 'CHK_listings_monthly_rent_birr'],
      [
        'a negative rent',
        { monthlyRentBirr: -500 },
        'CHK_listings_monthly_rent_birr',
      ],
      ['0 advance months', { advanceMonths: 0 }, 'CHK_listings_advance_months'],
      [
        '13 advance months',
        { advanceMonths: 13 },
        'CHK_listings_advance_months',
      ],
      ['version 0', { version: 0 }, 'CHK_listings_version'],
      ['a blank lister note', { listerNote: ' ' }, 'CHK_listings_lister_note'],
    ] as [string, Partial<Listing>, string][])(
      'refuses %s',
      async (_name, fields, constraint) => {
        await expect(
          makeListing(await makeProperty(), fields),
        ).rejects.toMatchObject(violates(constraint));
      },
    );

    it('accepts 1 and 12 advance months', async () => {
      await makeListing(await makeProperty(), { advanceMonths: 1 });
      await expect(
        makeListing(await makeProperty(), { advanceMonths: 12 }),
      ).resolves.toBeDefined();
    });

    it('refuses a rent that is not a whole number of birr (hard rule 6)', async () => {
      await expect(
        makeListing(await makeProperty(), { monthlyRentBirr: 1500.5 }),
      ).rejects.toBeInstanceOf(QueryFailedError);
    });
  });

  describe('closing (L12, R5)', () => {
    const closed = (status: S, closeReason: CloseReason | null) => ({
      ...COMPLETE,
      status,
      closeReason,
      closedAt: new Date(),
    });

    it.each([
      [S.Rented, CloseReason.RentedInApp],
      [S.Rented, CloseReason.RentedElsewhere],
      [S.Removed, CloseReason.NoLongerForRent],
      [S.Removed, CloseReason.StaffTakedown],
    ])('%s with %s is accepted', async (status, reason) => {
      await expect(
        makeListing(await makeProperty(), closed(status, reason)),
      ).resolves.toBeDefined();
    });

    it.each([
      ['rented without a reason', closed(S.Rented, null)],
      ['removed without a reason', closed(S.Removed, null)],
      [
        'rented with no_longer_for_rent',
        closed(S.Rented, CloseReason.NoLongerForRent),
      ],
      [
        'rented with staff_takedown',
        closed(S.Rented, CloseReason.StaffTakedown),
      ],
      [
        'removed with rented_in_app',
        closed(S.Removed, CloseReason.RentedInApp),
      ],
      [
        'an open listing with a reason',
        { ...COMPLETE, status: S.Live, closeReason: CloseReason.RentedInApp },
      ],
    ] as [string, Partial<Listing>][])('refuses %s', async (_name, fields) => {
      await expect(
        makeListing(await makeProperty(), fields),
      ).rejects.toMatchObject(violates('CHK_listings_close_reason'));
    });

    it.each([
      [
        'a closed listing without closed_at',
        { ...closed(S.Rented, CloseReason.RentedInApp), closedAt: null },
      ],
      [
        'an open listing with closed_at',
        { ...COMPLETE, status: S.Live, closedAt: new Date() },
      ],
    ] as [string, Partial<Listing>][])('refuses %s', async (_name, fields) => {
      await expect(
        makeListing(await makeProperty(), fields),
      ).rejects.toMatchObject(violates('CHK_listings_closed_at'));
    });
  });

  describe('listing_history', () => {
    it('accepts a valid row for each event', async () => {
      await addHistory({ oldStatus: null, newStatus: S.Draft });
      await addHistory({
        event: ListingHistoryEvent.MonthlyRent,
        newStatus: null,
        oldMonthlyRentBirr: 15000,
        newMonthlyRentBirr: 14000,
      });
      await addHistory({
        event: ListingHistoryEvent.AvailableFrom,
        newStatus: null,
        oldAvailableFrom: '2026-12-01',
        newAvailableFrom: '2027-01-01',
      });
      await addHistory({
        oldStatus: S.Live,
        newStatus: S.Removed,
        closeReason: CloseReason.StaffTakedown,
        staffReasonCode: StaffReasonCode.Guidelines,
        actorType: ActorType.Admin,
      });
      await addHistory({
        oldStatus: S.Live,
        newStatus: S.Stale,
        actorType: ActorType.System,
        actorId: null,
      });

      expect(await db.getRepository(ListingHistory).count()).toBe(5);
    });

    it.each([
      ['a status row without the new status', { newStatus: null }],
      ['a status row with a rent', { newMonthlyRentBirr: 14000 }],
      [
        'a rent row without the old rent',
        {
          event: ListingHistoryEvent.MonthlyRent,
          newStatus: null,
          newMonthlyRentBirr: 14000,
        },
      ],
      [
        'a rent row with a status',
        {
          event: ListingHistoryEvent.MonthlyRent,
          oldMonthlyRentBirr: 15000,
          newMonthlyRentBirr: 14000,
        },
      ],
      [
        'an available-from row with a rent',
        {
          event: ListingHistoryEvent.AvailableFrom,
          newStatus: null,
          oldAvailableFrom: '2026-12-01',
          newAvailableFrom: '2027-01-01',
          newMonthlyRentBirr: 14000,
        },
      ],
    ] as [string, Partial<ListingHistory>][])(
      'refuses %s',
      async (_name, fields) => {
        await expect(addHistory(fields)).rejects.toMatchObject(
          violates('CHK_listing_history_event_fields'),
        );
      },
    );

    it('refuses a reason on a rent row', async () => {
      await expect(
        addHistory({
          event: ListingHistoryEvent.MonthlyRent,
          newStatus: null,
          oldMonthlyRentBirr: 15000,
          newMonthlyRentBirr: 14000,
          closeReason: CloseReason.RentedInApp,
        }),
      ).rejects.toMatchObject(violates('CHK_listing_history_reasons'));
    });

    it('refuses a rent of 0', async () => {
      await expect(
        addHistory({
          event: ListingHistoryEvent.MonthlyRent,
          newStatus: null,
          oldMonthlyRentBirr: 15000,
          newMonthlyRentBirr: 0,
        }),
      ).rejects.toMatchObject(
        violates('CHK_listing_history_monthly_rent_birr'),
      );
    });

    it.each([
      ['a scheduled job with an id', { actorType: ActorType.System }],
      ['a user without an id', { actorType: ActorType.User, actorId: null }],
      ['staff without an id', { actorType: ActorType.Admin, actorId: null }],
    ] as [string, Partial<ListingHistory>][])(
      'refuses %s',
      async (_name, fields) => {
        await expect(addHistory(fields)).rejects.toMatchObject(
          violates('CHK_listing_history_actor'),
        );
      },
    );

    it('rows are never changed: UPDATE is refused by the database', async () => {
      await addHistory({});

      const error = await db
        .query(`UPDATE listing_history SET new_status = 'live'`)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(QueryFailedError);
      expect((error as Error).message).toContain(
        'listing_history rows are never changed',
      );
    });

    it('deleting a draft deletes its history with it', async () => {
      const propertyId = await makeProperty();
      const listingId = await makeListing(propertyId);
      await db.getRepository(ListingHistory).insert({
        listingId,
        event: ListingHistoryEvent.Status,
        newStatus: S.Draft,
        actorType: ActorType.System,
      });

      await db.getRepository(Listing).delete({ id: listingId });

      expect(await db.getRepository(ListingHistory).count()).toBe(0);
    });

    it('a property with a listing cannot be deleted', async () => {
      const propertyId = await makeProperty();
      await makeListing(propertyId);

      await expect(
        db.getRepository(Property).delete({ id: propertyId }),
      ).rejects.toMatchObject(violates('FK_listings_property_id'));
    });
  });

  describe('location', () => {
    it('the exact point and the landmark are left out unless asked for by name (G3)', async () => {
      const propertyId = await makeProperty({
        location: point(9.0102, 38.7606),
        approxLocation: point(9.0121, 38.7631),
        landmark: 'Behind the blue gate, next to the pharmacy',
      });
      const properties = db.getRepository(Property);

      const plain = await properties.findOneByOrFail({ id: propertyId });
      // Every entity field exists on the object (ES2022 class fields); unselected ones are undefined.
      expect(plain.location).toBeUndefined();
      expect(plain.landmark).toBeUndefined();
      expect(plain.approxLocation).toEqual(point(9.0121, 38.7631));

      const withPrivate = await properties
        .createQueryBuilder('p')
        .addSelect(['p.location', 'p.landmark'])
        .where('p.id = :id', { id: propertyId })
        .getOneOrFail();
      expect(withPrivate.location).toEqual(point(9.0102, 38.7606));
      expect(withPrivate.landmark).toBe(
        'Behind the blue gate, next to the pharmacy',
      );
    });

    it('search uses a GiST index on approx_location, and nothing indexes the exact point (G4)', async () => {
      const rows = await db.query<{ indexname: string; indexdef: string }[]>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'properties'`,
      );

      const approx = rows.find(
        (r) => r.indexname === 'IDX_properties_approx_location',
      );
      expect(approx?.indexdef).toContain('USING gist (approx_location)');
      expect(rows.filter((r) => /\(location\)/.test(r.indexdef))).toHaveLength(
        0,
      );
    });
  });
});
