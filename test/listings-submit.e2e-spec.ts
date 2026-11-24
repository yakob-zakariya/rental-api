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
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import {
  addisDate,
  boleNeighbourhoodId,
  fullListing,
} from './utils/listings.js';
import { signIn } from './utils/sign-in.js';

// Submit and withdraw (spec L2, L4, L9; T2.3). Photos don't exist until Step 3, so a fake counter
// stands in: every property has 3 unless a test says otherwise.

interface Lister {
  token: string;
  userId: string;
}

describe('listings: submit and withdraw (e2e, T2.3)', () => {
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
        // Many requests from the one test IP.
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

  /** A signed-in user; verified (approved) unless told otherwise. */
  const lister = async ({
    verification = 'approved',
  } = {}): Promise<Lister> => {
    const phone = `+2519160000${String(++counter).padStart(2, '0')}`;
    const { accessToken } = await signIn(app, sms, phone);
    await db.query(
      `UPDATE users SET verification_status = $2 WHERE phone = $1`,
      [phone, verification],
    );
    const [{ id }] = await db.query<{ id: string }[]>(
      `SELECT id FROM users WHERE phone = $1`,
      [phone],
    );
    return { token: accessToken, userId: id };
  };

  const http = () => request(app.getHttpServer());
  const auth = (who: Lister) => ({ Authorization: `Bearer ${who.token}` });
  const draft = async (who: Lister, body: object = full): Promise<string> =>
    (await http().post('/listings').set(auth(who)).send(body).expect(201)).body
      .id;
  const submit = (who: Lister, id: string) =>
    http().post(`/listings/${id}/submit`).set(auth(who));
  const withdraw = (who: Lister, id: string) =>
    http().post(`/listings/${id}/withdraw`).set(auth(who));

  const propertyOf = async (listingId: string): Promise<string> =>
    (
      await db.query<{ property_id: string }[]>(
        `SELECT property_id FROM listings WHERE id = $1`,
        [listingId],
      )
    )[0].property_id;

  /** Puts a complete listing straight into a state (closed ones get a reason, as the DB requires). */
  const setStatus = (listingId: string, status: string) =>
    db.query(
      `UPDATE listings SET status = $2::listing_status,
         close_reason = CASE $2::text
           WHEN 'rented' THEN 'rented_elsewhere'::listing_close_reason
           WHEN 'removed' THEN 'no_longer_for_rent'::listing_close_reason END,
         closed_at = CASE WHEN $2::text IN ('rented', 'removed') THEN now() END
       WHERE id = $1`,
      [listingId, status],
    );

  const history = (listingId: string) =>
    db.query<
      { old_status: string | null; new_status: string; actor_id: string }[]
    >(
      `SELECT old_status, new_status, actor_id FROM listing_history
       WHERE listing_id = $1 AND event = 'status' ORDER BY created_at, id`,
      [listingId],
    );

  describe('POST /listings/:id/submit', () => {
    it('a complete draft goes to review: pending_review, submittedAt set, version unchanged, history row', async () => {
      const who = await lister();
      const id = await draft(who);

      const { body } = await submit(who, id).expect(200);

      expect(body).toMatchObject({
        status: 'pending_review',
        version: 1,
        missing: [],
      });
      expect(body.submittedAt).toEqual(expect.any(String));
      expect(await history(id)).toEqual([
        { old_status: null, new_status: 'draft', actor_id: who.userId },
        {
          old_status: 'draft',
          new_status: 'pending_review',
          actor_id: who.userId,
        },
      ]);
    });

    it('L4: a rejected listing can be fixed and sent back to review; the last staff decision stays visible', async () => {
      const who = await lister();
      const id = await draft(who);
      await setStatus(id, 'rejected');
      await db.query(
        `UPDATE listings SET staff_reason_code = 'PHOTOS_UNCLEAR', lister_note = 'Brighter photos please'
         WHERE id = $1`,
        [id],
      );

      const { body } = await submit(who, id).expect(200);

      expect(body).toMatchObject({
        status: 'pending_review',
        staffReasonCode: 'PHOTOS_UNCLEAR',
        listerNote: 'Brighter photos please',
      });
      expect((await history(id)).at(-1)).toMatchObject({
        old_status: 'rejected',
        new_status: 'pending_review',
      });
    });

    it.each([
      'pending_review',
      'live',
      'stale',
      'expired',
      'rented',
      'removed',
    ])(
      'a %s listing cannot be submitted: 409 INVALID_LISTING_STATE',
      async (status) => {
        const who = await lister();
        const id = await draft(who);
        await setStatus(id, status);

        const { body } = await submit(who, id).expect(409);

        expect(body.code).toBe('INVALID_LISTING_STATE');
      },
    );

    describe('L2: the checks', () => {
      it.each([
        'not_verified',
        'pending',
        'manual_review',
        'declined',
        'blocked',
      ])(
        'a lister whose verification is %s: 403 VERIFICATION_REQUIRED',
        async (verification) => {
          const who = await lister({ verification });
          const id = await draft(who);

          const { body } = await submit(who, id).expect(403);

          expect(body).toEqual({ code: 'VERIFICATION_REQUIRED' });
        },
      );

      it('verification is checked first, before completeness', async () => {
        const who = await lister({ verification: 'not_verified' });
        const id = await draft(who, {});

        const { body } = await submit(who, id).expect(403);

        expect(body.code).toBe('VERIFICATION_REQUIRED');
      });

      it('an incomplete listing: 400 LISTING_INCOMPLETE with exactly what is missing', async () => {
        const who = await lister();
        const id = await draft(who, {
          ...full,
          landmark: undefined,
          availableFrom: undefined,
        });

        const { body } = await submit(who, id).expect(400);

        expect(body).toEqual({
          code: 'LISTING_INCOMPLETE',
          missing: ['landmark', 'availableFrom'],
        });
      });

      it('size, floor, amenities and the typed neighbourhood name are not needed', async () => {
        const who = await lister();
        const id = await draft(who, {
          ...full,
          sizeM2: undefined,
          floor: undefined,
          amenities: [],
        });

        await submit(who, id).expect(200);
      });

      it('fewer than 3 photos: 400 NOT_ENOUGH_PHOTOS with min 3; 3 is enough', async () => {
        const who = await lister();
        const id = await draft(who);
        photos.set(await propertyOf(id), 2);

        const { body } = await submit(who, id).expect(400);
        expect(body).toEqual({ code: 'NOT_ENOUGH_PHOTOS', min: 3 });

        photos.set(await propertyOf(id), 3);
        await submit(who, id).expect(200);
      });

      it('completeness is checked before photos', async () => {
        const who = await lister();
        const id = await draft(who, {});
        photos.set(await propertyOf(id), 0);

        const { body } = await submit(who, id).expect(400);

        expect(body.code).toBe('LISTING_INCOMPLETE');
      });

      it('at the cap of 10 active listings: 409 ACTIVE_LISTING_LIMIT with max', async () => {
        const who = await lister();
        const statuses = ['pending_review', 'live', 'stale'];
        for (let i = 0; i < 10; i++)
          await setStatus(await draft(who), statuses[i % 3]);
        const id = await draft(who);

        const { body } = await submit(who, id).expect(409);

        expect(body).toEqual({ code: 'ACTIVE_LISTING_LIMIT', max: 10 });
      });

      it('only pending_review, live and stale count toward the cap, and only your own', async () => {
        const who = await lister();
        for (let i = 0; i < 9; i++) await setStatus(await draft(who), 'live');
        for (const status of ['expired', 'rented', 'removed', 'rejected'])
          await setStatus(await draft(who), status);
        const other = await lister();
        for (let i = 0; i < 3; i++) await setStatus(await draft(other), 'live');

        await submit(who, await draft(who)).expect(200);
      });

      it('two submits at the same moment cannot both get under the cap', async () => {
        const who = await lister();
        for (let i = 0; i < 9; i++) await setStatus(await draft(who), 'live');
        const [a, b] = [await draft(who), await draft(who)];

        const results = await Promise.all([submit(who, a), submit(who, b)]);

        expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
          200, 409,
        ]);
      });
    });

    it('the same listing submitted twice at once: one 200, one 409, one history row', async () => {
      const who = await lister();
      const id = await draft(who);

      const results = await Promise.all([submit(who, id), submit(who, id)]);

      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
        200, 409,
      ]);
      expect(
        (await history(id)).filter((h) => h.new_status === 'pending_review'),
      ).toHaveLength(1);
    });

    it('an available-from date that has passed since it was set is allowed (decided 2026-11-23)', async () => {
      const who = await lister();
      const id = await draft(who);
      await db.query(`UPDATE listings SET available_from = $2 WHERE id = $1`, [
        id,
        addisDate(-14),
      ]);

      await submit(who, id).expect(200);
    });

    it('G8: a neighbourhood staff deactivated after it was picked does not block submitting', async () => {
      const who = await lister();
      const id = await draft(who);
      await db.query(
        `UPDATE neighbourhoods SET deactivated_at = now() WHERE id = $1`,
        [full.neighbourhoodId],
      );

      await submit(who, id).expect(200);
    });

    it('in review it can still be edited (it stays in review, L5) but not deleted', async () => {
      const who = await lister();
      const id = await draft(who);
      await submit(who, id).expect(200);

      const { body } = await http()
        .patch(`/listings/${id}`)
        .set(auth(who))
        .send({ bedrooms: 3 })
        .expect(200);
      expect(body.status).toBe('pending_review');
      await http().delete(`/listings/${id}`).set(auth(who)).expect(409);
    });
  });

  describe('POST /listings/:id/withdraw', () => {
    it('takes a listing out of review, back to draft, with a history row; it can then be edited and resubmitted', async () => {
      const who = await lister();
      const id = await draft(who);
      await submit(who, id).expect(200);

      const { body } = await withdraw(who, id).expect(200);

      expect(body.status).toBe('draft');
      expect((await history(id)).at(-1)).toEqual({
        old_status: 'pending_review',
        new_status: 'draft',
        actor_id: who.userId,
      });
      await http()
        .patch(`/listings/${id}`)
        .set(auth(who))
        .send({ bedrooms: 3 })
        .expect(200);
      await submit(who, id).expect(200);
    });

    it('is allowed even at the draft limit (decided 2026-11-23)', async () => {
      const who = await lister();
      const inReview = await draft(who);
      await submit(who, inReview).expect(200);
      for (let i = 0; i < 10; i++) await draft(who);

      await withdraw(who, inReview).expect(200);
    });

    it.each([
      'draft',
      'live',
      'stale',
      'expired',
      'rejected',
      'rented',
      'removed',
    ])(
      'a %s listing cannot be withdrawn: 409 INVALID_LISTING_STATE',
      async (status) => {
        const who = await lister();
        const id = await draft(who);
        if (status !== 'draft') await setStatus(id, status);

        const { body } = await withdraw(who, id).expect(409);

        expect(body.code).toBe('INVALID_LISTING_STATE');
      },
    );
  });

  describe('L3: only the lister', () => {
    it.each(['submit', 'withdraw'])(
      "%s on someone else's listing, an unknown id or a malformed id: 404 LISTING_NOT_FOUND",
      async (action) => {
        const owner = await lister();
        const id = await draft(owner);
        if (action === 'withdraw') await submit(owner, id).expect(200);
        const other = await lister();

        for (const target of [
          id,
          '00000000-0000-4000-8000-000000000000',
          'not-a-uuid',
        ]) {
          const { body } = await http()
            .post(`/listings/${target}/${action}`)
            .set(auth(other))
            .expect(404);
          expect(body.code).toBe('LISTING_NOT_FOUND');
        }
      },
    );

    it('needs a signed-in user', async () => {
      const id = await draft(await lister());

      await http().post(`/listings/${id}/submit`).expect(401);
      await http().post(`/listings/${id}/withdraw`).expect(401);
    });
  });
});

// Submitting with real photos (2 refused, 3 accepted) is in property-photos.e2e-spec.ts (T3.2).
