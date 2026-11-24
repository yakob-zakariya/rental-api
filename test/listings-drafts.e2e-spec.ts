import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { LISTING_LIMITS } from '../src/modules/listings/listing-limits.js';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { UnlimitedThrottlerStorage } from './fakes/unlimited-throttler-storage.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import { addisDate } from './utils/listings.js';
import { signIn } from './utils/sign-in.js';

// Drafts (spec section 3, T2.2): POST/PATCH/DELETE /listings and GET /me/listings.

const MESKEL_SQUARE = { lat: 9.0102, lng: 38.7606 };
const BOLE_AIRPORT = { lat: 8.9792, lng: 38.7966 };
const BURAYU = { lat: 9.036, lng: 38.6608 }; // about 1.3 km outside the city

const ALL_REQUIRED = [
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
  'monthlyRentBirr',
  'advanceMonths',
  'negotiable',
  'availableFrom',
];

interface Lister {
  token: string;
  userId: string;
}

describe('listings: drafts (e2e, T2.2)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  const sms = new FakeSmsSender();
  let counter = 0;
  let bole: { id: string }; // a seeded neighbourhood
  let full: Record<string, unknown>;

  beforeAll(async () => {
    // This file sends far more than 100 requests a minute from the one test IP.
    app = await createTestApp((b) =>
      b
        .overrideProvider(SmsSender)
        .useValue(sms)
        .overrideProvider(ThrottlerStorage)
        .useValue(new UnlimitedThrottlerStorage()),
    );
    db = app.get(DataSource);
  });

  beforeEach(async () => {
    [bole] = await db.query<{ id: string }[]>(
      `SELECT n.id FROM neighbourhoods n JOIN sub_cities s ON s.id = n.sub_city_id
       WHERE s.name_en = 'Bole' ORDER BY n.name_en LIMIT 1`,
    );
    full = {
      neighbourhoodId: bole.id,
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
    };
  });

  afterEach(async () => {
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const lister = async (): Promise<Lister> => {
    const phone = `+2519150000${String(++counter).padStart(2, '0')}`;
    const { accessToken } = await signIn(app, sms, phone);
    const [{ id }] = await db.query<{ id: string }[]>(
      `SELECT id FROM users WHERE phone = $1`,
      [phone],
    );
    return { token: accessToken, userId: id };
  };

  const http = () => request(app.getHttpServer());
  const create = (who: Lister, body: object = {}) =>
    http()
      .post('/listings')
      .set('Authorization', `Bearer ${who.token}`)
      .send(body);
  const patch = (who: Lister, id: string, body: object) =>
    http()
      .patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${who.token}`)
      .send(body);
  const remove = (who: Lister, id: string) =>
    http()
      .delete(`/listings/${id}`)
      .set('Authorization', `Bearer ${who.token}`);
  const mine = async (who: Lister) =>
    (
      await http()
        .get('/me/listings')
        .set('Authorization', `Bearer ${who.token}`)
        .expect(200)
    ).body as Record<string, any>[];

  /** A new draft's id. */
  const draft = async (who: Lister, body: object = {}): Promise<string> =>
    (await create(who, body).expect(201)).body.id;

  const distanceToApprox = async (listingId: string): Promise<number> => {
    const [row] = await db.query<{ metres: number }[]>(
      `SELECT ST_Distance(p.location, p.approx_location) AS metres
       FROM listings l JOIN properties p ON p.id = l.property_id WHERE l.id = $1`,
      [listingId],
    );
    return row.metres;
  };

  const approxOf = async (listingId: string): Promise<string | null> => {
    const [row] = await db.query<{ approx: string | null }[]>(
      `SELECT ST_AsText(p.approx_location) AS approx
       FROM listings l JOIN properties p ON p.id = l.property_id WHERE l.id = $1`,
      [listingId],
    );
    return row.approx;
  };

  /** Puts a draft into another state directly, for the "not a draft" cases. */
  const setStatus = (listingId: string, status: string) =>
    db.query(`UPDATE listings SET status = $2 WHERE id = $1`, [
      listingId,
      status,
    ]);

  describe('POST /listings', () => {
    it('needs a signed-in user', async () => {
      await http().post('/listings').send({}).expect(401);
    });

    it('an empty draft, without verification (L1): everything still missing, and its history row', async () => {
      const who = await lister();
      const { body } = await create(who).expect(201);

      expect(body).toMatchObject({
        status: 'draft',
        version: 1,
        missing: ALL_REQUIRED,
        monthlyRentBirr: null,
        negotiable: null,
        property: {
          neighbourhood: null,
          subCity: null,
          furnished: null,
          amenities: [],
          location: null,
          approxLocation: null,
          landmark: null,
        },
      });
      const [user] = await db.query<{ verification_status: string }[]>(
        `SELECT verification_status FROM users WHERE id = $1`,
        [who.userId],
      );
      expect(user.verification_status).toBe('not_verified');
      expect(
        await db.query(
          `SELECT event, old_status, new_status, actor_type, actor_id FROM listing_history
           WHERE listing_id = $1`,
          [body.id],
        ),
      ).toEqual([
        {
          event: 'status',
          old_status: null,
          new_status: 'draft',
          actor_type: 'user',
          actor_id: who.userId,
        },
      ]);
    });

    it('a complete draft: nothing missing, private fields shown to the lister, the area named', async () => {
      const { body } = await create(await lister(), full).expect(201);

      expect(body).toMatchObject({
        status: 'draft',
        missing: [],
        monthlyRentBirr: 25000,
        advanceMonths: 2,
        negotiable: true,
        availableFrom: full.availableFrom,
        property: {
          neighbourhood: { id: bole.id, active: true },
          subCity: { nameEn: 'Bole', nameAm: 'ቦሌ' },
          type: 'apartment',
          bedrooms: 2,
          sizeM2: 85,
          // Stored in one fixed order, whatever order they were sent in.
          amenities: ['parking', 'guard'],
          location: MESKEL_SQUARE,
          landmark: 'Blue gate behind the pharmacy',
          listerRelation: 'owner',
        },
      });
    });

    it('G2: the approximate point is 200–400 m from the exact one', async () => {
      for (let i = 0; i < 5; i++) {
        const id = await draft(await lister(), { location: MESKEL_SQUARE });
        const metres = await distanceToApprox(id);
        expect(metres).toBeGreaterThanOrEqual(199.9);
        expect(metres).toBeLessThanOrEqual(400.1);
      }
    });

    it('trims text, and counts characters as the database does (an emoji is 1)', async () => {
      const description = 'ሀ'.repeat(1999) + '🏠'; // 2000 characters, 2001 UTF-16 units
      const { body } = await create(await lister(), {
        description,
        landmark: '  Next to the school  ',
      }).expect(201);

      expect(body.property.description).toBe(description);
      expect(body.property.landmark).toBe('Next to the school');
    });

    it.each([
      ['rent as text', { monthlyRentBirr: '1500' }, 'monthlyRentBirr'],
      [
        'rent with cents (hard rule 6)',
        { monthlyRentBirr: 1500.5 },
        'monthlyRentBirr',
      ],
      ['rent 0', { monthlyRentBirr: 0 }, 'monthlyRentBirr'],
      ['0 advance months', { advanceMonths: 0 }, 'advanceMonths'],
      ['13 advance months', { advanceMonths: 13 }, 'advanceMonths'],
      ['negative bedrooms', { bedrooms: -1 }, 'bedrooms'],
      ['half a bathroom', { bathrooms: 1.5 }, 'bathrooms'],
      ['size 0', { sizeM2: 0 }, 'sizeM2'],
      ['floor -1', { floor: -1 }, 'floor'],
      ['a blank description', { description: '   ' }, 'description'],
      [
        'a description over 2000 characters',
        { description: 'ሀ'.repeat(2001) },
        'description',
      ],
      [
        'a landmark over 200 characters',
        { landmark: 'x'.repeat(201) },
        'landmark',
      ],
      [
        'a blank unlisted neighbourhood name',
        { unlistedNeighbourhoodName: ' ' },
        'unlistedNeighbourhoodName',
      ],
      [
        'a duplicate amenity',
        { amenities: ['parking', 'parking'] },
        'amenities',
      ],
      ['an unknown amenity', { amenities: ['pool'] }, 'amenities'],
      ['null amenities ([] means none)', { amenities: null }, 'amenities'],
      ['an unknown type', { type: 'castle' }, 'type'],
      ['an impossible date', { availableFrom: '2027-02-30' }, 'availableFrom'],
      [
        'a date in another format',
        { availableFrom: '01/12/2026' },
        'availableFrom',
      ],
      [
        'a latitude over 90',
        { location: { lat: 91, lng: 38.76 } },
        'location.lat',
      ],
      [
        'a latitude as text',
        { location: { lat: '9.01', lng: 38.76 } },
        'location.lat',
      ],
      [
        'a location that is not an object',
        { location: '9.01,38.76' },
        'location',
      ],
      [
        'a malformed neighbourhood id',
        { neighbourhoodId: 'bole' },
        'neighbourhoodId',
      ],
      ['setting the status', { status: 'live' }, 'status'],
      ['setting the version', { version: 7 }, 'version'],
    ])('refuses %s', async (_name, body, field) => {
      const { body: error } = await create(await lister(), body).expect(400);

      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.errors.map((e: { field: string }) => e.field)).toContain(
        field,
      );
    });

    it('accepts every field at its upper limit', async () => {
      await create(await lister(), {
        bedrooms: 20,
        bathrooms: 20,
        floor: 60,
        sizeM2: 5000,
        monthlyRentBirr: 2_000_000,
      }).expect(201);
    });

    it.each(Object.entries(LISTING_LIMITS))(
      'over the limit for %s: 400 with its own code and the limit',
      async (field, { max, code }) => {
        const { body } = await create(await lister(), {
          [field]: max + 1,
        }).expect(400);

        expect(body).toEqual({ code, max });
      },
    );

    it('a huge number is refused by the limit, not by the database', async () => {
      const { body } = await create(await lister(), {
        monthlyRentBirr: 1e15,
      }).expect(400);

      expect(body.code).toBe('RENT_ABOVE_LIMIT');
    });

    it('L13: available-from can be today but not yesterday (Addis Ababa date)', async () => {
      await create(await lister(), { availableFrom: addisDate(0) }).expect(201);
      const { body } = await create(await lister(), {
        availableFrom: addisDate(-1),
      }).expect(400);

      expect(body.code).toBe('AVAILABLE_FROM_IN_PAST');
    });

    it('an unknown neighbourhood is 400 NEIGHBOURHOOD_NOT_FOUND', async () => {
      const { body } = await create(await lister(), {
        neighbourhoodId: '00000000-0000-4000-8000-000000000000',
      }).expect(400);

      expect(body.code).toBe('NEIGHBOURHOOD_NOT_FOUND');
    });

    it('G8: a deactivated neighbourhood cannot be picked', async () => {
      await db.query(
        `UPDATE neighbourhoods SET deactivated_at = now() WHERE id = $1`,
        [bole.id],
      );

      const { body } = await create(await lister(), {
        neighbourhoodId: bole.id,
      }).expect(400);

      expect(body.code).toBe('NEIGHBOURHOOD_INACTIVE');
    });

    it('"my neighbourhood isn\'t listed": the nearest one plus the typed name', async () => {
      const { body } = await create(await lister(), {
        neighbourhoodId: bole.id,
        unlistedNeighbourhoodName: 'Gerji Mebrat Hail',
      }).expect(201);

      expect(body.property).toMatchObject({
        neighbourhood: { id: bole.id },
        unlistedNeighbourhoodName: 'Gerji Mebrat Hail',
      });
      // Optional: not in `missing` when left out.
      expect(body.missing).not.toContain('unlistedNeighbourhoodName');
    });
  });

  describe('G1: a pin outside Addis Ababa', () => {
    const demand = () =>
      db.query<
        {
          lat_rounded: string;
          lng_rounded: string;
          day: string;
          refusals: number;
        }[]
      >(
        `SELECT lat_rounded, lng_rounded, day::text AS day, refusals FROM out_of_area_demand`,
      );

    it('is refused, creates nothing, and is recorded rounded to ~1 km, by day', async () => {
      const { body } = await create(await lister(), {
        location: BURAYU,
      }).expect(400);

      expect(body).toEqual({ code: 'LOCATION_OUTSIDE_SERVICE_AREA' });
      expect(await db.query(`SELECT id FROM listings`)).toEqual([]);
      expect(await demand()).toEqual([
        {
          lat_rounded: '9.04',
          lng_rounded: '38.66',
          day: addisDate(0),
          refusals: 1,
        },
      ]);
    });

    it('another refused pin in the same ~1 km cell adds to its count, even from someone else', async () => {
      await create(await lister(), { location: BURAYU }).expect(400);
      await create(await lister(), {
        location: { lat: 9.0412, lng: 38.6596 },
      }).expect(400);

      expect(await demand()).toMatchObject([{ refusals: 2 }]);
    });

    it('two refusals at the same moment both count', async () => {
      const [a, b] = [await lister(), await lister()];
      await Promise.all([
        create(a, { location: BURAYU }).expect(400),
        create(b, { location: BURAYU }).expect(400),
      ]);

      expect(await demand()).toMatchObject([{ refusals: 2 }]);
    });

    it('holds nothing that could identify the lister: no user, listing, device or exact time', async () => {
      const columns = await db.query<{ column_name: string }[]>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'out_of_area_demand' ORDER BY ordinal_position`,
      );

      expect(columns.map((c) => c.column_name)).toEqual([
        'lat_rounded',
        'lng_rounded',
        'day',
        'refusals',
      ]);
    });

    it('is refused on PATCH too, leaving the draft as it was', async () => {
      const who = await lister();
      const id = await draft(who, { location: MESKEL_SQUARE });

      const { body } = await patch(who, id, { location: BURAYU }).expect(400);

      expect(body.code).toBe('LOCATION_OUTSIDE_SERVICE_AREA');
      expect((await mine(who))[0]).toMatchObject({
        version: 1,
        property: { location: MESKEL_SQUARE },
      });
      expect(await demand()).toHaveLength(1);
    });
  });

  describe('the draft limit (MAX_DRAFT_LISTINGS = 10)', () => {
    it('the 11th draft is 409 DRAFT_LISTING_LIMIT; others are not affected; deleting one frees a place', async () => {
      const who = await lister();
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) ids.push(await draft(who));

      const { body } = await create(who).expect(409);
      expect(body).toEqual({ code: 'DRAFT_LISTING_LIMIT', max: 10 });

      await create(await lister()).expect(201);
      await remove(who, ids[0]).expect(204);
      await create(who).expect(201);
    });

    it('only drafts count', async () => {
      const who = await lister();
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) ids.push(await draft(who, full));
      await setStatus(ids[0], 'pending_review');

      await create(who).expect(201);
    });

    it('creates at the same moment cannot slip past it', async () => {
      const who = await lister();
      for (let i = 0; i < 9; i++) await draft(who);

      const results = await Promise.all([
        create(who),
        create(who),
        create(who),
      ]);

      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        201, 409, 409,
      ]);
    });
  });

  describe('PATCH /listings/:id', () => {
    it('fills in fields: version goes up, `missing` shrinks, no history row for a draft edit', async () => {
      const who = await lister();
      const id = await draft(who);

      const { body } = await patch(who, id, {
        monthlyRentBirr: 18000,
        type: 'studio',
      }).expect(200);

      expect(body).toMatchObject({
        version: 2,
        monthlyRentBirr: 18000,
        property: { type: 'studio' },
      });
      expect(body.missing).not.toContain('monthlyRentBirr');
      expect(body.missing).not.toContain('type');
      expect(body.missing).toHaveLength(ALL_REQUIRED.length - 2);
      expect(
        await db.query(`SELECT id FROM listing_history WHERE listing_id = $1`, [
          id,
        ]),
      ).toHaveLength(1);
    });

    it('null clears a field; [] clears the amenities; a field not sent is kept', async () => {
      const who = await lister();
      const id = await draft(who, full);

      const { body } = await patch(who, id, {
        sizeM2: null,
        monthlyRentBirr: null,
        amenities: [],
      }).expect(200);

      expect(body).toMatchObject({
        monthlyRentBirr: null,
        advanceMonths: 2,
        missing: ['monthlyRentBirr'],
        property: { sizeM2: null, amenities: [], bedrooms: 2 },
      });
    });

    it('the same values again change nothing: same version, same updatedAt', async () => {
      const who = await lister();
      const id = await draft(who, full);
      const before = (await mine(who))[0];

      const { body } = await patch(who, id, {
        monthlyRentBirr: 25000,
        amenities: ['parking', 'guard'],
        location: MESKEL_SQUARE,
        landmark: 'Blue gate behind the pharmacy',
      }).expect(200);

      expect(body.version).toBe(1);
      expect(body.updatedAt).toBe(before.updatedAt);
    });

    it('an empty body is 400 NO_FIELDS_TO_UPDATE', async () => {
      const who = await lister();
      const { body } = await patch(who, await draft(who), {}).expect(400);

      expect(body.code).toBe('NO_FIELDS_TO_UPDATE');
    });

    it('the limits apply', async () => {
      const who = await lister();
      const { body } = await patch(who, await draft(who), {
        bedrooms: 21,
      }).expect(400);

      expect(body).toEqual({ code: 'BEDROOMS_ABOVE_LIMIT', max: 20 });
    });

    describe('G2: the approximate point', () => {
      it('is kept when other fields change, or when the same point is sent again', async () => {
        const who = await lister();
        const id = await draft(who, { location: MESKEL_SQUARE });
        const approx = await approxOf(id);

        await patch(who, id, { bedrooms: 3 }).expect(200);
        await patch(who, id, { location: MESKEL_SQUARE }).expect(200);

        expect(await approxOf(id)).toBe(approx);
      });

      it('is made again when the exact point moves, 200–400 m from the new one', async () => {
        const who = await lister();
        const id = await draft(who, { location: MESKEL_SQUARE });
        const approx = await approxOf(id);

        const { body } = await patch(who, id, {
          location: BOLE_AIRPORT,
        }).expect(200);

        expect(body.property.location).toEqual(BOLE_AIRPORT);
        expect(await approxOf(id)).not.toBe(approx);
        const metres = await distanceToApprox(id);
        expect(metres).toBeGreaterThanOrEqual(199.9);
        expect(metres).toBeLessThanOrEqual(400.1);
      });

      it('null clears both points', async () => {
        const who = await lister();
        const id = await draft(who, { location: MESKEL_SQUARE });

        const { body } = await patch(who, id, { location: null }).expect(200);

        expect(body.property).toMatchObject({
          location: null,
          approxLocation: null,
        });
        expect(body.missing).toContain('location');
      });
    });

    it("L13: an old available-from date blocks nothing else, but can't be newly set in the past", async () => {
      const who = await lister();
      const id = await draft(who, full);
      await db.query(`UPDATE listings SET available_from = $2 WHERE id = $1`, [
        id,
        addisDate(-10),
      ]);

      await patch(who, id, { bedrooms: 3 }).expect(200);
      await patch(who, id, { availableFrom: addisDate(-10) }).expect(200);
      const { body } = await patch(who, id, {
        availableFrom: addisDate(-1),
      }).expect(400);

      expect(body.code).toBe('AVAILABLE_FROM_IN_PAST');
    });

    it("G8: a property keeps a neighbourhood deactivated after it was picked, but can't switch to one", async () => {
      const who = await lister();
      const id = await draft(who, { neighbourhoodId: bole.id });
      const [other] = await db.query<{ id: string }[]>(
        `SELECT id FROM neighbourhoods WHERE id <> $1 LIMIT 1`,
        [bole.id],
      );
      await db.query(
        `UPDATE neighbourhoods SET deactivated_at = now() WHERE id IN ($1, $2)`,
        [bole.id, other.id],
      );

      await patch(who, id, { bedrooms: 3 }).expect(200);
      const { body } = await patch(who, id, {
        neighbourhoodId: bole.id,
        bedrooms: 4,
      }).expect(200);
      expect(body.property.neighbourhood).toMatchObject({
        id: bole.id,
        active: false,
      });

      const { body: error } = await patch(who, id, {
        neighbourhoodId: other.id,
      }).expect(400);
      expect(error.code).toBe('NEIGHBOURHOOD_INACTIVE');
    });

    it("L3: someone else's listing, an unknown id and a malformed id are all 404 LISTING_NOT_FOUND", async () => {
      const owner = await lister();
      const id = await draft(owner);
      const other = await lister();

      for (const target of [
        id,
        '00000000-0000-4000-8000-000000000000',
        'not-a-uuid',
      ]) {
        const { body } = await patch(other, target, { bedrooms: 2 }).expect(
          404,
        );
        expect(body.code).toBe('LISTING_NOT_FOUND');
      }
      expect((await mine(owner))[0].property.bedrooms).toBeNull();
    });

    it.each(['pending_review', 'live', 'expired'])(
      'a %s listing is 409 INVALID_LISTING_STATE (editing outside draft comes in T2.4)',
      async (status) => {
        const who = await lister();
        const id = await draft(who, full);
        await setStatus(id, status);

        const { body } = await patch(who, id, { bedrooms: 3 }).expect(409);

        expect(body.code).toBe('INVALID_LISTING_STATE');
      },
    );

    it('two edits at the same moment both apply, and both count in version', async () => {
      const who = await lister();
      const id = await draft(who);

      await Promise.all([
        patch(who, id, { bedrooms: 3 }).expect(200),
        patch(who, id, { monthlyRentBirr: 12000 }).expect(200),
      ]);

      expect((await mine(who))[0]).toMatchObject({
        version: 3,
        monthlyRentBirr: 12000,
        property: { bedrooms: 3 },
      });
    });
  });

  describe('DELETE /listings/:id', () => {
    it('deletes the draft, its history and its property', async () => {
      const who = await lister();
      const id = await draft(who, full);

      await remove(who, id).expect(204);

      expect(await mine(who)).toEqual([]);
      for (const table of ['listings', 'listing_history', 'properties'])
        expect(await db.query(`SELECT 1 FROM ${table}`)).toEqual([]);
    });

    it('keeps the property when older listings of it remain (a relist draft, L11)', async () => {
      const who = await lister();
      const oldId = await draft(who, full);
      await db.query(
        `UPDATE listings SET status = 'rented', close_reason = 'rented_elsewhere', closed_at = now()
         WHERE id = $1`,
        [oldId],
      );
      const [{ property_id }] = await db.query<{ property_id: string }[]>(
        `SELECT property_id FROM listings WHERE id = $1`,
        [oldId],
      );
      const [{ id: relistId }] = await db.query<{ id: string }[]>(
        `INSERT INTO listings (property_id) VALUES ($1) RETURNING id`,
        [property_id],
      );

      await remove(who, relistId).expect(204);

      expect(
        await db.query(`SELECT id FROM properties WHERE id = $1`, [
          property_id,
        ]),
      ).toHaveLength(1);
      expect((await mine(who)).map((l) => l.id)).toEqual([oldId]);
    });

    it("L3: someone else's draft is 404, and stays", async () => {
      const owner = await lister();
      const id = await draft(owner);

      const { body } = await remove(await lister(), id).expect(404);

      expect(body.code).toBe('LISTING_NOT_FOUND');
      expect(await mine(owner)).toHaveLength(1);
    });

    it('a listing that is not a draft is 409 INVALID_LISTING_STATE', async () => {
      const who = await lister();
      const id = await draft(who, full);
      await setStatus(id, 'pending_review');

      const { body } = await remove(who, id).expect(409);

      expect(body.code).toBe('INVALID_LISTING_STATE');
    });
  });

  describe('GET /me/listings', () => {
    it('only your own listings, newest first', async () => {
      const who = await lister();
      const first = await draft(who);
      const second = await draft(who);
      await draft(await lister());

      expect((await mine(who)).map((l) => l.id)).toEqual([second, first]);
      expect(await mine(await lister())).toEqual([]);
    });

    it('needs a signed-in user', async () => {
      await http().get('/me/listings').expect(401);
    });
  });
});
