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

// Closing (L12) and relisting (L10, L11) (T2.5).

interface Lister {
  token: string;
  userId: string;
}

describe('listings: close and relist (e2e, T2.5)', () => {
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

  const lister = async (): Promise<Lister> => {
    const phone = `+2519180000${String(++counter).padStart(2, '0')}`;
    const { accessToken } = await signIn(app, sms, phone);
    await db.query(
      `UPDATE users SET verification_status = 'approved' WHERE phone = $1`,
      [phone],
    );
    const [{ id }] = await db.query<{ id: string }[]>(
      `SELECT id FROM users WHERE phone = $1`,
      [phone],
    );
    return { token: accessToken, userId: id };
  };

  const http = () => request(app.getHttpServer());
  const auth = (who: Lister) => ({ Authorization: `Bearer ${who.token}` });
  const close = (who: Lister, id: string, reason: unknown) =>
    http().post(`/listings/${id}/close`).set(auth(who)).send({ reason });
  const relist = (who: Lister, propertyId: string) =>
    http().post(`/properties/${propertyId}/listings`).set(auth(who));
  const mine = async (who: Lister) =>
    (await http().get('/me/listings').set(auth(who)).expect(200))
      .body as Record<string, any>[];

  /** A complete listing in `status`; published_at set for states that have been live. */
  const listing = async (
    who: Lister,
    status: string,
    {
      published = ['live', 'stale', 'expired', 'rented', 'removed'].includes(
        status,
      ),
      body = full as object,
    } = {},
  ): Promise<{ id: string; propertyId: string }> => {
    const { body: created } = await http()
      .post('/listings')
      .set(auth(who))
      .send(body)
      .expect(201);
    await db.query(
      `UPDATE listings SET status = $2::listing_status,
         published_at = CASE WHEN $3 THEN now() - interval '20 days' END,
         close_reason = CASE $2::text
           WHEN 'rented' THEN 'rented_elsewhere'::listing_close_reason
           WHEN 'removed' THEN 'no_longer_for_rent'::listing_close_reason END,
         closed_at = CASE WHEN $2::text IN ('rented', 'removed') THEN now() END
       WHERE id = $1`,
      [created.id, status, published],
    );
    return { id: created.id, propertyId: created.property.id };
  };

  const lastHistory = async (id: string) =>
    (
      await db.query<Record<string, unknown>[]>(
        `SELECT old_status, new_status, close_reason, actor_type, actor_id
         FROM listing_history WHERE listing_id = $1 ORDER BY created_at DESC, id LIMIT 1`,
        [id],
      )
    )[0];

  describe('POST /listings/:id/close (L12)', () => {
    it.each([
      ['rented_in_app', 'rented'],
      ['rented_elsewhere', 'rented'],
      ['no_longer_for_rent', 'removed'],
    ])(
      'a live listing closed with %s becomes %s, with the reason, closedAt and a history row',
      async (reason, status) => {
        const who = await lister();
        const { id } = await listing(who, 'live');

        const { body } = await close(who, id, reason).expect(200);

        expect(body).toMatchObject({ status, closeReason: reason, version: 1 });
        expect(body.closedAt).toEqual(expect.any(String));
        expect(await lastHistory(id)).toEqual({
          old_status: 'live',
          new_status: status,
          close_reason: reason,
          actor_type: 'user',
          actor_id: who.userId,
        });
      },
    );

    it.each(['pending_review', 'live', 'stale', 'expired', 'rejected'])(
      'can be closed from %s',
      async (status) => {
        const who = await lister();
        const { id } = await listing(who, status);

        const { body } = await close(who, id, 'no_longer_for_rent').expect(200);

        expect(body.status).toBe('removed');
      },
    );

    it.each(['draft', 'rented', 'removed'])(
      'a %s listing cannot be closed: 409 INVALID_LISTING_STATE',
      async (status) => {
        const who = await lister();
        const { id } = await listing(who, status);

        const { body } = await close(who, id, 'rented_elsewhere').expect(409);

        expect(body.code).toBe('INVALID_LISTING_STATE');
      },
    );

    it.each(['staff_takedown', 'sold', null])(
      'refuses the reason %j: 400 VALIDATION_FAILED (staff_takedown is staff only)',
      async (reason) => {
        const who = await lister();
        const { id } = await listing(who, 'live');

        const { body } = await close(who, id, reason).expect(400);

        expect(body.code).toBe('VALIDATION_FAILED');
      },
    );

    describe('rented_in_app needs a listing that was published (decided 2026-11-24)', () => {
      it.each(['pending_review', 'rejected', 'expired'])(
        'never published, %s: 400 RENTED_IN_APP_NEVER_PUBLISHED, nothing changed',
        async (status) => {
          const who = await lister();
          const { id } = await listing(who, status, { published: false });

          const { body } = await close(who, id, 'rented_in_app').expect(400);

          expect(body).toEqual({ code: 'RENTED_IN_APP_NEVER_PUBLISHED' });
          const [row] = await db.query<{ status: string }[]>(
            `SELECT status FROM listings WHERE id = $1`,
            [id],
          );
          expect(row.status).toBe(status);
        },
      );

      it('the same listing can still be closed as rented elsewhere, or no longer for rent', async () => {
        const who = await lister();
        const { id } = await listing(who, 'pending_review', {
          published: false,
        });

        await close(who, id, 'rented_elsewhere').expect(200);
      });

      it('published once, now back in review after an edit: rented_in_app is allowed', async () => {
        const who = await lister();
        const { id } = await listing(who, 'live');
        await http()
          .patch(`/listings/${id}`)
          .set(auth(who))
          .send({ bedrooms: 3 })
          .expect(200);

        const { body } = await close(who, id, 'rented_in_app').expect(200);

        expect(body.status).toBe('rented');
      });
    });

    it('a closed listing can no longer be edited or submitted', async () => {
      const who = await lister();
      const { id } = await listing(who, 'live');
      await close(who, id, 'rented_elsewhere').expect(200);

      await http()
        .patch(`/listings/${id}`)
        .set(auth(who))
        .send({ monthlyRentBirr: 1 })
        .expect(409);
      await http().post(`/listings/${id}/submit`).set(auth(who)).expect(409);
    });

    it("L3: someone else's listing is 404 LISTING_NOT_FOUND", async () => {
      const { id } = await listing(await lister(), 'live');

      const { body } = await close(
        await lister(),
        id,
        'rented_elsewhere',
      ).expect(404);

      expect(body.code).toBe('LISTING_NOT_FOUND');
    });

    it('two closes at the same moment: one 200, one 409', async () => {
      const who = await lister();
      const { id } = await listing(who, 'live');

      const results = await Promise.all([
        close(who, id, 'rented_elsewhere'),
        close(who, id, 'no_longer_for_rent'),
      ]);

      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 409,
      ]);
    });
  });

  describe('POST /properties/:id/listings: relist (L11)', () => {
    it.each(['rented', 'removed'])(
      'after %s: a new draft on the same property, copying rent, advance months and negotiable',
      async (status) => {
        const who = await lister();
        const old = await listing(who, status);

        const { body } = await relist(who, old.propertyId).expect(201);

        expect(body).toMatchObject({
          status: 'draft',
          version: 1,
          monthlyRentBirr: 25000,
          advanceMonths: 2,
          negotiable: true,
          // Still in the future: copied (decided 2026-11-24).
          availableFrom: full.availableFrom,
          staffReasonCode: null,
          missing: [],
          property: { id: old.propertyId, bedrooms: 2 },
        });
        expect(body.id).not.toBe(old.id);
        expect(await lastHistory(body.id)).toMatchObject({
          old_status: null,
          new_status: 'draft',
          actor_id: who.userId,
        });
        // The old listing is kept as it was: history survives relisting.
        expect((await mine(who)).map((l) => [l.id, l.status])).toEqual([
          [body.id, 'draft'],
          [old.id, status],
        ]);
      },
    );

    it('an available-from date in the past is not copied: the lister picks a new one', async () => {
      const who = await lister();
      const old = await listing(who, 'rented');
      await db.query(`UPDATE listings SET available_from = $2 WHERE id = $1`, [
        old.id,
        addisDate(-60),
      ]);

      const { body } = await relist(who, old.propertyId).expect(201);

      expect(body.availableFrom).toBeNull();
      expect(body.missing).toEqual(['availableFrom']);
    });

    it('copies from the latest closed listing', async () => {
      const who = await lister();
      const first = await listing(who, 'rented');
      await db.query(
        `UPDATE listings SET closed_at = now() - interval '1 year' WHERE id = $1`,
        [first.id],
      );
      const [{ id: second }] = await db.query<{ id: string }[]>(
        `INSERT INTO listings (property_id, status, monthly_rent_birr, advance_months, negotiable,
                               available_from, close_reason, closed_at)
         VALUES ($1, 'removed', 31000, 6, false, $2, 'no_longer_for_rent', now())
         RETURNING id`,
        [first.propertyId, addisDate(10)],
      );
      expect(second).toBeDefined();

      const { body } = await relist(who, first.propertyId).expect(201);

      expect(body).toMatchObject({
        monthlyRentBirr: 31000,
        advanceMonths: 6,
        negotiable: false,
      });
    });

    it.each(['draft', 'pending_review', 'live', 'stale', 'expired'])(
      'with a %s listing on the property: 409 PROPERTY_HAS_OPEN_LISTING with its id (L10)',
      async (status) => {
        const who = await lister();
        const open = await listing(who, status);

        const { body } = await relist(who, open.propertyId).expect(409);

        expect(body).toEqual({
          code: 'PROPERTY_HAS_OPEN_LISTING',
          listingId: open.id,
        });
      },
    );

    it('a rejected listing blocks relisting too (decided 2026-11-24); closing it frees the property', async () => {
      const who = await lister();
      const rejected = await listing(who, 'rejected');

      const { body } = await relist(who, rejected.propertyId).expect(409);
      expect(body).toEqual({
        code: 'PROPERTY_HAS_OPEN_LISTING',
        listingId: rejected.id,
      });

      await close(who, rejected.id, 'no_longer_for_rent').expect(200);
      await relist(who, rejected.propertyId).expect(201);
    });

    it('at the draft limit: 409 DRAFT_LISTING_LIMIT', async () => {
      const who = await lister();
      const old = await listing(who, 'rented');
      for (let i = 0; i < 10; i++)
        await http().post('/listings').set(auth(who)).send({}).expect(201);

      const { body } = await relist(who, old.propertyId).expect(409);

      expect(body).toEqual({ code: 'DRAFT_LISTING_LIMIT', max: 10 });
    });

    it("L3: someone else's property, an unknown id or a malformed id: 404 PROPERTY_NOT_FOUND", async () => {
      const old = await listing(await lister(), 'rented');
      const other = await lister();

      for (const target of [
        old.propertyId,
        '00000000-0000-4000-8000-000000000000',
        'not-a-uuid',
      ]) {
        const { body } = await relist(other, target).expect(404);
        expect(body.code).toBe('PROPERTY_NOT_FOUND');
      }
    });

    it('two relists at the same moment: one 201, one 409, one new draft', async () => {
      const who = await lister();
      const old = await listing(who, 'removed');

      const results = await Promise.all([
        relist(who, old.propertyId),
        relist(who, old.propertyId),
      ]);

      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        201, 409,
      ]);
      expect(
        (await mine(who)).filter((l) => l.status === 'draft'),
      ).toHaveLength(1);
    });

    it('L4: a relist goes through review when submitted', async () => {
      const who = await lister();
      const old = await listing(who, 'rented');
      const { body: relisted } = await relist(who, old.propertyId).expect(201);

      const { body } = await http()
        .post(`/listings/${relisted.id}/submit`)
        .set(auth(who))
        .expect(200);

      expect(body.status).toBe('pending_review');
    });

    it('deleting the relist draft keeps the property and the old listing', async () => {
      const who = await lister();
      const old = await listing(who, 'rented');
      const { body: relisted } = await relist(who, old.propertyId).expect(201);

      await http()
        .delete(`/listings/${relisted.id}`)
        .set(auth(who))
        .expect(204);

      expect((await mine(who)).map((l) => l.id)).toEqual([old.id]);
    });
  });
});
