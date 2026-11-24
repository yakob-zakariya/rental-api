import { PutObjectCommand } from '@aws-sdk/client-s3';
import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { PublicPhotoReconciliationJob } from '../src/modules/listings/public-photo-reconciliation.job.js';
import { PublicPhotoReconciliation } from '../src/modules/listings/public-photo-reconciliation.service.js';
import { PhotoStorage } from '../src/modules/photos/photo-storage.js';
import { PublicCache } from '../src/modules/photos/public-cache.js';
import { createS3Client } from '../src/modules/photos/s3-client.js';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { FakePublicCache } from './fakes/fake-public-cache.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { UnlimitedThrottlerStorage } from './fakes/unlimited-throttler-storage.js';
import { TEST_ENV } from './test-env.js';
import { createTestAdmin } from './utils/admins.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import { boleNeighbourhoodId, fullListing } from './utils/listings.js';
import { plainImage } from './utils/photos.js';
import { signIn } from './utils/sign-in.js';

// The hourly clean-up of public photo copies (spec R7, T4.4), against the local SeaweedFS.

/** Lets a test hold a code path at one point, check what the other side does, then go on. */
function barrier() {
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => (arrive = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  return { arrived, released, arrive, release };
}

/** Whether a promise is still pending after `ms`. */
const stillPending = (promise: Promise<unknown>, ms = 500) =>
  Promise.race([
    promise.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), ms)),
  ]);

// Copies written before this count as old enough (the grace period is skipped in tests).
const ALL_OLD = () => new Date(Date.now() + 60_000);

