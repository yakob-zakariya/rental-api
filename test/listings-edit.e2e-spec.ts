import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { PhotoCounter } from '../src/modules/listings/photo-counter.js';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { FakePhotoCounter } from './fakes/fake-photo-counter.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { UnlimitedThrottlerStorage } from './fakes/unlimited-throttler-storage.js';
import { createTestAdmin } from './utils/admins.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import {
  addisDate,
  boleNeighbourhoodId,
  fullListing,
} from './utils/listings.js';
import { signIn } from './utils/sign-in.js';

// Editing after submitting, and reopening expired listings (spec L5, L6; T2.4).

interface Lister {
  token: string;
  userId: string;
  phone: string;
}

const BOLE_AIRPORT = { lat: 8.9792, lng: 38.7966 };

/** One change per field that needs review on a live listing (L5). */
const REVIEW_CHANGES: [string, object][] = [
  ['description', { description: 'Freshly painted, new kitchen.' }],
  ['location', { location: BOLE_AIRPORT }],
  ['landmark', { landmark: 'Opposite the mosque' }],
  ['type', { type: 'condominium' }],
  ['bedrooms', { bedrooms: 3 }],
  ['bathrooms', { bathrooms: 0 }],
  ['furnished', { furnished: true }],
  ['a meter', { separateElectricityMeter: true }],
  ['size', { sizeM2: 90 }],
  ['floor', { floor: 0 }],
  ['amenities', { amenities: ['gated_compound'] }],
  ['the unlisted neighbourhood name', { unlistedNeighbourhoodName: 'Gerji' }],
  ['advance months', { advanceMonths: 3 }],
  ['the relation', { listerRelation: 'representative' }],
];

