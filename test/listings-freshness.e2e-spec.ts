import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { FreshnessService } from '../src/modules/listings/freshness/freshness.service.js';
import { PhotoStorage } from '../src/modules/photos/photo-storage.js';
import { PushSender } from '../src/modules/push/push-sender.js';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { FakePushSender } from './fakes/fake-push-sender.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { UnlimitedThrottlerStorage } from './fakes/unlimited-throttler-storage.js';
import { createTestAdmin } from './utils/admins.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import { boleNeighbourhoodId, fullListing } from './utils/listings.js';
import { plainImage } from './utils/photos.js';
import { signIn } from './utils/sign-in.js';

// Freshness (spec F1–F6; T6.3): weekly checks, answers, stale, restore, expiry, the stale notice
// and quiet hours (decided 2026-11-24). "Moving the clock" = moving the listing's timestamps into
// the past, since the job measures every window with the database clock. `at` only sets the
// Addis Ababa time of day the pass thinks it is, for quiet hours (20:00–08:00).

const addis = (time: string) => new Date(`2026-11-24T${time}:00+03:00`);
const NOON = addis('12:00');

interface Lister {
  token: string;
  userId: string;
}

describe('listings: freshness (e2e, T6.3)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let freshness: FreshnessService;
  let storage: PhotoStorage;
  const sms = new FakeSmsSender();
  const push = new FakePushSender();
  let counter = 0;
  let staffAuth: Record<string, string>;

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b
        .overrideProvider(SmsSender)
        .useValue(sms)
        .overrideProvider(PushSender)
        .useValue(push)
        .overrideProvider(ThrottlerStorage)
        .useValue(new UnlimitedThrottlerStorage()),
    );
    db = app.get(DataSource);
    freshness = app.get(FreshnessService);
    storage = app.get(PhotoStorage);
  });

  beforeEach(async () => {
    const admin = await createTestAdmin(db, { role: 'moderator' });
    const { body } = await http()
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password })
      .expect(200);
    staffAuth = { Authorization: `Bearer ${body.accessToken}` };
  });

  afterEach(async () => {
    push.reset();
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const as = (who: Lister) => ({ Authorization: `Bearer ${who.token}` });
  const run = (at: Date = NOON) => freshness.runOnce({ now: at });

  /** A verified lister with a registered phone (unless `device: false`). */
  const lister = async ({
    device = true,
    language = 'en',
  } = {}): Promise<Lister> => {
    const phone = `+2519230000${String(++counter).padStart(2, '0')}`;
    const { accessToken } = await signIn(app, sms, phone);
    await db.query(
      `UPDATE users SET verification_status = 'approved', full_name = 'Abebe Kebede',
         preferred_language = $2 WHERE phone = $1`,
      [phone, language],
    );
    const [{ id }] = await db.query<{ id: string }[]>(
      `SELECT id FROM users WHERE phone = $1`,
      [phone],
    );
    const who = { token: accessToken, userId: id };
    if (device)
      await http()
        .post('/me/devices')
        .set(as(who))
        .send({ installationId: `fid-${counter}`, platform: 'android' })
        .expect(201);
    return who;
  };

  const approve = async (id: string, version: number) =>
    http()
      .post(`/admin/listings/${id}/approve`)
      .set(staffAuth)
      .send({ version })
      .expect(200);

  /** A real live listing: 3 photos, submitted, approved. */
  const liveListing = async (
    who: Lister,
  ): Promise<{ id: string; propertyId: string }> => {
    const { body: draft } = await http()
      .post('/listings')
      .set(as(who))
      .send(fullListing(await boleNeighbourhoodId(db)))
      .expect(201);
    for (let i = 0; i < 3; i++)
      await http()
        .post(`/properties/${draft.property.id}/photos`)
        .set(as(who))
        .attach('photo', await plainImage(64, 48), 'p.jpg')
        .expect(201);
    const { body: submitted } = await http()
      .post(`/listings/${draft.id}/submit`)
      .set(as(who))
      .expect(200);
    await approve(draft.id, submitted.version);
    return { id: draft.id, propertyId: draft.property.id };
  };

  /** Moves the listing's publication and last confirmation `days` into the past. */
  const ageListing = (id: string, days: number) =>
    db.query(
      `UPDATE listings SET published_at = published_at - make_interval(days => $2),
         last_confirmed_at = last_confirmed_at - make_interval(days => $2)
       WHERE id = $1`,
      [id, days],
    );
  /** Moves the listing's checks `hours` into the past. */
  const ageChecks = (id: string, hours: number) =>
    db.query(
      `UPDATE availability_checks SET sent_at = sent_at - make_interval(hours => $2)
       WHERE listing_id = $1`,
      [id, hours],
    );
  const checks = (id: string) =>
    db.query<
      {
        outcome: string | null;
        push_result: string | null;
        responded_at: Date | null;
        sent_at: Date;
        stale_push_result: string | null;
      }[]
    >(
      `SELECT outcome, push_result, responded_at, sent_at, stale_push_result
       FROM availability_checks WHERE listing_id = $1 ORDER BY sent_at`,
      [id],
    );
  const statusOf = async (id: string) =>
    (
      await db.query<{ status: string }[]>(
        `SELECT status FROM listings WHERE id = $1`,
        [id],
      )
    )[0].status;
  const photosPublic = async (propertyId: string) => {
    const rows = await db.query<{ storage_key: string }[]>(
      `SELECT storage_key FROM property_photos WHERE property_id = $1`,
      [propertyId],
    );
    const statuses = await Promise.all(
      rows.map(
        async (r) => (await fetch(storage.publicUrl(r.storage_key))).status,
      ),
    );
    return statuses.every((s) => s === 200);
  };
  const pushesOf = (type: string) =>
    push.sent.filter((p) => p.message.data.type === type);

  /** A live listing with an open check that is `hours` old. */
  const withOpenCheck = async (who: Lister, hours = 0) => {
    const listing = await liveListing(who);
    await ageListing(listing.id, 8);
    expect((await run()).checks).toBe(1);
    if (hours > 0) await ageChecks(listing.id, hours);
    return listing;
  };
  /** A stale listing (no answer in 48 h). */
  const staleListing = async (who: Lister) => {
    const listing = await withOpenCheck(who, 49);
    expect((await run()).stale).toBe(1);
    return listing;
  };

  describe('F1: the weekly check', () => {
    it("not before 7 days; after, one check and a push in the lister's language", async () => {
      const who = await lister({ language: 'am' });
      const { id } = await liveListing(who);

      expect((await run()).checks).toBe(0);
      await ageListing(id, 7);
      expect((await run()).checks).toBe(1);

      expect(await checks(id)).toMatchObject([
        { outcome: null, push_result: 'sent' },
      ]);
      expect(pushesOf('weekly_check')).toEqual([
        {
          installationId: expect.any(String),
          message: expect.objectContaining({
            title: 'ቤትዎ አሁንም ለኪራይ ዝግጁ ነው?',
            data: { type: 'weekly_check', listingId: id },
          }),
        },
      ]);
    });

    it('running twice, or two passes at once, still makes one check (F6)', async () => {
      const { id } = await liveListing(await lister());
      await ageListing(id, 8);

      const [a, b] = await Promise.all([run(), run()]);
      await run();

      expect(a.checks + b.checks).toBe(1);
      expect(await checks(id)).toHaveLength(1);
      expect(pushesOf('weekly_check')).toHaveLength(1);
    });

    it('the database allows only one open check per listing', async () => {
      const { id } = await withOpenCheck(await lister());

      await expect(
        db.query(`INSERT INTO availability_checks (listing_id) VALUES ($1)`, [
          id,
        ]),
      ).rejects.toThrow(/UQ_availability_checks_one_open/);
    });

    it('no phone registered: the check is still made (no_device), and the window still runs (F3)', async () => {
      const { id } = await withOpenCheck(await lister({ device: false }), 49);

      expect(await checks(id)).toMatchObject([{ push_result: 'no_device' }]);
      expect((await run()).stale).toBe(1);
    });

    it('the push failing: recorded as failed; the listing still goes stale after 48 h', async () => {
      const who = await lister();
      push.outcomes.set(`fid-${counter}`, 'failed');
      const { id } = await withOpenCheck(who, 49);

      expect(await checks(id)).toMatchObject([{ push_result: 'failed' }]);
      expect((await run()).stale).toBe(1);
    });

    it('GET /me/listings shows the open check, answerable for 48 h (F3)', async () => {
      const who = await lister();
      const { id } = await withOpenCheck(who);

      const { body } = await http()
        .get('/me/listings')
        .set(as(who))
        .expect(200);

      const { pendingCheck } = body.find((l: { id: string }) => l.id === id);
      expect(
        new Date(pendingCheck.answerBy).getTime() -
          new Date(pendingCheck.sentAt).getTime(),
      ).toBe(48 * 3600 * 1000);
    });
  });

  describe('quiet hours, 20:00–08:00 Addis Ababa (decided 2026-11-24)', () => {
    it.each([
      ['07:59', 0],
      ['08:00', 1],
      ['19:59', 1],
      ['20:00', 0],
    ])('a check due at %s: %i sent', async (time, sent) => {
      const { id } = await liveListing(await lister());
      await ageListing(id, 8);

      const summary = await run(addis(time));

      expect(summary.quiet).toBe(sent === 0);
      expect(summary.checks).toBe(sent);
      expect(pushesOf('weekly_check')).toHaveLength(sent);
    });

    it('a check due at night waits until morning; its 48 h start when it is actually sent', async () => {
      const { id } = await liveListing(await lister());
      // Due 10 hours ago (at night): not sent then.
      await db.query(
        `UPDATE listings SET published_at = now() - interval '7 days 10 hours',
           last_confirmed_at = now() - interval '7 days 10 hours' WHERE id = $1`,
        [id],
      );
      expect((await run(addis('23:00'))).checks).toBe(0);

      const before = new Date();
      expect((await run(addis('08:00'))).checks).toBe(1);

      const [check] = await checks(id);
      expect(check.sent_at.getTime()).toBeGreaterThanOrEqual(
        before.getTime() - 1000,
      );
      // 47 h after sending it is still open; the due time doesn't shorten the window.
      await ageChecks(id, 47);
      expect((await run()).stale).toBe(0);
    });

    it('going stale happens at night too, but the notice waits until 08:00, and is sent once', async () => {
      const { id } = await withOpenCheck(await lister(), 49);

      expect(await run(addis('23:00'))).toMatchObject({
        stale: 1,
        staleNotices: 0,
      });
      expect(await statusOf(id)).toBe('stale');
      expect((await run(addis('07:59'))).staleNotices).toBe(0);
      expect((await run(addis('08:00'))).staleNotices).toBe(1);
      expect((await run(addis('09:00'))).staleNotices).toBe(0);

      expect(pushesOf('listing_stale')).toHaveLength(1);
      expect(await checks(id)).toMatchObject([
        { outcome: 'no_answer', stale_push_result: 'sent' },
      ]);
    });
  });

  describe('F3: no answer in 48 h → stale', () => {
    it('stale, hidden from browse, photos private, recorded as the system, with a stale notice', async () => {
      const who = await lister();
      const { id, propertyId } = await withOpenCheck(who, 47);
      expect((await run()).stale).toBe(0);
      expect(await photosPublic(propertyId)).toBe(true);

      await ageChecks(id, 2);
      expect((await run()).stale).toBe(1);

      expect(await statusOf(id)).toBe('stale');
      expect((await http().get('/listings').expect(200)).body.items).toEqual(
        [],
      );
      expect(await photosPublic(propertyId)).toBe(false);
      expect(await checks(id)).toMatchObject([
        { outcome: 'no_answer', responded_at: null },
      ]);
      const [history] = await db.query<
        { actor_type: string; actor_id: string | null }[]
      >(
        `SELECT actor_type, actor_id FROM listing_history
         WHERE listing_id = $1 AND new_status = 'stale'`,
        [id],
      );
      expect(history).toEqual({ actor_type: 'system', actor_id: null });
      expect(pushesOf('listing_stale')).toEqual([
        {
          installationId: expect.any(String),
          message: expect.objectContaining({
            title: 'Your listing is hidden',
            data: { type: 'listing_stale', listingId: id },
          }),
        },
      ]);
    });

    it('the lister answering while the job holds off: the job sees the answer and leaves it live (F6)', async () => {
      const { id } = await withOpenCheck(await lister(), 49);
      // The "lister" holds the listing lock, as an answer in progress would.
      const runner = db.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      await runner.query(`SELECT 1 FROM listings WHERE id = $1 FOR UPDATE`, [
        id,
      ]);

      const pass = run();
      await waitUntilBlocked();
      await runner.query(
        `UPDATE availability_checks SET closed_at = now(), outcome = 'available', responded_at = now()
         WHERE listing_id = $1 AND closed_at IS NULL`,
        [id],
      );
      await runner.query(
        `UPDATE listings SET last_confirmed_at = now() WHERE id = $1`,
        [id],
      );
      await runner.commitTransaction();
      await runner.release();

      // No error either: the pass saw the answer, rather than failing on the table's constraints.
      expect(await pass).toMatchObject({ stale: 0, errors: 0 });
      expect(await statusOf(id)).toBe('live');
      expect(await checks(id)).toMatchObject([{ outcome: 'available' }]);
    });
  });

  describe('F2: POST /listings/:id/still-available', () => {
    const answer = (who: Lister, id: string, body: object) =>
      http().post(`/listings/${id}/still-available`).set(as(who)).send(body);

    it('available: confirmed, the check closed, the next one 7 days later', async () => {
      const who = await lister();
      const { id } = await withOpenCheck(who);

      const { body } = await answer(who, id, { available: true }).expect(200);

      expect(body).toMatchObject({ status: 'live', pendingCheck: null });
      expect(await checks(id)).toMatchObject([
        { outcome: 'available', responded_at: expect.any(Date) },
      ]);
      expect((await run()).checks).toBe(0);
      await ageListing(id, 7);
      expect((await run()).checks).toBe(1);
    });

    it('available with no open check counts as a confirmation too (Q1)', async () => {
      const who = await lister();
      const { id } = await liveListing(who);
      await ageListing(id, 6);

      await answer(who, id, { available: true }).expect(200);

      await ageListing(id, 1);
      expect((await run()).checks).toBe(0);
    });

    it('not available, with a reason: closed as in L12, the check not_available, photos private', async () => {
      const who = await lister();
      const { id, propertyId } = await withOpenCheck(who);

      const { body } = await answer(who, id, {
        available: false,
        reason: 'rented_in_app',
      }).expect(200);

      expect(body).toMatchObject({
        status: 'rented',
        closeReason: 'rented_in_app',
      });
      expect(await checks(id)).toMatchObject([{ outcome: 'not_available' }]);
      expect(await photosPublic(propertyId)).toBe(false);
    });

    it.each([
      ['not available without a reason', { available: false }],
      [
        'a reason with available',
        { available: true, reason: 'rented_elsewhere' },
      ],
      [
        'a reason the lister cannot use',
        { available: false, reason: 'staff_takedown' },
      ],
      ['no answer', {}],
    ])('%s: 400 VALIDATION_FAILED', async (_name, body) => {
      const who = await lister();
      const { id } = await liveListing(who);

      const res = await answer(who, id, body).expect(400);

      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(await statusOf(id)).toBe('live');
    });

    it('a late answer on a stale listing: available restores it (Q2)', async () => {
      const who = await lister();
      const { id, propertyId } = await staleListing(who);

      const { body } = await answer(who, id, { available: true }).expect(200);

      expect(body.status).toBe('live');
      expect(await photosPublic(propertyId)).toBe(true);
    });

    it('a late answer on a stale listing: not available closes it', async () => {
      const who = await lister();
      const { id } = await staleListing(who);

      const { body } = await answer(who, id, {
        available: false,
        reason: 'no_longer_for_rent',
      }).expect(200);

      expect(body.status).toBe('removed');
    });

    it("any other state: 409 INVALID_LISTING_STATE; someone else's listing: 404", async () => {
      const who = await lister();
      const { body: draft } = await http()
        .post('/listings')
        .set(as(who))
        .send(fullListing(await boleNeighbourhoodId(db)))
        .expect(201);
      const { id } = await liveListing(await lister());

      expect(
        (await answer(who, draft.id, { available: true }).expect(409)).body
          .code,
      ).toBe('INVALID_LISTING_STATE');
      expect(
        (await answer(who, id, { available: true }).expect(404)).body.code,
      ).toBe('LISTING_NOT_FOUND');
    });
  });

  describe('F4: POST /listings/:id/restore', () => {
    it('stale → live with no review: photos public again, the next check 7 days later', async () => {
      const who = await lister();
      const { id, propertyId } = await staleListing(who);

      const { body } = await http()
        .post(`/listings/${id}/restore`)
        .set(as(who))
        .expect(200);

      expect(body).toMatchObject({ status: 'live', pendingCheck: null });
      expect(await photosPublic(propertyId)).toBe(true);
      expect(
        (await http().get('/listings').expect(200)).body.items,
      ).toHaveLength(1);
      expect((await run()).checks).toBe(0);
      await ageListing(id, 7);
      expect((await run()).checks).toBe(1);
    });

    it('a listing that is not stale: 409 INVALID_LISTING_STATE', async () => {
      const who = await lister();
      const { id } = await liveListing(who);

      const { body } = await http()
        .post(`/listings/${id}/restore`)
        .set(as(who))
        .expect(409);

      expect(body.code).toBe('INVALID_LISTING_STATE');
    });

    it('no stale notice after restoring, even if it was waiting for the morning', async () => {
      const who = await lister();
      const { id } = await withOpenCheck(who, 49);
      await run(addis('23:00'));

      await http().post(`/listings/${id}/restore`).set(as(who)).expect(200);

      expect((await run(addis('08:00'))).staleNotices).toBe(0);
      expect(pushesOf('listing_stale')).toEqual([]);
    });
  });

  describe('F5: stale for 30 days → expired', () => {
    it('expired by the system after 30 days; not at 29; no push', async () => {
      const { id } = await staleListing(await lister());
      push.reset();
      const staleFor = (days: number) =>
        db.query(
          `UPDATE listings SET stale_at = now() - make_interval(days => $2) WHERE id = $1`,
          [id, days],
        );

      await staleFor(29);
      expect((await run()).expired).toBe(0);
      await staleFor(30);
      expect((await run()).expired).toBe(1);

      expect(await statusOf(id)).toBe('expired');
      const [history] = await db.query<{ actor_type: string }[]>(
        `SELECT actor_type FROM listing_history WHERE listing_id = $1 AND new_status = 'expired'`,
        [id],
      );
      expect(history.actor_type).toBe('system');
      expect(push.sent).toEqual([]);
    });
  });

  describe('leaving live another way cancels the open check (the trigger)', () => {
    it('an edit back to review cancels it, so a re-approval does not make the listing stale', async () => {
      const who = await lister();
      const { id } = await withOpenCheck(who, 40);

      const { body: edited } = await http()
        .patch(`/listings/${id}`)
        .set(as(who))
        .send({ description: 'Bright two-bedroom flat, freshly painted.' })
        .expect(200);
      expect(edited.status).toBe('pending_review');
      expect(await checks(id)).toMatchObject([
        { outcome: 'cancelled', responded_at: null },
      ]);

      await approve(id, edited.version);
      await ageChecks(id, 10);

      expect(await run()).toMatchObject({ stale: 0, checks: 0 });
      expect(await statusOf(id)).toBe('live');
    });

    it('closing from the listing screen (not the check) cancels it too', async () => {
      const who = await lister();
      const { id } = await withOpenCheck(who);

      await http()
        .post(`/listings/${id}/close`)
        .set(as(who))
        .send({ reason: 'rented_elsewhere' })
        .expect(200);

      expect(await checks(id)).toMatchObject([{ outcome: 'cancelled' }]);
    });
  });

  /** Until another connection waits on a row lock (the pass, blocked by the test's lock). */
  async function waitUntilBlocked(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const [{ waiting }] = await db.query<{ waiting: number }[]>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (waiting > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('the pass never waited on the lock');
  }
});
