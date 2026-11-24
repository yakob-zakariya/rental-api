import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { UnlimitedThrottlerStorage } from './fakes/unlimited-throttler-storage.js';
import { createTestAdmin } from './utils/admins.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import {
  boleNeighbourhoodId,
  fullListing,
  MESKEL_SQUARE,
} from './utils/listings.js';
import { plainImage } from './utils/photos.js';
import { signIn } from './utils/sign-in.js';

// The public listing detail, the lister's public name and the optional sign-in (G3, G6, L7; T5.2).

interface Lister {
  token: string;
  userId: string;
  phone: string;
}

describe('listings: public detail (e2e, T5.2)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  const sms = new FakeSmsSender();
  let counter = 0;

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

  afterEach(async () => {
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  const lister = async (fullName = 'Yakob Zekariya Aman'): Promise<Lister> => {
    const phone = `+2519240000${String(++counter).padStart(2, '0')}`;
    const { accessToken } = await signIn(app, sms, phone);
    await db.query(
      `UPDATE users SET verification_status = 'approved', full_name = $2 WHERE phone = $1`,
      [phone, fullName],
    );
    const [{ id }] = await db.query<{ id: string }[]>(
      `SELECT id FROM users WHERE phone = $1`,
      [phone],
    );
    return { token: accessToken, userId: id, phone };
  };
  const as = (who: Lister) => ({ Authorization: `Bearer ${who.token}` });

  /** A real live listing: 3 uploads, submitted, approved by a moderator. */
  const liveListing = async (who: Lister) => {
    const { body: draft } = await http()
      .post('/listings')
      .set(as(who))
      .send({
        ...fullListing(await boleNeighbourhoodId(db)),
        unlistedNeighbourhoodName: 'Gerji Mebrat Hail',
      })
      .expect(201);
    for (let i = 0; i < 3; i++)
      await http()
        .post(`/properties/${draft.property.id}/photos`)
        .set(as(who))
        .attach('photo', await plainImage(800, 600), 'p.jpg')
        .expect(201);
    const { body: submitted } = await http()
      .post(`/listings/${draft.id}/submit`)
      .set(as(who))
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
    return draft.id as string;
  };
  const draftOf = async (who: Lister) =>
    (
      await http()
        .post('/listings')
        .set(as(who))
        .send(fullListing(await boleNeighbourhoodId(db)))
        .expect(201)
    ).body.id as string;
  const setStatus = (id: string, status: string) =>
    db.query(
      `UPDATE listings SET status = $2::listing_status,
         close_reason = CASE $2::text WHEN 'rented' THEN 'rented_elsewhere'::listing_close_reason END,
         closed_at = CASE WHEN $2::text = 'rented' THEN now() END
       WHERE id = $1`,
      [id, status],
    );
  const detail = (id: string, auth: Record<string, string> = {}) =>
    http().get(`/listings/${id}`).set(auth);

  describe('a live listing, for anyone (G6)', () => {
    it('the listing, full photos at public URLs, the area, the approximate point and the public name (L7)', async () => {
      const id = await liveListing(await lister());

      const { body } = await detail(id).expect(200);

      expect(body).toMatchObject({
        id,
        status: 'live',
        viewerIsLister: false,
        monthlyRentBirr: 25000,
        description:
          'Bright two-bedroom flat, five minutes from the main road.',
        subCity: { nameEn: 'Bole', nameAm: 'ቦሌ' },
        listerRelation: 'owner',
        lister: { publicName: 'Yakob Z.', verified: true },
      });
      expect(body.approxLocation).toEqual({
        lat: expect.any(Number),
        lng: expect.any(Number),
      });
      expect(body.photos).toHaveLength(3);
      for (const photo of body.photos) {
        expect(photo.url).not.toContain('-thumb');
        expect(photo).toMatchObject({ width: 800, height: 600 });
        // Public: no signature, opens without credentials.
        expect(photo.url).not.toContain('X-Amz-Signature');
        expect((await fetch(photo.url)).status).toBe(200);
      }
    });

    it('never shows the exact point, the landmark, the typed neighbourhood, the full name or the phone (G3)', async () => {
      const who = await lister();
      const id = await liveListing(who);

      const { text } = await detail(id).expect(200);

      expect(text).not.toContain(String(MESKEL_SQUARE.lat));
      expect(text).not.toContain('Blue gate behind the pharmacy');
      expect(text).not.toContain('Gerji Mebrat Hail');
      expect(text).not.toContain('Zekariya');
      expect(text).not.toContain(who.phone.slice(4));
      expect(text).not.toContain(who.userId);
    });

    it('the same public name appears on the browse card', async () => {
      await liveListing(await lister('YAKOB ZEKARIYA AMAN'));

      const { body } = await http().get('/listings').expect(200);

      expect(body.items[0].lister).toEqual({
        publicName: 'Yakob Z.',
        verified: true,
      });
    });
  });

  describe('everyone else gets 404 LISTING_NOT_FOUND', () => {
    it.each([
      'draft',
      'pending_review',
      'stale',
      'expired',
      'rejected',
      'rented',
    ])('a %s listing', async (status) => {
      const id = await draftOf(await lister());
      await setStatus(id, status);

      const { body } = await detail(id).expect(404);

      expect(body.code).toBe('LISTING_NOT_FOUND');
    });

    it.each([
      ['banned', `UPDATE users SET status = 'banned' WHERE id = $1`],
      [
        'no longer verified (decided 2026-11-24)',
        `UPDATE users SET verification_status = 'blocked' WHERE id = $1`,
      ],
    ])(
      'a live listing whose lister is %s: hidden from detail and browse',
      async (_name, sql) => {
        const who = await lister();
        const id = await liveListing(who);
        await db.query(sql, [who.userId]);

        expect((await detail(id).expect(404)).body.code).toBe(
          'LISTING_NOT_FOUND',
        );
        expect((await http().get('/listings').expect(200)).body.items).toEqual(
          [],
        );
      },
    );

    it('an unknown or malformed id', async () => {
      for (const id of ['00000000-0000-4000-8000-000000000000', 'nope'])
        expect((await detail(id).expect(404)).body.code).toBe(
          'LISTING_NOT_FOUND',
        );
    });
  });

  describe("the lister's own preview (optional sign-in, decided 2026-11-24)", () => {
    it('signed in, the lister sees their own draft in the public view, without the private fields', async () => {
      const who = await lister();
      const id = await draftOf(who);

      const { body, text } = await detail(id, as(who)).expect(200);

      expect(body).toMatchObject({
        id,
        status: 'draft',
        viewerIsLister: true,
        lister: { publicName: 'Yakob Z.', verified: false },
      });
      expect(text).not.toContain('Blue gate behind the pharmacy');
    });

    it("a listing in review: photos as signed links (they aren't public yet)", async () => {
      const who = await lister();
      const { body: draft } = await http()
        .post('/listings')
        .set(as(who))
        .send(fullListing(await boleNeighbourhoodId(db)))
        .expect(201);
      await http()
        .post(`/properties/${draft.property.id}/photos`)
        .set(as(who))
        .attach('photo', await plainImage(64, 48), 'p.jpg')
        .expect(201);
      await setStatus(draft.id, 'pending_review');

      const { body } = await detail(draft.id, as(who)).expect(200);

      expect(body.photos[0].url).toContain('X-Amz-Signature');
      expect((await fetch(body.photos[0].url)).status).toBe(200);
    });

    it('another signed-in user still gets 404', async () => {
      const id = await draftOf(await lister());

      await detail(id, as(await lister())).expect(404);
    });

    it('a bad, expired-looking or admin token is ignored: anonymous, never 401', async () => {
      const id = await liveListing(await lister());
      const admin = await createTestAdmin(db, { role: 'support' });
      const { body: login } = await http()
        .post('/admin/auth/login')
        .send({ email: admin.email, password: admin.password })
        .expect(200);

      for (const auth of [
        { Authorization: 'Bearer not-a-token' },
        { Authorization: 'Basic abc' },
        { Authorization: `Bearer ${login.accessToken}` },
      ]) {
        const { body } = await detail(id, auth).expect(200);
        expect(body.viewerIsLister).toBe(false);
      }
      await http()
        .get('/listings')
        .set({ Authorization: 'Bearer junk' })
        .expect(200);
    });

    it('the live listing, seen by its lister, says so', async () => {
      const who = await lister();
      const id = await liveListing(who);

      const { body } = await detail(id, as(who)).expect(200);

      expect(body).toMatchObject({ viewerIsLister: true, status: 'live' });
    });
  });
});