describe('public photo reconciliation (e2e, T4.4)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let storage: PhotoStorage;
  let job: PublicPhotoReconciliation;
  const sms = new FakeSmsSender();
  const cdn = new FakePublicCache();
  const s3 = createS3Client({ ...TEST_ENV, S3_FORCE_PATH_STYLE: true });
  let counter = 0;
  let photo: Buffer;
  let moderator: { Authorization: string };

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
    job = app.get(PublicPhotoReconciliation);
    photo = await plainImage(64, 48);
  });

  beforeEach(async () => {
    const admin = await createTestAdmin(db, { role: 'moderator' });
    const { body } = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password })
      .expect(200);
    moderator = { Authorization: `Bearer ${body.accessToken}` };
    cdn.purged = [];
    // Clear strays other test files left, so each test sees only its own.
    await job.runOnce({ olderThan: ALL_OLD() });
    cdn.purged = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetDatabase(app);
  });

  afterAll(async () => {
    s3.destroy();
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  const lister = async () => {
    const phone = `+2519220000${String(++counter).padStart(2, '0')}`;
    const { accessToken } = await signIn(app, sms, phone);
    await db.query(
      `UPDATE users SET verification_status = 'approved', full_name = 'Abebe Kebede' WHERE phone = $1`,
      [phone],
    );
    return { Authorization: `Bearer ${accessToken}` };
  };

  /** A real listing in review: a complete draft, 3 photos, submitted. */
  const inReview = async (who: { Authorization: string }) => {
    const { body: draft } = await http()
      .post('/listings')
      .set(who)
      .send(fullListing(await boleNeighbourhoodId(db)))
      .expect(201);
    for (let i = 0; i < 3; i++)
      await http()
        .post(`/properties/${draft.property.id}/photos`)
        .set(who)
        .attach('photo', photo, 'p.jpg')
        .expect(201);
    const { body } = await http()
      .post(`/listings/${draft.id}/submit`)
      .set(who)
      .expect(200);
    return {
      id: body.id as string,
      propertyId: body.property.id as string,
      version: body.version as number,
    };
  };
  const approve = (id: string, version: number) =>
    http()
      .post(`/admin/listings/${id}/approve`)
      .set(moderator)
      .send({ version });
  const live = async (who: { Authorization: string }) => {
    const listing = await inReview(who);
    await approve(listing.id, listing.version).expect(200);
    return listing;
  };
  const keysOf = async (propertyId: string) =>
    (
      await db.query<{ storage_key: string }[]>(
        `SELECT storage_key FROM property_photos WHERE property_id = $1 ORDER BY position`,
        [propertyId],
      )
    ).map((r) => r.storage_key);
  const publicStatus = async (keys: string[]) =>
    Promise.all(
      keys.map(async (k) => (await fetch(storage.publicUrl(k))).status),
    );

  /**
   * A live listing edited back to review while its unpublish failed: old public copies remain,
   * the listing is in review. Returns the listing with its new version.
   */
  const reviewWithOldPublicCopies = async () => {
    const who = await lister();
    const listing = await live(who);
    const unpublish = vi
      .spyOn(storage, 'unpublish')
      .mockRejectedValue(new Error('storage down'));
    const { body } = await http()
      .patch(`/listings/${listing.id}`)
      .set(who)
      .send({ description: 'Repainted.' })
      .expect(200);
    unpublish.mockRestore();
    expect(body.status).toBe('pending_review');
    const keys = await keysOf(listing.propertyId);
    expect(await publicStatus(keys)).toEqual([200, 200, 200]);
    return { ...listing, version: body.version as number, keys };
  };

  describe('what it removes', () => {
    it('copies left after a takedown whose unpublish failed; the CDN is asked to forget them; the private copies stay', async () => {
      const listing = await live(await lister());
      const keys = await keysOf(listing.propertyId);
      vi.spyOn(storage, 'unpublish')
        .mockRejectedValueOnce(new Error('storage down'))
        .mockRejectedValueOnce(new Error('storage down'))
        .mockRejectedValueOnce(new Error('storage down'));
      await http()
        .post(`/admin/listings/${listing.id}/takedown`)
        .set(moderator)
        .send({ reasonCode: 'GUIDELINES', note: 'Scam' })
        .expect(200);
      vi.restoreAllMocks();
      expect(await publicStatus(keys)).toEqual([200, 200, 200]);
      cdn.purged = [];

      const summary = await job.runOnce({ olderThan: ALL_OLD() });

      expect(summary).toMatchObject({ skipped: false, removed: 3, errors: 0 });
      expect(await publicStatus(keys)).toEqual([404, 404, 404]);
      expect(cdn.purged.sort()).toEqual(
        keys.map((k) => storage.publicUrl(k)).sort(),
      );
      for (const key of keys)
        expect((await fetch(await storage.signedUrl(key))).status).toBe(200);
    });

    it('copies published for a listing that never went live (an approval that then failed)', async () => {
      const listing = await inReview(await lister());
      const keys = await keysOf(listing.propertyId);
      for (const key of keys) await storage.publish(key);

      const summary = await job.runOnce({ olderThan: ALL_OLD() });

      expect(summary.removed).toBe(3);
      expect(await publicStatus(keys)).toEqual([404, 404, 404]);
    });

    it('a public copy whose photo record is gone', async () => {
      const listing = await live(await lister());
      const [key] = await keysOf(listing.propertyId);
      await db.query(`DELETE FROM property_photos WHERE storage_key = $1`, [
        key,
      ]);

      const summary = await job.runOnce({ olderThan: ALL_OLD() });

      expect(summary.removed).toBe(1);
      expect(await publicStatus([key])).toEqual([404]);
    });
  });

  describe('what it keeps', () => {
    it("a live listing's photos", async () => {
      const listing = await live(await lister());
      const keys = await keysOf(listing.propertyId);

      const summary = await job.runOnce({ olderThan: ALL_OLD() });

      expect(summary).toMatchObject({ kept: 3, removed: 0 });
      expect(await publicStatus(keys)).toEqual([200, 200, 200]);
    });

    it('copies younger than 15 minutes, with the default cut-off (an approval may be mid-way)', async () => {
      const listing = await inReview(await lister());
      const keys = await keysOf(listing.propertyId);
      for (const key of keys) await storage.publish(key);

      const summary = await job.runOnce();

      expect(summary).toMatchObject({ recent: 3, removed: 0 });
      expect(await publicStatus(keys)).toEqual([200, 200, 200]);
    });

    it('anything outside properties/ is left alone (and counted)', async () => {
      await s3.send(
        new PutObjectCommand({
          Bucket: TEST_ENV.S3_PUBLIC_BUCKET,
          Key: 'not-ours/readme.txt',
          Body: 'placed by hand',
        }),
      );

      const summary = await job.runOnce({ olderThan: ALL_OLD() });

      expect(summary.foreign).toBeGreaterThanOrEqual(1);
      expect(summary.removed).toBe(0);
      expect(
        (await fetch(`${TEST_ENV.S3_PUBLIC_BASE_URL}/not-ours/readme.txt`))
          .status,
      ).toBe(200);
    });
  });

  it('running it twice: the second pass removes nothing', async () => {
    const listing = await inReview(await lister());
    for (const key of await keysOf(listing.propertyId))
      await storage.publish(key);

    expect((await job.runOnce({ olderThan: ALL_OLD() })).removed).toBe(3);
    expect((await job.runOnce({ olderThan: ALL_OLD() })).removed).toBe(0);
  });

  it('two passes at the same moment: one runs, the other is skipped', async () => {
    // Hold the first pass while it holds the lock (in the middle of listing the bucket).
    const gate = barrier();
    const realList = storage.listPublic.bind(storage);
    vi.spyOn(storage, 'listPublic').mockImplementationOnce(async function* () {
      gate.arrive();
      await gate.released;
      yield* realList();
    });
    const first = job.runOnce({ olderThan: ALL_OLD() });
    await gate.arrived;

    const second = await job.runOnce({ olderThan: ALL_OLD() });

    expect(second.skipped).toBe(true);
    gate.release();
    expect((await first).skipped).toBe(false);
  });

  describe('races with publishing (decided 2026-11-24): delete and publish never overlap for one listing', () => {
    it('the job holds the lock first: the approval waits, then publishes after the delete; photos end up public', async () => {
      const listing = await reviewWithOldPublicCopies();
      const gate = barrier();
      const realUnpublish = storage.unpublish.bind(storage);
      vi.spyOn(storage, 'unpublish').mockImplementation(async (key) => {
        gate.arrive();
        await gate.released;
        return realUnpublish(key);
      });

      // The job sees the old copies of a listing in review, locks the property, is about to delete.
      const pass = job.runOnce({ olderThan: ALL_OLD() });
      await gate.arrived;
      // An approval of the same listing now must wait for the job's lock.
      const approval = approve(listing.id, listing.version).then((r) => r);
      expect(await stillPending(approval)).toBe(true);

      gate.release();
      const summary = await pass;
      const response = await approval;

      expect(summary.removed).toBe(3);
      expect(response.status).toBe(200);
      expect(await publicStatus(listing.keys)).toEqual([200, 200, 200]);
    });

    it('the approval holds the lock first: the job waits, then sees the listing live and keeps the photos', async () => {
      const listing = await reviewWithOldPublicCopies();
      const gate = barrier();
      const realPublish = storage.publish.bind(storage);
      vi.spyOn(storage, 'publish').mockImplementation(async (key) => {
        gate.arrive();
        await gate.released;
        return realPublish(key);
      });

      // The approval holds the lister's and the property's locks, and is about to publish.
      const approval = approve(listing.id, listing.version).then((r) => r);
      await gate.arrived;
      // The job sees a listing in review (not committed yet) and must wait for the lock.
      const pass = job.runOnce({ olderThan: ALL_OLD() });
      expect(await stillPending(pass)).toBe(true);

      gate.release();
      expect((await approval).status).toBe(200);
      const summary = await pass;

      expect(summary).toMatchObject({ removed: 0, kept: 3 });
      expect(await publicStatus(listing.keys)).toEqual([200, 200, 200]);
    });
  });

  it('the hourly job does nothing when JOBS_ENABLED=false (tests)', async () => {
    const runOnce = vi.spyOn(job, 'runOnce');

    await app.get(PublicPhotoReconciliationJob).tick();

    expect(runOnce).not.toHaveBeenCalled();
  });
});
