import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import sharp from 'sharp';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { UnlimitedThrottlerStorage } from './fakes/unlimited-throttler-storage.js';
import { createTestAdmin } from './utils/admins.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import { boleNeighbourhoodId, fullListing } from './utils/listings.js';
import { plainImage } from './utils/photos.js';
import { signIn } from './utils/sign-in.js';

// Public browse (spec G4, G5; T5.1).

const HERE = { lat: 9.0102, lng: 38.7606 }; // Meskel Square, where "near me" searches from
/** A point `km` north of HERE (0.01° of latitude ≈ 1.11 km). */
const north = (km: number) => ({ lat: HERE.lat + km / 111.2, lng: HERE.lng });

interface Lister {
  token: string;
  userId: string;
}

describe('listings: public browse (e2e, T5.1)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  const sms = new FakeSmsSender();
  let counter = 0;
  let bole: string;
  let arada: string;

  beforeAll(async () => {
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
    bole = await boleNeighbourhoodId(db);
    [{ id: arada }] = await db.query<{ id: string }[]>(
      `SELECT n.id FROM neighbourhoods n JOIN sub_cities s ON s.id = n.sub_city_id
       WHERE s.name_en = 'Arada' ORDER BY n.name_en LIMIT 1`,
    );
  });

  afterEach(async () => {
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  const lister = async (): Promise<Lister> => {
    const phone = `+2519230000${String(++counter).padStart(2, '0')}`;
    const { accessToken } = await signIn(app, sms, phone);
    await db.query(
      `UPDATE users SET verification_status = 'approved', full_name = 'Abebe Kebede Tesfaye'
       WHERE phone = $1`,
      [phone],
    );
    const [{ id }] = await db.query<{ id: string }[]>(
      `SELECT id FROM users WHERE phone = $1`,
      [phone],
    );
    return { token: accessToken, userId: id };
  };

  /**
   * A listing made through the API, then put into `status` directly (fast). `approx` places its
   * approximate point (and moves the exact one 10 km away, so tests prove only `approx` counts).
   */
  const listing = async (
    who: Lister,
    {
      status = 'live',
      body = {} as object,
      approx,
      publishedAt = new Date(),
    }: {
      status?: string;
      body?: object;
      approx?: { lat: number; lng: number };
      publishedAt?: Date;
    } = {},
  ): Promise<string> => {
    const { body: created } = await http()
      .post('/listings')
      .set({ Authorization: `Bearer ${who.token}` })
      .send({ ...fullListing(bole), ...body })
      .expect(201);
    await db.query(
      `UPDATE listings SET status = $2::listing_status, published_at = $3,
         close_reason = CASE $2::text WHEN 'rented' THEN 'rented_elsewhere'::listing_close_reason END,
         closed_at = CASE WHEN $2::text = 'rented' THEN now() END
       WHERE id = $1`,
      [created.id, status, publishedAt],
    );
    if (approx) {
      const far = north(10);
      await db.query(
        `UPDATE properties SET
           approx_location = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
           location = ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography
         WHERE id = $1`,
        [created.property.id, approx.lng, approx.lat, far.lng, far.lat],
      );
    }
    return created.id;
  };

  const browse = async (query = '', status = 200) =>
    (await http().get(`/listings${query}`).expect(status)).body;
  const ids = async (query = '') =>
    (await browse(query)).items.map((i: { id: string }) => i.id);

  /** Every id across all pages, following nextCursor. */
  const allPages = async (query: string) => {
    const seen: string[] = [];
    let after = '';
    for (let i = 0; i < 20; i++) {
      const page = await browse(`${query}${after}`);
      seen.push(...page.items.map((x: { id: string }) => x.id));
      if (!page.nextCursor) return seen;
      after = `&after=${page.nextCursor}`;
    }
    throw new Error('too many pages');
  };

  describe('who appears (G5)', () => {
    it('works without an account and shows only live listings of active listers', async () => {
      const who = await lister();
      const live = await listing(who);
      for (const status of [
        'draft',
        'pending_review',
        'stale',
        'expired',
        'rejected',
        'rented',
      ])
        await listing(who, { status });
      const banned = await lister();
      await listing(banned);
      await db.query(`UPDATE users SET status = 'banned' WHERE id = $1`, [
        banned.userId,
      ]);

      expect(await ids()).toEqual([live]);
    });
  });

  describe('filters', () => {
    it('sub-city and neighbourhood', async () => {
      const who = await lister();
      const inBole = await listing(who);
      const inArada = await listing(who, { body: { neighbourhoodId: arada } });
      const [{ sub_city_id }] = await db.query<{ sub_city_id: string }[]>(
        `SELECT sub_city_id FROM neighbourhoods WHERE id = $1`,
        [arada],
      );

      expect(await ids(`?subCityId=${sub_city_id}`)).toEqual([inArada]);
      expect(await ids(`?neighbourhoodId=${bole}`)).toEqual([inBole]);
    });

    it('rent range, maximum advance months, type, minimum bedrooms, furnished, and all combined', async () => {
      const who = await lister();
      const cheap = await listing(who, {
        body: {
          monthlyRentBirr: 8000,
          advanceMonths: 1,
          type: 'studio',
          bedrooms: 0,
          furnished: true,
        },
      });
      const mid = await listing(who, {
        body: {
          monthlyRentBirr: 20000,
          advanceMonths: 3,
          type: 'apartment',
          bedrooms: 2,
          furnished: false,
        },
      });
      const dear = await listing(who, {
        body: {
          monthlyRentBirr: 60000,
          advanceMonths: 6,
          type: 'villa_house',
          bedrooms: 4,
          furnished: true,
        },
      });

      expect(await ids('?minRent=10000&maxRent=30000')).toEqual([mid]);
      expect((await ids('?maxAdvanceMonths=3')).sort()).toEqual(
        [cheap, mid].sort(),
      );
      expect(await ids('?type=villa_house')).toEqual([dear]);
      expect((await ids('?minBedrooms=2')).sort()).toEqual([mid, dear].sort());
      expect((await ids('?furnished=true')).sort()).toEqual(
        [cheap, dear].sort(),
      );
      expect(
        await ids(
          '?furnished=true&minBedrooms=1&maxAdvanceMonths=6&maxRent=70000',
        ),
      ).toEqual([dear]);
      expect(await ids('?type=condominium')).toEqual([]);
    });

    it.each([
      [
        'minRent above maxRent',
        '?minRent=30000&maxRent=10000',
        'RENT_RANGE_INVALID',
      ],
      ['maxAdvanceMonths 13', '?maxAdvanceMonths=13', 'VALIDATION_FAILED'],
      ['maxAdvanceMonths 0', '?maxAdvanceMonths=0', 'VALIDATION_FAILED'],
      ['a malformed sub-city id', '?subCityId=bole', 'VALIDATION_FAILED'],
      ['an unknown type', '?type=castle', 'VALIDATION_FAILED'],
      ['a page of 51', '?limit=51', 'VALIDATION_FAILED'],
      ['an unknown sort', '?sort=price', 'VALIDATION_FAILED'],
      ['lat without lng', `?lat=${HERE.lat}`, 'LOCATION_INCOMPLETE'],
      ['a radius without a point', '?radiusKm=3', 'LOCATION_INCOMPLETE'],
      [
        'a radius over 20 km',
        `?lat=${HERE.lat}&lng=${HERE.lng}&radiusKm=25`,
        'RADIUS_TOO_LARGE',
      ],
      [
        'sort by distance without a point',
        '?sort=distance',
        'DISTANCE_SORT_NEEDS_LOCATION',
      ],
      ['a damaged cursor', '?after=nope', 'INVALID_CURSOR'],
    ])('refuses %s: 400 %s', async (_name, query, code) => {
      const body = await browse(query, 400);

      expect(body.code).toBe(code);
      if (code === 'RADIUS_TOO_LARGE') expect(body.max).toBe(20);
    });
  });

  describe('near me (G4): only the approximate point counts', () => {
    it('inside the radius by its approximate point, though its exact point is 10 km away; and the reverse', async () => {
      const who = await lister();
      const approxNear = await listing(who, { approx: north(1) });
      // Its exact point is right here, but its approximate point is 3 km away.
      const exactNear = await listing(who, { approx: north(3) });
      await db.query(
        `UPDATE properties SET location = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography
         WHERE id = (SELECT property_id FROM listings WHERE id = $1)`,
        [exactNear, HERE.lng, HERE.lat],
      );

      expect(await ids(`?lat=${HERE.lat}&lng=${HERE.lng}&radiusKm=2`)).toEqual([
        approxNear,
      ]);
    });

    it('the distance is from the approximate point, rounded to 100 m', async () => {
      const who = await lister();
      await listing(who, { approx: north(1.234) });

      const { items } = await browse(`?lat=${HERE.lat}&lng=${HERE.lng}`);

      expect(items[0].distanceMetres % 100).toBe(0);
      expect(items[0].distanceMetres).toBeGreaterThanOrEqual(1100);
      expect(items[0].distanceMetres).toBeLessThanOrEqual(1300);
    });

    it('5 km by default (decided 2026-11-24)', async () => {
      const who = await lister();
      const at4 = await listing(who, { approx: north(4) });
      await listing(who, { approx: north(6) });

      expect(await ids(`?lat=${HERE.lat}&lng=${HERE.lng}`)).toEqual([at4]);
    });

    it('without near me, there is no distance', async () => {
      await listing(await lister());

      expect((await browse()).items[0].distanceMetres).toBeNull();
    });
  });

  describe('sorts', () => {
    it('newest first by default (published_at)', async () => {
      const who = await lister();
      const old = await listing(who, {
        publishedAt: new Date('2026-11-01T10:00:00Z'),
      });
      const recent = await listing(who, {
        publishedAt: new Date('2026-11-20T10:00:00Z'),
      });
      const middle = await listing(who, {
        publishedAt: new Date('2026-11-10T10:00:00Z'),
      });

      expect(await ids()).toEqual([recent, middle, old]);
    });

    it('rent, cheapest first and most expensive first (decided 2026-11-24)', async () => {
      const who = await lister();
      const b = await listing(who, { body: { monthlyRentBirr: 20000 } });
      const a = await listing(who, { body: { monthlyRentBirr: 10000 } });
      const c = await listing(who, { body: { monthlyRentBirr: 30000 } });

      expect(await ids('?sort=rent_asc')).toEqual([a, b, c]);
      expect(await ids('?sort=rent_desc')).toEqual([c, b, a]);
    });

    it('distance, nearest first', async () => {
      const who = await lister();
      const far = await listing(who, { approx: north(3) });
      const near = await listing(who, { approx: north(0.5) });
      const mid = await listing(who, { approx: north(1.5) });

      expect(
        await ids(`?lat=${HERE.lat}&lng=${HERE.lng}&sort=distance`),
      ).toEqual([near, mid, far]);
    });
  });

  describe('paging: no gaps or repeats, even with ties', () => {
    it.each([
      [
        'newest, all published at the same moment',
        '?limit=3',
        { publishedAt: new Date('2026-11-20T10:00:00Z') },
      ],
      ['rent_asc, all at the same rent', '?sort=rent_asc&limit=3', {}],
      ['rent_desc, all at the same rent', '?sort=rent_desc&limit=3', {}],
      [
        'distance, all at the same point',
        `?lat=${HERE.lat}&lng=${HERE.lng}&sort=distance&limit=3`,
        { approx: north(1) },
      ],
    ] as [string, string, object][])('%s', async (_name, query, options) => {
      const who = await lister();
      const made: string[] = [];
      for (let i = 0; i < 7; i++) made.push(await listing(who, options));

      const seen = await allPages(query);

      expect(seen).toHaveLength(7);
      expect([...seen].sort()).toEqual([...made].sort());
    });

    it('a cursor from one sort is refused for another: 400 INVALID_CURSOR', async () => {
      const who = await lister();
      for (let i = 0; i < 3; i++) await listing(who);
      const { nextCursor } = await browse('?limit=1');

      const body = await browse(`?sort=rent_asc&after=${nextCursor}`, 400);

      expect(body.code).toBe('INVALID_CURSOR');
    });
  });

  describe('privacy (G3, G4)', () => {
    it("cards never show the exact point, the landmark, the typed neighbourhood or the lister's full name", async () => {
      const who = await lister();
      await listing(who, {
        approx: north(1),
        body: { unlistedNeighbourhoodName: 'Gerji Mebrat Hail' },
      });
      const exact = north(10);

      const text = (await http().get('/listings').expect(200)).text;

      expect(text).not.toContain(String(exact.lat).slice(0, 7));
      expect(text).not.toContain('Blue gate behind the pharmacy');
      expect(text).not.toContain('Gerji Mebrat Hail');
      // Only the public form of the name (L7, T5.2): "Abebe K.", never the rest.
      expect(text).toContain('"publicName":"Abebe K."');
      expect(text).not.toContain('Kebede');
      expect(text).not.toContain('Tesfaye');
      expect(text).not.toContain(who.userId);
    });
  });

  it('through the real flow: the card has a public thumbnail URL that opens without credentials', async () => {
    const who = await lister();
    const auth = { Authorization: `Bearer ${who.token}` };
    const { body: draft } = await http()
      .post('/listings')
      .set(auth)
      .send(fullListing(bole))
      .expect(201);
    for (let i = 0; i < 3; i++)
      await http()
        .post(`/properties/${draft.property.id}/photos`)
        .set(auth)
        .attach('photo', await plainImage(800, 600), 'p.jpg')
        .expect(201);
    const { body: submitted } = await http()
      .post(`/listings/${draft.id}/submit`)
      .set(auth)
      .expect(200);
    const admin = await createTestAdmin(db, { role: 'moderator' });
    const { body: login } = await http()
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password })
      .expect(200);
    await http()
      .post(`/admin/listings/${draft.id}/approve`)
      .set({ Authorization: `Bearer ${login.accessToken}` })
      .send({ version: submitted.version })
      .expect(200);

    const { items } = await browse();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: draft.id,
      photoCount: 3,
      cover: { width: 800, height: 600 },
      subCity: { nameEn: 'Bole', nameAm: 'ቦሌ' },
    });
    expect(items[0].cover.thumbnailUrl).toContain('-thumb.jpg');
    const response = await fetch(items[0].cover.thumbnailUrl);
    expect(response.status).toBe(200);
    const thumbnail = await sharp(
      Buffer.from(await response.arrayBuffer()),
    ).metadata();
    expect(thumbnail).toMatchObject({ width: 480, height: 360 });
  });
});
