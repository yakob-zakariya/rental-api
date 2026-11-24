import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { PhotoStorage } from '../src/modules/photos/photo-storage.js';
import { PublicCache } from '../src/modules/photos/public-cache.js';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { FakePublicCache } from './fakes/fake-public-cache.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { UnlimitedThrottlerStorage } from './fakes/unlimited-throttler-storage.js';
import { createTestAdmin } from './utils/admins.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import { boleNeighbourhoodId, fullListing } from './utils/listings.js';
import { plainImage } from './utils/photos.js';
import { signIn } from './utils/sign-in.js';

// Staff decisions: approve, reject, take down (spec R2–R5; T4.2), and the rule that a listing's
// photos are public only while it is live (P5), with real uploads against the local SeaweedFS.

interface Lister {
  token: string;
  userId: string;
}
type Auth = { Authorization: string };

describe('admin: approve, reject, take down (e2e, T4.2)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let storage: PhotoStorage;
  const sms = new FakeSmsSender();
  const cdn = new FakePublicCache();
  let counter = 0;
  let photo: Buffer;
  let support: Auth;
  let moderator: Auth & { id: string };

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b
        .overrideProvider(SmsSender)
        .useValue(sms)
        .overrideProvider(PublicCache)
        .useValue(cdn)
        .overrideProvider(ThrottlerStorage)
        .useValue(new UnlimitedThrottlerStorage()),
    );
    db = app.get(DataSource);
    storage = app.get(PhotoStorage);
    photo = await plainImage(64, 48);
  });

  beforeEach(async () => {
    support = await staff('support');
    moderator = await staff('moderator');
    cdn.purged = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function staff(role: string) {
    const admin = await createTestAdmin(db, { role });
    const { body } = await http()
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password })
      .expect(200);
    return { id: admin.id, Authorization: `Bearer ${body.accessToken}` };
  }

  const lister = async (): Promise<Lister> => {
    const phone = `+2519210000${String(++counter).padStart(2, '0')}`;
    const { accessToken } = await signIn(app, sms, phone);
    await db.query(
      `UPDATE users SET verification_status = 'approved', full_name = 'Abebe Kebede' WHERE phone = $1`,
      [phone],
    );
    const [{ id }] = await db.query<{ id: string }[]>(
      `SELECT id FROM users WHERE phone = $1`,
      [phone],
    );
    return { token: accessToken, userId: id };
  };
  const as = (who: Lister) => ({ Authorization: `Bearer ${who.token}` });

  /** A real listing in review: a complete draft, 3 uploaded photos, submitted. */
  const inReview = async (who: Lister) => {
    const { body: draft } = await http()
      .post('/listings')
      .set(as(who))
      .send(fullListing(await boleNeighbourhoodId(db)))
      .expect(201);
    for (let i = 0; i < 3; i++)
      await http()
        .post(`/properties/${draft.property.id}/photos`)
        .set(as(who))
        .attach('photo', photo, 'p.jpg')
        .expect(201);
    const { body } = await http()
      .post(`/listings/${draft.id}/submit`)
      .set(as(who))
      .expect(200);
    return {
      id: body.id as string,
      propertyId: body.property.id as string,
      version: body.version as number,
    };
  };

  const approve = (auth: Auth, id: string, body: object) =>
    http().post(`/admin/listings/${id}/approve`).set(auth).send(body);
  const reject = (auth: Auth, id: string, body: object) =>
    http().post(`/admin/listings/${id}/reject`).set(auth).send(body);
  const takedown = (auth: Auth, id: string, body: object) =>
    http().post(`/admin/listings/${id}/takedown`).set(auth).send(body);

  /** Approved and live; returns the listing. */
  const live = async (who: Lister) => {
    const listing = await inReview(who);
    await approve(moderator, listing.id, { version: listing.version }).expect(
      200,
    );
    return listing;
  };

  const keysOf = async (propertyId: string) =>
    (
      await db.query<{ storage_key: string }[]>(
        `SELECT storage_key FROM property_photos WHERE property_id = $1 ORDER BY position`,
        [propertyId],
      )
    ).map((r) => r.storage_key);
  /** HTTP status of each photo at its public URL, fetched with no credentials. */
  const publicStatus = async (propertyId: string) =>
    Promise.all(
      (await keysOf(propertyId)).map(
        async (key) => (await fetch(storage.publicUrl(key))).status,
      ),
    );
  const row = async (id: string) =>
    (
      await db.query<Record<string, unknown>[]>(
        `SELECT status, version, published_at, last_confirmed_at, reviewed_by_admin_id,
                staff_reason_code, lister_note, close_reason, closed_at
         FROM listings WHERE id = $1`,
        [id],
      )
    )[0];
  const audits = (action: string) =>
    db.query<{ admin_id: string; target_id: string; details: unknown }[]>(
      `SELECT admin_id, target_id, details FROM admin_actions WHERE action = $1`,
      [action],
    );
  const lastHistory = async (id: string) =>
    (
      await db.query<Record<string, unknown>[]>(
        `SELECT old_status, new_status, close_reason, staff_reason_code, actor_type, actor_id
         FROM listing_history WHERE listing_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
        [id],
      )
    )[0];
  const setStatus = (id: string, status: string) =>
    db.query(
      `UPDATE listings SET status = $2::listing_status,
         close_reason = CASE $2::text WHEN 'rented' THEN 'rented_elsewhere'::listing_close_reason
                                      WHEN 'removed' THEN 'no_longer_for_rent'::listing_close_reason END,
         closed_at = CASE WHEN $2::text IN ('rented', 'removed') THEN now() END
       WHERE id = $1`,
      [id, status],
    );

  describe('POST /admin/listings/:id/approve (R2–R4)', () => {
    it('pending_review → live: published, reviewed by, history and audit; the photos become public', async () => {
      const who = await lister();
      const listing = await inReview(who);
      expect(await publicStatus(listing.propertyId)).toEqual([404, 404, 404]);

      const { body } = await approve(moderator, listing.id, {
        version: listing.version,
        note: 'Photos match the description',
      }).expect(200);

      expect(body.status).toBe('live');
      expect(await row(listing.id)).toMatchObject({
        status: 'live',
        reviewed_by_admin_id: moderator.id,
        published_at: expect.any(Date),
        last_confirmed_at: expect.any(Date),
      });
      expect(await lastHistory(listing.id)).toEqual({
        old_status: 'pending_review',
        new_status: 'live',
        close_reason: null,
        staff_reason_code: null,
        actor_type: 'admin',
        actor_id: moderator.id,
      });
      expect(await audits('listing.approve')).toEqual([
        {
          admin_id: moderator.id,
          target_id: listing.id,
          details: { note: 'Photos match the description' },
        },
      ]);
      expect(await publicStatus(listing.propertyId)).toEqual([200, 200, 200]);
    });

    it('support may not decide (403); an app token gets 401', async () => {
      const who = await lister();
      const listing = await inReview(who);

      const { body } = await approve(support, listing.id, {
        version: listing.version,
      }).expect(403);
      expect(body.code).toBe('INSUFFICIENT_ROLE');
      await approve(as(who), listing.id, { version: listing.version }).expect(
        401,
      );
    });

    it('R2: the lister changed it meanwhile: 409 LISTING_CHANGED with the current version; the new one works', async () => {
      const who = await lister();
      const listing = await inReview(who);
      await http()
        .patch(`/listings/${listing.id}`)
        .set(as(who))
        .send({ description: 'Now with new curtains.' })
        .expect(200);

      const { body } = await approve(moderator, listing.id, {
        version: listing.version,
      }).expect(409);

      expect(body).toEqual({
        code: 'LISTING_CHANGED',
        version: listing.version + 1,
      });
      await approve(moderator, listing.id, { version: body.version }).expect(
        200,
      );
    });

    it.each(['live', 'rejected'])(
      'already %s: 409 ALREADY_DECIDED',
      async (status) => {
        const who = await lister();
        const listing = await inReview(who);
        await setStatus(listing.id, status);

        const { body } = await approve(moderator, listing.id, {
          version: listing.version,
        }).expect(409);

        expect(body.code).toBe('ALREADY_DECIDED');
      },
    );

    it.each(['draft', 'stale', 'expired', 'rented', 'removed'])(
      '%s: 409 LISTING_NOT_REVIEWABLE',
      async (status) => {
        const who = await lister();
        const listing = await inReview(who);
        await setStatus(listing.id, status);

        const { body } = await approve(moderator, listing.id, {
          version: listing.version,
        }).expect(409);

        expect(body.code).toBe('LISTING_NOT_REVIEWABLE');
      },
    );

    it('two reviewers at the same moment: one approves, the other gets ALREADY_DECIDED', async () => {
      const who = await lister();
      const listing = await inReview(who);
      const other = await staff('moderator');

      const results = await Promise.all([
        approve(moderator, listing.id, { version: listing.version }),
        reject(other, listing.id, {
          version: listing.version,
          reasonCode: 'PHOTOS_UNCLEAR',
          note: 'Dark photos',
        }),
      ]);

      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 409,
      ]);
      expect(results.find((r) => r.status === 409)?.body.code).toBe(
        'ALREADY_DECIDED',
      );
    });

    describe('R3: the lister is checked again', () => {
      it.each([
        ['banned', `UPDATE users SET status = 'banned' WHERE id = $1`],
        [
          'no longer verified',
          `UPDATE users SET verification_status = 'blocked' WHERE id = $1`,
        ],
      ])('%s: 409 LISTER_NOT_ELIGIBLE, still in review', async (_name, sql) => {
        const who = await lister();
        const listing = await inReview(who);
        await db.query(sql, [who.userId]);

        const { body } = await approve(moderator, listing.id, {
          version: listing.version,
        }).expect(409);

        expect(body.code).toBe('LISTER_NOT_ELIGIBLE');
        expect((await row(listing.id)).status).toBe('pending_review');
      });

      it('over the active cap (e.g. the cap was lowered): 409 ACTIVE_LISTING_LIMIT', async () => {
        const who = await lister();
        const listing = await inReview(who);
        // 10 more live listings, each on its own property (L10): 11 active with this one.
        for (let i = 0; i < 10; i++) {
          const [{ id: propertyId }] = await db.query<{ id: string }[]>(
            `INSERT INTO properties (lister_id) VALUES ($1) RETURNING id`,
            [who.userId],
          );
          await db.query(
            `INSERT INTO listings (property_id, status, monthly_rent_birr, advance_months, negotiable, available_from)
             VALUES ($1, 'live', 1000, 1, false, '2027-01-01')`,
            [propertyId],
          );
        }

        const { body } = await approve(moderator, listing.id, {
          version: listing.version,
        }).expect(409);

        expect(body).toEqual({ code: 'ACTIVE_LISTING_LIMIT', max: 10 });
      });
    });

    it('re-approving an edited listing keeps the original published_at and restarts the freshness clock (decided 2026-11-24)', async () => {
      const who = await lister();
      const listing = await live(who);
      const first = await row(listing.id);
      const { body: edited } = await http()
        .patch(`/listings/${listing.id}`)
        .set(as(who))
        .send({ description: 'Repainted.' })
        .expect(200);
      expect(edited.status).toBe('pending_review');

      await approve(moderator, listing.id, { version: edited.version }).expect(
        200,
      );

      const second = await row(listing.id);
      expect(second.published_at).toEqual(first.published_at);
      expect((second.last_confirmed_at as Date).getTime()).toBeGreaterThan(
        (first.last_confirmed_at as Date).getTime(),
      );
    });

    it('if storage fails, the approval fails (503 STORAGE_UNAVAILABLE) and the listing stays in review', async () => {
      const who = await lister();
      const listing = await inReview(who);
      vi.spyOn(storage, 'publish').mockRejectedValueOnce(new Error('down'));

      const { body } = await approve(moderator, listing.id, {
        version: listing.version,
      }).expect(503);

      expect(body).toEqual({ code: 'STORAGE_UNAVAILABLE' });
      expect((await row(listing.id)).status).toBe('pending_review');
      expect(await audits('listing.approve')).toEqual([]);
    });
  });

  describe('POST /admin/listings/:id/reject (R2, R4)', () => {
    it('pending_review → rejected: the lister sees the reason and the note; staff note only in the audit', async () => {
      const who = await lister();
      const listing = await inReview(who);

      const { body } = await reject(moderator, listing.id, {
        version: listing.version,
        reasonCode: 'PHOTOS_UNCLEAR',
        listerNote: 'Please add brighter photos of the kitchen',
        note: 'Photos 2 and 3 are too dark',
      }).expect(200);

      expect(body.status).toBe('rejected');
      const { body: mine } = await http()
        .get('/me/listings')
        .set(as(who))
        .expect(200);
      expect(mine[0]).toMatchObject({
        status: 'rejected',
        staffReasonCode: 'PHOTOS_UNCLEAR',
        listerNote: 'Please add brighter photos of the kitchen',
      });
      expect(JSON.stringify(mine)).not.toContain('too dark');
      expect(await lastHistory(listing.id)).toMatchObject({
        new_status: 'rejected',
        staff_reason_code: 'PHOTOS_UNCLEAR',
        actor_type: 'admin',
      });
      expect(await audits('listing.reject')).toEqual([
        {
          admin_id: moderator.id,
          target_id: listing.id,
          details: {
            reasonCode: 'PHOTOS_UNCLEAR',
            note: 'Photos 2 and 3 are too dark',
            listerNote: 'Please add brighter photos of the kitchen',
          },
        },
      ]);
      expect(await publicStatus(listing.propertyId)).toEqual([404, 404, 404]);
    });

    it('GUIDELINES with a lister note: 400 LISTER_NOTE_NOT_ALLOWED (decided 2026-11-24); without one, fine', async () => {
      const who = await lister();
      const listing = await inReview(who);

      const { body } = await reject(moderator, listing.id, {
        version: listing.version,
        reasonCode: 'GUIDELINES',
        listerNote: 'We think this is a fake listing',
        note: 'Same photos as a known scam',
      }).expect(400);
      expect(body).toEqual({ code: 'LISTER_NOTE_NOT_ALLOWED' });
      expect((await row(listing.id)).status).toBe('pending_review');

      await reject(moderator, listing.id, {
        version: listing.version,
        reasonCode: 'GUIDELINES',
        note: 'Same photos as a known scam',
      }).expect(200);
    });

    it.each([
      ['no staff note', { reasonCode: 'PHOTOS_UNCLEAR' }],
      ['an unknown reason code', { reasonCode: 'UGLY', note: 'x' }],
      [
        'a lister note over 300 characters',
        {
          reasonCode: 'PHOTOS_UNCLEAR',
          note: 'x',
          listerNote: 'x'.repeat(301),
        },
      ],
    ])('refuses %s: 400 VALIDATION_FAILED', async (_name, fields) => {
      const who = await lister();
      const listing = await inReview(who);

      const { body } = await reject(moderator, listing.id, {
        version: listing.version,
        ...fields,
      }).expect(400);

      expect(body.code).toBe('VALIDATION_FAILED');
    });

    it.each(['note', 'listerNote'])(
      'an ID number in the %s: 400 NOTE_CONTAINS_ID_NUMBER, nothing changed (S1)',
      async (field) => {
        const who = await lister();
        const listing = await inReview(who);

        const { body } = await reject(moderator, listing.id, {
          version: listing.version,
          reasonCode: 'MISSING_INFORMATION',
          note: 'Checked',
          [field]: 'FIN 1234 5678 9012',
        }).expect(400);

        expect(body.code).toBe('NOTE_CONTAINS_ID_NUMBER');
        expect((await row(listing.id)).status).toBe('pending_review');
      },
    );

    it('a rejected listing can be fixed and resubmitted (L4), then approved', async () => {
      const who = await lister();
      const listing = await inReview(who);
      await reject(moderator, listing.id, {
        version: listing.version,
        reasonCode: 'MISSING_INFORMATION',
        note: 'No size',
      }).expect(200);

      const { body: resubmitted } = await http()
        .post(`/listings/${listing.id}/submit`)
        .set(as(who))
        .expect(200);

      await approve(moderator, listing.id, {
        version: resubmitted.version,
      }).expect(200);
    });
  });

  describe('POST /admin/listings/:id/takedown (R5)', () => {
    it('live → removed (staff_takedown): photos unpublished and the CDN purged for each', async () => {
      const who = await lister();
      const listing = await live(who);
      expect(await publicStatus(listing.propertyId)).toEqual([200, 200, 200]);

      const { body } = await takedown(moderator, listing.id, {
        reasonCode: 'GUIDELINES',
        note: 'Reported as a scam; photos copied',
      }).expect(200);

      expect(body.status).toBe('removed');
      expect(await row(listing.id)).toMatchObject({
        status: 'removed',
        close_reason: 'staff_takedown',
        staff_reason_code: 'GUIDELINES',
        lister_note: null,
        closed_at: expect.any(Date),
      });
      expect(await lastHistory(listing.id)).toMatchObject({
        old_status: 'live',
        new_status: 'removed',
        close_reason: 'staff_takedown',
        staff_reason_code: 'GUIDELINES',
        actor_type: 'admin',
      });
      expect(await audits('listing.takedown')).toHaveLength(1);
      expect(await publicStatus(listing.propertyId)).toEqual([404, 404, 404]);
      expect(cdn.purged.sort()).toEqual(
        (await keysOf(listing.propertyId))
          .map((k) => storage.publicUrl(k))
          .sort(),
      );
    });

    it('stale can be taken down too', async () => {
      const who = await lister();
      const listing = await live(who);
      await setStatus(listing.id, 'stale');

      await takedown(moderator, listing.id, {
        reasonCode: 'DUPLICATE_LISTING',
        listerNote: 'This home is already listed by you',
        note: 'Duplicate of an earlier one',
      }).expect(200);
    });

    it.each([
      'draft',
      'pending_review',
      'rejected',
      'expired',
      'rented',
      'removed',
    ])('%s: 409 LISTING_NOT_REVIEWABLE', async (status) => {
      const who = await lister();
      const listing = await inReview(who);
      await setStatus(listing.id, status);

      const { body } = await takedown(moderator, listing.id, {
        reasonCode: 'GUIDELINES',
        note: 'x',
      }).expect(409);

      expect(body.code).toBe('LISTING_NOT_REVIEWABLE');
    });

    it('GUIDELINES with a lister note: 400 LISTER_NOTE_NOT_ALLOWED', async () => {
      const listing = await live(await lister());

      const { body } = await takedown(moderator, listing.id, {
        reasonCode: 'GUIDELINES',
        listerNote: 'Fraud',
        note: 'x',
      }).expect(400);

      expect(body.code).toBe('LISTER_NOTE_NOT_ALLOWED');
    });
  });

  describe('P5: photos are public only while the listing is live', () => {
    it('an edit that sends a live listing back to review unpublishes them', async () => {
      const who = await lister();
      const listing = await live(who);

      await http()
        .patch(`/listings/${listing.id}`)
        .set(as(who))
        .send({ bedrooms: 3 })
        .expect(200);

      expect(await publicStatus(listing.propertyId)).toEqual([404, 404, 404]);
    });

    it('a rent change keeps them public (the listing stays live)', async () => {
      const who = await lister();
      const listing = await live(who);

      await http()
        .patch(`/listings/${listing.id}`)
        .set(as(who))
        .send({ monthlyRentBirr: 24000 })
        .expect(200);

      expect(await publicStatus(listing.propertyId)).toEqual([200, 200, 200]);
    });

    it('a new photo on a live listing sends it to review and unpublishes them all', async () => {
      const who = await lister();
      const listing = await live(who);

      await http()
        .post(`/properties/${listing.propertyId}/photos`)
        .set(as(who))
        .attach('photo', photo, 'p.jpg')
        .expect(201);

      expect(await publicStatus(listing.propertyId)).toEqual([
        404, 404, 404, 404,
      ]);
    });

    it('the lister closing a live listing unpublishes them (no CDN purge: only takedowns)', async () => {
      const who = await lister();
      const listing = await live(who);

      await http()
        .post(`/listings/${listing.id}/close`)
        .set(as(who))
        .send({ reason: 'rented_in_app' })
        .expect(200);

      expect(await publicStatus(listing.propertyId)).toEqual([404, 404, 404]);
      expect(cdn.purged).toEqual([]);
    });

    it('reopening an expired listing straight to live publishes them again', async () => {
      const who = await lister();
      const listing = await live(who);
      await setStatus(listing.id, 'expired');
      for (const key of await keysOf(listing.propertyId))
        await storage.unpublish(key);

      const { body } = await http()
        .post(`/listings/${listing.id}/reopen`)
        .set(as(who))
        .expect(200);

      expect(body.status).toBe('live');
      expect(await publicStatus(listing.propertyId)).toEqual([200, 200, 200]);
    });
  });
});