describe('listings: editing after submitting, and reopening (e2e, T2.4)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  const sms = new FakeSmsSender();
  const photos = new FakePhotoCounter();
  let counter = 0;
  let full: ReturnType<typeof fullListing>;

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b
        .overrideProvider(SmsSender)
        .useValue(sms)
        .overrideProvider(PhotoCounter)
        .useValue(photos)
        .overrideProvider(ThrottlerStorage)
        .useValue(new UnlimitedThrottlerStorage()),
    );
    db = app.get(DataSource);
  });

  beforeEach(async () => {
    full = fullListing(await boleNeighbourhoodId(db));
  });

  afterEach(async () => {
    photos.reset();
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const lister = async ({
    verification = 'approved',
  } = {}): Promise<Lister> => {
    const phone = `+2519170000${String(++counter).padStart(2, '0')}`;
    const { accessToken } = await signIn(app, sms, phone);
    await db.query(
      `UPDATE users SET verification_status = $2 WHERE phone = $1`,
      [phone, verification],
    );
    const [{ id }] = await db.query<{ id: string }[]>(
      `SELECT id FROM users WHERE phone = $1`,
      [phone],
    );
    return { token: accessToken, userId: id, phone };
  };

  const http = () => request(app.getHttpServer());
  const auth = (who: Lister) => ({ Authorization: `Bearer ${who.token}` });
  const patch = (who: Lister, id: string, body: object) =>
    http().patch(`/listings/${id}`).set(auth(who)).send(body);
  const reopen = (who: Lister, id: string) =>
    http().post(`/listings/${id}/reopen`).set(auth(who));

  /**
   * A complete listing in `status`. `published` (default: any state that has been live) sets
   * published_at as staff approval would (T4.2); closed states get a reason.
   */
  const listing = async (
    who: Lister,
    status: string,
    {
      published = ['live', 'stale', 'expired', 'rented', 'removed'].includes(
        status,
      ),
    } = {},
  ): Promise<string> => {
    const { body } = await http()
      .post('/listings')
      .set(auth(who))
      .send(full)
      .expect(201);
    await db.query(
      `UPDATE listings SET status = $2::listing_status,
         published_at = CASE WHEN $3 THEN now() - interval '20 days' END,
         close_reason = CASE $2::text
           WHEN 'rented' THEN 'rented_elsewhere'::listing_close_reason
           WHEN 'removed' THEN 'no_longer_for_rent'::listing_close_reason END,
         closed_at = CASE WHEN $2::text IN ('rented', 'removed') THEN now() END
       WHERE id = $1`,
      [body.id, status, published],
    );
    return body.id;
  };

  const row = async (id: string) =>
    (
      await db.query<
        {
          status: string;
          version: number;
          needs_review: boolean;
          submitted_at: Date | null;
          published_at: Date | null;
          last_confirmed_at: Date | null;
        }[]
      >(
        `SELECT status, version, needs_review, submitted_at, published_at, last_confirmed_at
         FROM listings WHERE id = $1`,
        [id],
      )
    )[0];

  /** History after creation: every row except the first (null → draft). */
  const history = (id: string) =>
    db.query<Record<string, unknown>[]>(
      `SELECT event, old_status, new_status, old_monthly_rent_birr, new_monthly_rent_birr,
              old_available_from::text, new_available_from::text, actor_type, actor_id
       FROM listing_history WHERE listing_id = $1 AND old_status IS DISTINCT FROM NULL
          OR listing_id = $1 AND event <> 'status'
       ORDER BY created_at, id`,
      [id],
    );

  describe('PATCH by state (L5)', () => {
    it('rejected: any field applies; it stays rejected until resubmitted; nothing recorded', async () => {
      const who = await lister();
      const id = await listing(who, 'rejected');

      const { body } = await patch(who, id, {
        description: 'Better photos now.',
        monthlyRentBirr: 24000,
      }).expect(200);

      expect(body).toMatchObject({ status: 'rejected', version: 2 });
      expect(await history(id)).toEqual([]);
    });

    it('pending_review: any field applies; it stays in the queue; version goes up (R2)', async () => {
      const who = await lister();
      const id = await listing(who, 'pending_review');
      const before = await row(id);

      const { body } = await patch(who, id, { bedrooms: 3 }).expect(200);

      expect(body).toMatchObject({ status: 'pending_review', version: 2 });
      expect((await row(id)).submitted_at).toEqual(before.submitted_at);
      expect(await history(id)).toEqual([]);
    });

    describe.each(['live', 'stale'])('%s', (status) => {
      it('rent applies at once and is recorded', async () => {
        const who = await lister();
        const id = await listing(who, status);

        const { body } = await patch(who, id, {
          monthlyRentBirr: 23000,
        }).expect(200);

        expect(body).toMatchObject({
          status,
          version: 2,
          monthlyRentBirr: 23000,
        });
        expect(await history(id)).toEqual([
          expect.objectContaining({
            event: 'monthly_rent',
            old_monthly_rent_birr: 25000,
            new_monthly_rent_birr: 23000,
            actor_type: 'user',
            actor_id: who.userId,
          }),
        ]);
      });

      it('available-from applies at once and is recorded', async () => {
        const who = await lister();
        const id = await listing(who, status);
        const newDate = addisDate(45);

        const { body } = await patch(who, id, {
          availableFrom: newDate,
        }).expect(200);

        expect(body.status).toBe(status);
        expect(await history(id)).toEqual([
          expect.objectContaining({
            event: 'available_from',
            old_available_from: full.availableFrom,
            new_available_from: newDate,
          }),
        ]);
      });

      it('negotiable applies at once (not recorded)', async () => {
        const who = await lister();
        const id = await listing(who, status);

        const { body } = await patch(who, id, { negotiable: false }).expect(
          200,
        );

        expect(body).toMatchObject({ status, negotiable: false, version: 2 });
        expect(await history(id)).toEqual([]);
      });

      it.each(REVIEW_CHANGES)(
        'changing %s sends it back to review, hidden until approved',
        async (_name, change) => {
          const who = await lister();
          const id = await listing(who, status);

          const { body } = await patch(who, id, change).expect(200);

          expect(body).toMatchObject({ status: 'pending_review', version: 2 });
          expect((await row(id)).submitted_at).not.toBeNull();
          expect(await history(id)).toEqual([
            expect.objectContaining({
              event: 'status',
              old_status: status,
              new_status: 'pending_review',
              actor_id: who.userId,
            }),
          ]);
        },
      );

      it('a mix does both: back to review, and the rent change is recorded', async () => {
        const who = await lister();
        const id = await listing(who, status);

        const { body } = await patch(who, id, {
          monthlyRentBirr: 23000,
          description: 'Now with a balcony.',
        }).expect(200);

        expect(body.status).toBe('pending_review');
        expect(
          (await history(id))
            .map((h) => String(h.event))
            .sort((a, b) => a.localeCompare(b)),
        ).toEqual(['monthly_rent', 'status']);
      });

      it('sending its own values again changes nothing: still live, same version', async () => {
        const who = await lister();
        const id = await listing(who, status);

        const { body } = await patch(who, id, {
          description: full.description,
          location: full.location,
          monthlyRentBirr: full.monthlyRentBirr,
        }).expect(200);

        expect(body).toMatchObject({ status, version: 1 });
        expect(await history(id)).toEqual([]);
      });
    });

    it('moving the pin of a live listing makes a new approximate point, and sends it to review', async () => {
      const who = await lister();
      const id = await listing(who, 'live');
      const approx = async () =>
        (
          await db.query<{ a: string }[]>(
            `SELECT ST_AsText(p.approx_location) AS a FROM listings l
             JOIN properties p ON p.id = l.property_id WHERE l.id = $1`,
            [id],
          )
        )[0].a;
      const before = await approx();

      const { body } = await patch(who, id, { location: BOLE_AIRPORT }).expect(
        200,
      );

      expect(body.status).toBe('pending_review');
      expect(await approx()).not.toBe(before);
    });

    describe('expired (L6)', () => {
      it('rent applies and is recorded; nothing needs review yet', async () => {
        const who = await lister();
        const id = await listing(who, 'expired');

        const { body } = await patch(who, id, {
          monthlyRentBirr: 20000,
        }).expect(200);

        expect(body).toMatchObject({ status: 'expired', needsReview: false });
        expect((await history(id))[0]).toMatchObject({ event: 'monthly_rent' });
      });

      it('a field that needs review applies and sets needsReview; it stays expired', async () => {
        const who = await lister();
        const id = await listing(who, 'expired');

        const { body } = await patch(who, id, { bedrooms: 4 }).expect(200);

        expect(body).toMatchObject({
          status: 'expired',
          needsReview: true,
          version: 2,
        });
        expect(await history(id)).toEqual([]);
      });
    });

    it.each(['rented', 'removed'])(
      '%s: no edits (relist instead): 409 INVALID_LISTING_STATE',
      async (status) => {
        const who = await lister();
        const id = await listing(who, status);

        const { body } = await patch(who, id, { monthlyRentBirr: 1 }).expect(
          409,
        );

        expect(body.code).toBe('INVALID_LISTING_STATE');
      },
    );

    describe('outside draft, a required field cannot be emptied (decided 2026-11-24)', () => {
      it.each([
        ['live', { description: null }, ['description']],
        ['live', { location: null }, ['location']],
        ['pending_review', { monthlyRentBirr: null }, ['monthlyRentBirr']],
        [
          'rejected',
          { landmark: null, negotiable: null },
          ['landmark', 'negotiable'],
        ],
        ['expired', { listerRelation: null }, ['listerRelation']],
      ] as [string, object, string[]][])(
        '%s with %j: 400 LISTING_INCOMPLETE, nothing changed',
        async (status, change, missing) => {
          const who = await lister();
          const id = await listing(who, status);

          const { body } = await patch(who, id, change).expect(400);

          expect(body).toEqual({ code: 'LISTING_INCOMPLETE', missing });
          expect(await row(id)).toMatchObject({ status, version: 1 });
        },
      );

      it('an optional field can be emptied (and on a live listing, that needs review)', async () => {
        const who = await lister();
        const id = await listing(who, 'live');

        const { body } = await patch(who, id, { sizeM2: null }).expect(200);

        expect(body).toMatchObject({
          status: 'pending_review',
          property: { sizeM2: null },
        });
      });

      it('a draft may still be emptied', async () => {
        const who = await lister();
        const id = await listing(who, 'draft');

        await patch(who, id, { description: null }).expect(200);
      });
    });
  });

  describe('POST /listings/:id/reopen (L6)', () => {
    it('no change that needs review: straight back to live; a confirmation; published_at kept', async () => {
      const who = await lister();
      const id = await listing(who, 'expired');
      const before = await row(id);

      const { body } = await reopen(who, id).expect(200);

      expect(body.status).toBe('live');
      const after = await row(id);
      expect(after.last_confirmed_at).not.toBeNull();
      expect(after.published_at).toEqual(before.published_at);
      expect(after.version).toBe(1);
      expect(await history(id)).toEqual([
        expect.objectContaining({
          old_status: 'expired',
          new_status: 'live',
          actor_id: who.userId,
        }),
      ]);
    });

    it('after an edit that needs review: to pending_review, and needsReview is cleared', async () => {
      const who = await lister();
      const id = await listing(who, 'expired');
      await patch(who, id, { description: 'Renovated.' }).expect(200);

      const { body } = await reopen(who, id).expect(200);

      expect(body).toMatchObject({
        status: 'pending_review',
        needsReview: false,
      });
      expect((await row(id)).submitted_at).not.toBeNull();
    });

    it('never approved (published_at empty): to pending_review (L4; decided 2026-11-24)', async () => {
      const who = await lister();
      const id = await listing(who, 'expired', { published: false });

      const { body } = await reopen(who, id).expect(200);

      expect(body.status).toBe('pending_review');
    });

    describe('checks L2, like submitting', () => {
      it('not verified: 403 VERIFICATION_REQUIRED', async () => {
        const who = await lister();
        const id = await listing(who, 'expired');
        await db.query(
          `UPDATE users SET verification_status = 'not_verified' WHERE id = $1`,
          [who.userId],
        );

        const { body } = await reopen(who, id).expect(403);

        expect(body.code).toBe('VERIFICATION_REQUIRED');
      });

      it('fewer than 3 photos: 400 NOT_ENOUGH_PHOTOS', async () => {
        const who = await lister();
        const id = await listing(who, 'expired');
        photos.photos = 2;

        const { body } = await reopen(who, id).expect(400);

        expect(body.code).toBe('NOT_ENOUGH_PHOTOS');
      });

      it('at the active cap: 409 ACTIVE_LISTING_LIMIT', async () => {
        const who = await lister();
        for (let i = 0; i < 10; i++) await listing(who, 'live');
        const id = await listing(who, 'expired');

        const { body } = await reopen(who, id).expect(409);

        expect(body.code).toBe('ACTIVE_LISTING_LIMIT');
      });
    });

    it.each([
      'draft',
      'pending_review',
      'live',
      'stale',
      'rejected',
      'rented',
      'removed',
    ])(
      'a %s listing cannot be reopened: 409 INVALID_LISTING_STATE',
      async (status) => {
        const who = await lister();
        const id = await listing(who, status);

        const { body } = await reopen(who, id).expect(409);

        expect(body.code).toBe('INVALID_LISTING_STATE');
      },
    );

    it("L3: someone else's listing is 404 LISTING_NOT_FOUND", async () => {
      const id = await listing(await lister(), 'expired');

      const { body } = await reopen(await lister(), id).expect(404);

      expect(body.code).toBe('LISTING_NOT_FOUND');
    });

    it('two reopens at the same moment: one 200, one 409', async () => {
      const who = await lister();
      const id = await listing(who, 'expired');

      const results = await Promise.all([reopen(who, id), reopen(who, id)]);

      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 409,
      ]);
    });
  });

  describe('expiring while in review (decided 2026-11-24)', () => {
    it.each([
      ['pending_review', true],
      ['live', false],
      ['stale', false],
    ])(
      'the database marks needs_review when a %s listing expires: %s',
      async (status, expected) => {
        const who = await lister();
        const id = await listing(who, status);

        await db.query(`UPDATE listings SET status = 'expired' WHERE id = $1`, [
          id,
        ]);

        expect((await row(id)).needs_review).toBe(expected);
      },
    );

    it('live → edit → pending_review → ban → unban → reopen → pending_review, not live', async () => {
      const who = await lister();
      // A real approved verification: unban recomputes the status from it (a status set only by
      // SQL would come back not_verified).
      await db.query(
        `INSERT INTO identity_verifications
           (user_id, provider_session_id, provider_status, outcome, verified_name, date_of_birth)
         VALUES ($1, 'session-ban-path', 'Approved', 'approved', 'Abebe Kebede', '1990-05-17')`,
        [who.userId],
      );
      const id = await listing(who, 'live');
      await patch(who, id, { description: 'Bigger kitchen now.' }).expect(200);
      expect((await row(id)).status).toBe('pending_review');

      const staff = async (role: string) => {
        const admin = await createTestAdmin(db, { role });
        const { body } = await http()
          .post('/admin/auth/login')
          .send({ email: admin.email, password: admin.password })
          .expect(200);
        return { Authorization: `Bearer ${body.accessToken}` };
      };
      // Signed in before building the requests below (supertest starts a server per request).
      const moderator = await staff('moderator');
      const superAdmin = await staff('super_admin');
      await http()
        .post(`/admin/users/${who.userId}/ban`)
        .set(moderator)
        .send({ reason: 'Suspected fake listing' })
        .expect(200);
      // The ban doesn't expire listings yet: that's T7.1 (L8), which must drop this line.
      await db.query(`UPDATE listings SET status = 'expired' WHERE id = $1`, [
        id,
      ]);
      await http()
        .post(`/admin/users/${who.userId}/unban`)
        .set(superAdmin)
        .send({ note: 'Appeal accepted' })
        .expect(200);
      // The ban revoked every session; sign in again.
      const { accessToken } = await signIn(app, sms, who.phone);

      const { body } = await reopen({ ...who, token: accessToken }, id).expect(
        200,
      );

      expect(body.status).toBe('pending_review');
    });
  });
});
