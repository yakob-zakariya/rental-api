import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { DiditClient } from '../src/modules/verification/didit/didit-client.js';
import { VerificationStatusService } from '../src/modules/verification/verification-status.service.js';
import { FakeDiditClient } from './fakes/fake-didit-client.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { insertTestAdmin } from './utils/admins.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import { signIn } from './utils/sign-in.js';

// A real admin row, created before each test (the admin id columns are foreign keys).
let ADMIN_ID: string;

interface Seed {
  outcome: string;
  providerStatus?: string;
  declineReason?: string | null;
  decidedByStaff?: boolean;
  minutesAgo?: number;
}

describe('verification status and manual review (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  const sms = new FakeSmsSender();
  const didit = new FakeDiditClient();
  let accessToken: string;
  let userId: string;
  let sessionCounter = 0;

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b
        .overrideProvider(SmsSender)
        .useValue(sms)
        .overrideProvider(DiditClient)
        .useValue(didit),
    );
    db = app.get(DataSource);
  });

  beforeEach(async () => {
    ADMIN_ID = await insertTestAdmin(db);
    ({ accessToken } = await signIn(app, sms, '+251911234567'));
    userId = (await db.query<{ id: string }[]>(`SELECT id FROM users`))[0].id;
  });

  afterEach(async () => {
    sms.clear();
    didit.reset();
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const getStatus = () =>
    http()
      .get('/verification/status')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
  const requestReview = () =>
    http()
      .post('/verification/manual-review-request')
      .set('Authorization', `Bearer ${accessToken}`);
  const start = () =>
    http()
      .post('/verification/sessions')
      .set('Authorization', `Bearer ${accessToken}`);

  /** Inserts attempts (newest last) and recomputes, as the real flows would. */
  const seed = async (...attempts: Seed[]) => {
    for (const [i, a] of attempts.entries()) {
      const pending = a.outcome === 'pending';
      const minutesAgo = a.minutesAgo ?? 60 * (attempts.length - i);
      await db.query(
        `INSERT INTO identity_verifications
           (user_id, provider_session_id, provider_status, outcome, decline_reason,
            verification_url, session_token, decided_by_admin_id, decided_at, created_at, pending_since)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 clock_timestamp() - make_interval(mins => $10),
                 clock_timestamp() - make_interval(mins => $10))`,
        [
          userId,
          `seeded-${++sessionCounter}`,
          a.providerStatus ??
            (a.outcome === 'declined' ? 'Declined' : 'In Progress'),
          a.outcome,
          a.declineReason ??
            (a.outcome === 'declined' ? 'DIDIT_DECLINED' : null),
          pending ? 'https://verify.didit.me/session/resume-me' : null,
          pending ? 'resumetoken1' : null,
          a.decidedByStaff ? ADMIN_ID : null,
          a.decidedByStaff ? new Date() : null,
          minutesAgo,
        ],
      );
    }
    await app
      .get(VerificationStatusService)
      .recomputeVerificationStatus(userId, db.manager);
  };

  /**
   * When the oldest attempt V3 counts (created in the last 24 hours) leaves the window, as the
   * API sends it: ISO in UTC, rounded up to the millisecond.
   */
  const oldestCountedLeavesAt = async () => {
    const [{ at }] = await db.query<{ at: Date }[]>(
      `SELECT to_timestamp(ceil(extract(epoch FROM min(created_at) + interval '24 hours') * 1000)
                / 1000) AS at
       FROM identity_verifications
       WHERE user_id = $1 AND created_at > clock_timestamp() - interval '24 hours'`,
      [userId],
    );
    return at.toISOString();
  };

  const didit3Declines = () =>
    seed(
      { outcome: 'declined' },
      { outcome: 'declined' },
      { outcome: 'declined' },
    );

  describe('GET /verification/status', () => {
    it('a new user can start, with all 3 retries', async () => {
      const { body } = await getStatus();

      expect(body).toEqual({
        status: 'not_verified',
        canRetry: true,
        retriesLeftToday: 3,
        canRequestManualReview: false,
        retryAvailableAt: null,
      });
    });

    it('a pending user can resume', async () => {
      await seed({ outcome: 'pending', minutesAgo: 5 });

      expect((await getStatus()).body).toEqual({
        status: 'pending',
        canRetry: true,
        retriesLeftToday: 2,
        canRequestManualReview: false,
        retryAvailableAt: null,
      });
    });

    it('a user declined by Didit gets DOCUMENT_NOT_VERIFIED and may retry', async () => {
      await seed({ outcome: 'declined' });

      expect((await getStatus()).body).toEqual({
        status: 'declined',
        canRetry: true,
        retriesLeftToday: 2,
        canRequestManualReview: false,
        retryAvailableAt: null,
        reasonCode: 'DOCUMENT_NOT_VERIFIED',
      });
    });

    it('an underage decline (V4) gets UNDERAGE', async () => {
      await seed({
        outcome: 'declined',
        providerStatus: 'Approved',
        declineReason: 'UNDERAGE',
      });

      expect((await getStatus()).body.reasonCode).toBe('UNDERAGE');
    });

    it('counts retries down over the rolling 24 hours and recovers', async () => {
      await seed({ outcome: 'declined', minutesAgo: 24 * 60 - 5 });
      expect((await getStatus()).body.retriesLeftToday).toBe(2);
      await seed(
        { outcome: 'declined', minutesAgo: 30 },
        { outcome: 'declined', minutesAgo: 20 },
      );
      expect((await getStatus()).body).toMatchObject({
        retriesLeftToday: 0,
        canRetry: false,
      });

      // The oldest one leaves the window.
      await db.query(
        `UPDATE identity_verifications SET created_at = created_at - interval '10 minutes'
         WHERE created_at = (SELECT min(created_at) FROM identity_verifications)`,
      );
      expect((await getStatus()).body).toMatchObject({
        retriesLeftToday: 1,
        canRetry: true,
      });
    });

    it('at the limit after a Didit decline: no retry, but manual review is available', async () => {
      await didit3Declines();

      expect((await getStatus()).body).toEqual({
        status: 'declined',
        canRetry: false,
        retriesLeftToday: 0,
        canRequestManualReview: true,
        retryAvailableAt: await oldestCountedLeavesAt(),
        reasonCode: 'DOCUMENT_NOT_VERIFIED',
      });
    });

    it('at the limit with a pending attempt: canRetry (resume), no manual review', async () => {
      await seed(
        { outcome: 'declined' },
        { outcome: 'declined' },
        { outcome: 'pending', minutesAgo: 90 },
      );

      expect((await getStatus()).body).toMatchObject({
        status: 'pending',
        canRetry: true,
        retriesLeftToday: 0,
        canRequestManualReview: false,
        retryAvailableAt: null,
      });
    });

    it.each([
      [
        'declined by our checks (UNDERAGE)',
        {
          outcome: 'declined',
          providerStatus: 'Approved',
          declineReason: 'UNDERAGE',
        },
      ],
      ['declined by staff', { outcome: 'declined', decidedByStaff: true }],
    ])('at the limit, latest %s: no manual review', async (_label, latest) => {
      await seed({ outcome: 'declined' }, { outcome: 'declined' }, latest);

      expect((await getStatus()).body).toMatchObject({
        canRetry: false,
        canRequestManualReview: false,
      });
    });

    it('a staff-declined user below the limit may still start a new session', async () => {
      await seed({ outcome: 'declined', decidedByStaff: true });

      expect((await getStatus()).body).toMatchObject({
        status: 'declined',
        canRetry: true,
        retriesLeftToday: 2,
      });
      await start().expect(201);
    });

    it.each(['approved', 'manual_review'])(
      'a %s user cannot retry and gets no reasonCode',
      async (outcome) => {
        await seed({ outcome });

        const { body } = await getStatus();
        expect(body).toMatchObject({
          status: outcome,
          canRetry: false,
          canRequestManualReview: false,
          retryAvailableAt: null,
        });
        expect(body).not.toHaveProperty('reasonCode');
      },
    );

    it('a blocked user learns nothing beyond "blocked" (hard rule 10)', async () => {
      await seed(
        { outcome: 'declined' },
        { outcome: 'blocked', declineReason: 'BANNED_IDENTITY' },
      );

      expect((await getStatus()).body).toEqual({
        status: 'blocked',
        canRetry: false,
        retriesLeftToday: 0,
        canRequestManualReview: false,
        retryAvailableAt: null,
      });
    });

    describe('retryAvailableAt', () => {
      const HOUR = 3600_000;
      const expectAboutHoursFromNow = (iso: string, hours: number) => {
        const msFromNow = Date.parse(iso) - Date.now();
        expect(msFromNow).toBeGreaterThan(hours * HOUR - 60_000);
        expect(msFromNow).toBeLessThan(hours * HOUR + 60_000);
      };

      it('at the limit: the oldest counted attempt + 24 hours, in UTC', async () => {
        await seed(
          { outcome: 'declined', minutesAgo: 600 },
          { outcome: 'declined', minutesAgo: 300 },
          { outcome: 'declined', minutesAgo: 100 },
        );
        const { body } = await getStatus();
        const [{ oldest }] = await db.query<{ oldest: Date }[]>(
          `SELECT min(created_at) AS oldest FROM identity_verifications`,
        );

        expect(body.retryAvailableAt).toBe(await oldestCountedLeavesAt());
        expect(body.retryAvailableAt).toMatch(
          /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
        );
        const sinceOldest =
          Date.parse(body.retryAvailableAt) - oldest.getTime();
        expect(sinceOldest).toBeGreaterThanOrEqual(24 * HOUR);
        expect(sinceOldest).toBeLessThanOrEqual(24 * HOUR + 1);
        expectAboutHoursFromNow(body.retryAvailableAt, 14); // the oldest is 10 hours old
      });

      it('ignores attempts already outside the window', async () => {
        await seed(
          { outcome: 'declined', minutesAgo: 30 * 60 },
          { outcome: 'declined', minutesAgo: 600 },
          { outcome: 'declined', minutesAgo: 300 },
          { outcome: 'declined', minutesAgo: 100 },
        );
        const { body } = await getStatus();

        // From the 10-hour-old attempt, not the 30-hour-old one.
        expectAboutHoursFromNow(body.retryAvailableAt, 14);
        expect(body.retryAvailableAt).toBe(await oldestCountedLeavesAt());
      });

      it("agrees with the 429's retryAfterSeconds", async () => {
        await didit3Declines();

        const { body } = await getStatus();
        const limit = await start().expect(429);

        expect(limit.body.code).toBe('VERIFICATION_RETRY_LIMIT');
        const secondsFromNow =
          (Date.parse(body.retryAvailableAt) - Date.now()) / 1000;
        expect(
          Math.abs(secondsFromNow - limit.body.retryAfterSeconds),
        ).toBeLessThanOrEqual(2);
      });

      it('becomes null once the oldest attempt leaves the window', async () => {
        await seed(
          { outcome: 'declined', minutesAgo: 24 * 60 - 5 },
          { outcome: 'declined', minutesAgo: 30 },
          { outcome: 'declined', minutesAgo: 20 },
        );
        expectAboutHoursFromNow(
          (await getStatus()).body.retryAvailableAt,
          5 / 60,
        );

        await db.query(
          `UPDATE identity_verifications SET created_at = created_at - interval '10 minutes'
           WHERE created_at = (SELECT min(created_at) FROM identity_verifications)`,
        );
        expect((await getStatus()).body).toMatchObject({
          canRetry: true,
          retriesLeftToday: 1,
          retryAvailableAt: null,
        });
      });

      it('is null for a blocked user at the limit (hard rule 10)', async () => {
        await seed(
          { outcome: 'declined' },
          { outcome: 'declined' },
          { outcome: 'blocked', declineReason: 'BANNED_IDENTITY' },
        );

        expect((await getStatus()).body.retryAvailableAt).toBeNull();
      });

      it.each(['approved', 'manual_review'])(
        'is null for a %s user at the limit',
        async (outcome) => {
          await seed(
            { outcome: 'declined' },
            { outcome: 'declined' },
            { outcome },
          );

          expect((await getStatus()).body.retryAvailableAt).toBeNull();
        },
      );
    });

    it('requires a signed-in user', async () => {
      await http().get('/verification/status').expect(401);
    });
  });

  describe('canRetry always agrees with POST /verification/sessions', () => {
    const scenarios: [string, Seed[]][] = [
      ['new user', []],
      ['recent pending', [{ outcome: 'pending', minutesAgo: 5 }]],
      [
        'old pending, below the limit',
        [{ outcome: 'pending', minutesAgo: 90 }],
      ],
      ['one decline', [{ outcome: 'declined' }]],
      [
        'three declines',
        [
          { outcome: 'declined' },
          { outcome: 'declined' },
          { outcome: 'declined' },
        ],
      ],
      [
        'limit with pending',
        [
          { outcome: 'declined' },
          { outcome: 'declined' },
          { outcome: 'pending', minutesAgo: 90 },
        ],
      ],
      [
        'limit, staff decline',
        [
          { outcome: 'declined' },
          { outcome: 'declined' },
          { outcome: 'declined', decidedByStaff: true },
        ],
      ],
      [
        'abandoned + expired + decline',
        [
          { outcome: 'abandoned' },
          { outcome: 'expired' },
          { outcome: 'declined' },
        ],
      ],
      [
        'old attempts outside the window',
        [
          { outcome: 'declined', minutesAgo: 25 * 60 },
          { outcome: 'declined', minutesAgo: 26 * 60 },
          { outcome: 'declined', minutesAgo: 27 * 60 },
        ],
      ],
      ['approved', [{ outcome: 'approved' }]],
      ['manual_review', [{ outcome: 'manual_review' }]],
      ['blocked', [{ outcome: 'blocked' }]],
    ];

    it.each(scenarios)('%s', async (_label, attempts) => {
      await seed(...attempts);

      const { canRetry, retryAvailableAt } = (await getStatus()).body as {
        canRetry: boolean;
        retryAvailableAt: string | null;
      };
      const { status, body } = await start();

      expect(status === 201).toBe(canRetry);
      // Set exactly when POST says "out of tries" (V3), never for other refusals.
      expect(retryAvailableAt !== null).toBe(
        status === 429 && body.code === 'VERIFICATION_RETRY_LIMIT',
      );
    });
  });

  describe('POST /verification/manual-review-request', () => {
    it('moves the latest Didit-declined attempt to manual_review at the limit', async () => {
      await didit3Declines();

      const response = await requestReview().expect(200);

      expect(response.body).toEqual({
        status: 'manual_review',
        canRetry: false,
        retriesLeftToday: 0,
        canRequestManualReview: false,
        retryAvailableAt: null,
      });
      const rows = await db.query<{ outcome: string; requested: boolean }[]>(
        `SELECT outcome, manual_review_requested_at IS NOT NULL AS requested
         FROM identity_verifications ORDER BY created_at`,
      );
      expect(rows).toEqual([
        { outcome: 'declined', requested: false },
        { outcome: 'declined', requested: false },
        { outcome: 'manual_review', requested: true },
      ]);
      const [{ s }] = await db.query<{ s: string }[]>(
        `SELECT verification_status AS s FROM users`,
      );
      expect(s).toBe('manual_review');
      // And a new session is now refused (V13).
      expect((await start().expect(409)).body).toEqual({
        code: 'VERIFICATION_IN_REVIEW',
      });
    });

    it.each<[string, Seed[]]>([
      ['below the limit', [{ outcome: 'declined' }, { outcome: 'declined' }]],
      [
        'latest declined by our checks (UNDERAGE)',
        [
          { outcome: 'declined' },
          { outcome: 'declined' },
          {
            outcome: 'declined',
            providerStatus: 'Approved',
            declineReason: 'UNDERAGE',
          },
        ],
      ],
      [
        'latest declined by staff',
        [
          { outcome: 'declined' },
          { outcome: 'declined' },
          { outcome: 'declined', decidedByStaff: true },
        ],
      ],
      [
        'latest still pending',
        [
          { outcome: 'declined' },
          { outcome: 'declined' },
          { outcome: 'pending', minutesAgo: 90 },
        ],
      ],
      ['no attempts', []],
    ])(
      'is refused %s (MANUAL_REVIEW_NOT_AVAILABLE)',
      async (_label, attempts) => {
        await seed(...attempts);

        const response = await requestReview().expect(409);

        expect(response.body).toEqual({ code: 'MANUAL_REVIEW_NOT_AVAILABLE' });
        const [{ n }] = await db.query<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM identity_verifications WHERE outcome = 'manual_review'`,
        );
        expect(n).toBe(0);
      },
    );

    it.each([
      ['approved', 409, 'ALREADY_VERIFIED'],
      ['manual_review', 409, 'VERIFICATION_IN_REVIEW'],
      ['blocked', 403, 'VERIFICATION_UNAVAILABLE'],
    ])('a %s user gets %i %s', async (outcome, status, code) => {
      await seed({ outcome });

      expect((await requestReview().expect(status)).body).toEqual({ code });
    });

    it('a second request gets VERIFICATION_IN_REVIEW', async () => {
      await didit3Declines();
      await requestReview().expect(200);

      expect((await requestReview().expect(409)).body).toEqual({
        code: 'VERIFICATION_IN_REVIEW',
      });
    });

    it('accepts exactly one of several concurrent requests', async () => {
      await didit3Declines();

      const statuses = await Promise.all(
        Array.from({ length: 5 }, () => requestReview().then((r) => r.status)),
      );

      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(4);
    });

    it('ignores a request body (the route takes no input)', async () => {
      await didit3Declines();

      await requestReview().send({ reason: 'please' }).expect(200);
    });

    it('requires a signed-in user', async () => {
      await http().post('/verification/manual-review-request').expect(401);
    });
  });

  it('the V3 429 no longer offers manual review after a staff decline', async () => {
    await seed(
      { outcome: 'declined' },
      { outcome: 'declined' },
      { outcome: 'declined', decidedByStaff: true },
    );

    const response = await start().expect(429);

    expect(response.body).toMatchObject({
      code: 'VERIFICATION_RETRY_LIMIT',
      manualReviewAvailable: false,
    });
  });
});
