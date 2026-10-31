import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { DiditApiError } from '../src/modules/verification/didit/didit-api.error.js';
import { DiditClient } from '../src/modules/verification/didit/didit-client.js';
import { DiditStatus } from '../src/modules/verification/didit/didit.types.js';
import { VerificationPollingJob } from '../src/modules/verification/verification-polling.job.js';
import {
  POLL_BATCH_SIZE,
  VerificationPollingService,
} from '../src/modules/verification/verification-polling.service.js';
import { FakeDiditClient } from './fakes/fake-didit-client.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import { signIn } from './utils/sign-in.js';

const FAYDA = {
  status: 'Approved',
  documentType: 'Identity Card',
  issuingState: 'ETH',
  documentNumber: '123456789012',
  dateOfBirth: '1990-05-17',
  fullName: 'Abebe Kebede',
};

describe('verification polling (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let polling: VerificationPollingService;
  const sms = new FakeSmsSender();
  const didit = new FakeDiditClient();
  let phoneCounter = 0;

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b
        .overrideProvider(SmsSender)
        .useValue(sms)
        .overrideProvider(DiditClient)
        .useValue(didit),
    );
    db = app.get(DataSource);
    polling = app.get(VerificationPollingService);
  });

  afterEach(async () => {
    sms.clear();
    didit.reset();
    vi.restoreAllMocks();
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const userWithAttempt = async () => {
    const phone = `+2519120000${String(++phoneCounter).padStart(2, '0')}`;
    const { accessToken } = await signIn(app, sms, phone);
    await request(app.getHttpServer())
      .post('/verification/sessions')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(201);
    const [row] = await db.query<
      { id: string; user_id: string; provider_session_id: string }[]
    >(
      `SELECT a.id, a.user_id, a.provider_session_id FROM identity_verifications a
       JOIN users u ON u.id = a.user_id WHERE u.phone = $1 ORDER BY a.created_at DESC LIMIT 1`,
      [phone],
    );
    return {
      accessToken,
      attemptId: row.id,
      userId: row.user_id,
      sessionId: row.provider_session_id,
    };
  };

  /** Moves the attempt's clocks back: pending_since (and created_at unless given separately). */
  const pendingFor = (
    attemptId: string,
    minutes: number,
    createdMinutesAgo = minutes,
  ) =>
    db.query(
      `UPDATE identity_verifications
       SET pending_since = clock_timestamp() - make_interval(mins => $2),
           created_at = clock_timestamp() - make_interval(mins => $3)
       WHERE id = $1`,
      [attemptId, minutes, createdMinutesAgo],
    );

  const attempt = async (attemptId: string) =>
    (
      await db.query<
        {
          outcome: string;
          provider_status: string;
          verification_url: string | null;
          session_token: string | null;
          completed: boolean;
        }[]
      >(
        `SELECT outcome, provider_status, verification_url, session_token, completed_at IS NOT NULL AS completed
         FROM identity_verifications WHERE id = $1`,
        [attemptId],
      )
    )[0];

  const userStatus = async (userId: string) =>
    (
      await db.query<{ s: string }[]>(
        `SELECT verification_status AS s FROM users WHERE id = $1`,
        [userId],
      )
    )[0].s;

  describe('which attempts are polled', () => {
    it('leaves an attempt pending for under 10 minutes alone', async () => {
      const a = await userWithAttempt();
      await pendingFor(a.attemptId, 9);
      const fetch = vi.spyOn(didit, 'getDecision');

      expect(await polling.runOnce()).toMatchObject({ polled: 0 });
      expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
      'abandoned',
      'expired',
      'approved',
      'declined',
      'blocked',
      'manual_review',
    ])('never polls a %s attempt', async (outcome) => {
      const a = await userWithAttempt();
      await pendingFor(a.attemptId, 60);
      await db.query(
        `UPDATE identity_verifications SET outcome = $2, verification_url = NULL, session_token = NULL WHERE id = $1`,
        [a.attemptId, outcome],
      );
      const fetch = vi.spyOn(didit, 'getDecision');

      await polling.runOnce();

      expect(fetch).not.toHaveBeenCalled();
    });

    it('polls oldest first, at most POLL_BATCH_SIZE per pass', async () => {
      const a = await userWithAttempt();
      // 105 extra pending attempts whose sessions Didit doesn't know (each pass expires 100).
      await db.query(
        `INSERT INTO identity_verifications
           (user_id, provider_session_id, provider_status, verification_url, session_token, pending_since, created_at)
         SELECT $1, 'unknown-' || g, 'Not Started', 'u', 't',
                clock_timestamp() - make_interval(mins => 30 + g), clock_timestamp() - make_interval(mins => 30 + g)
         FROM generate_series(1, 105) g`,
        [a.userId],
      );
      await pendingFor(a.attemptId, 20); // the youngest
      const fetch = vi.spyOn(didit, 'getDecision');

      const first = await polling.runOnce();

      expect(fetch).toHaveBeenCalledTimes(POLL_BATCH_SIZE);
      expect(fetch.mock.calls[0][0]).toBe('unknown-105'); // the oldest
      expect(first.notFound).toBe(POLL_BATCH_SIZE);
      expect(fetch.mock.calls.map((c) => c[0])).not.toContain(a.sessionId);

      fetch.mockClear();
      await polling.runOnce();
      expect(fetch).toHaveBeenCalledTimes(6); // the remaining 5 + ours
    });
  });

  describe('applying what Didit says (same DecisionService as the webhook)', () => {
    it('approves through our checks and updates the user', async () => {
      const a = await userWithAttempt();
      await pendingFor(a.attemptId, 15);
      didit.setStatus(a.sessionId, DiditStatus.Approved);
      didit.setIdVerifications(a.sessionId, [FAYDA]);

      expect(await polling.runOnce()).toMatchObject({ polled: 1, errors: 0 });

      expect((await attempt(a.attemptId)).outcome).toBe('approved');
      expect(await userStatus(a.userId)).toBe('approved');
      const [{ n }] = await db.query<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM identity_hashes WHERE verification_id = $1 AND is_approved`,
        [a.attemptId],
      );
      expect(n).toBe(1);
    });

    it('declines on Didit Declined', async () => {
      const a = await userWithAttempt();
      await pendingFor(a.attemptId, 15);
      didit.setStatus(a.sessionId, DiditStatus.Declined);

      await polling.runOnce();

      expect((await attempt(a.attemptId)).outcome).toBe('declined');
    });

    it('records a non-final status and keeps the attempt pending', async () => {
      const a = await userWithAttempt();
      await pendingFor(a.attemptId, 15);
      didit.setStatus(a.sessionId, DiditStatus.InProgress);

      await polling.runOnce();

      expect(await attempt(a.attemptId)).toMatchObject({
        outcome: 'pending',
        provider_status: 'In Progress',
      });
    });

    it('never lets a stale poll result overwrite a newer webhook decision (V12)', async () => {
      const a = await userWithAttempt();
      await pendingFor(a.attemptId, 15);
      didit.setStatus(a.sessionId, DiditStatus.InProgress);
      const realFetch = didit.getDecision.bind(didit);
      vi.spyOn(didit, 'getDecision').mockImplementation(async (sessionId) => {
        const stale = await realFetch(sessionId);
        // Meanwhile the webhook approves the attempt.
        await db.query(
          `UPDATE identity_verifications SET outcome = 'approved', verification_url = NULL, session_token = NULL WHERE id = $1`,
          [a.attemptId],
        );
        return stale;
      });

      await polling.runOnce();

      expect(await attempt(a.attemptId)).toMatchObject({
        outcome: 'approved',
        provider_status: 'In Progress',
      });
    });
  });

  describe('V16: 24 hours pending', () => {
    it('expires an attempt still pending at Didit after 24 h: URL and token cleared, user recomputed', async () => {
      const a = await userWithAttempt();
      await pendingFor(a.attemptId, 24 * 60 + 1);
      didit.setStatus(a.sessionId, DiditStatus.InProgress);

      expect(await polling.runOnce()).toMatchObject({ polled: 1, expired: 1 });

      expect(await attempt(a.attemptId)).toMatchObject({
        outcome: 'expired',
        provider_status: 'In Progress', // from its last poll
        verification_url: null,
        session_token: null,
        completed: true,
      });
      expect(await userStatus(a.userId)).toBe('not_verified');
    });

    it('gives it a last poll first: approved, not expired, if Didit approved it', async () => {
      const a = await userWithAttempt();
      await pendingFor(a.attemptId, 25 * 60);
      didit.setStatus(a.sessionId, DiditStatus.Approved);
      didit.setIdVerifications(a.sessionId, [FAYDA]);

      expect(await polling.runOnce()).toMatchObject({ polled: 1, expired: 0 });
      expect((await attempt(a.attemptId)).outcome).toBe('approved');
    });

    it('does not expire a reopened attempt: the clock counts from pending_since, not created_at', async () => {
      const a = await userWithAttempt();
      // Created 26 h ago, reopened 20 minutes ago (the T2.4 "day 2" case).
      await pendingFor(a.attemptId, 20, 26 * 60);
      didit.setStatus(a.sessionId, DiditStatus.InProgress);

      expect(await polling.runOnce()).toMatchObject({ polled: 1, expired: 0 });
      expect((await attempt(a.attemptId)).outcome).toBe('pending');
    });

    it('a reopen through POST /verification/sessions restarts pending_since', async () => {
      const a = await userWithAttempt();
      didit.setStatus(a.sessionId, DiditStatus.InProgress);
      await pendingFor(a.attemptId, 25 * 60);
      await polling.runOnce(); // expired by V16
      expect((await attempt(a.attemptId)).outcome).toBe('expired');

      // Day 2: Didit still has the session open, so starting again reopens it.
      await request(app.getHttpServer())
        .post('/verification/sessions')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .expect(201);
      expect((await attempt(a.attemptId)).outcome).toBe('pending');

      // The next passes don't expire it again (the loop the column exists to prevent).
      await polling.runOnce();
      expect((await attempt(a.attemptId)).outcome).toBe('pending');
    });
  });

  describe('Didit 404: session not found', () => {
    it('expires the attempt at once, with provider_status NOT_FOUND', async () => {
      const a = await userWithAttempt();
      await db.query(
        `UPDATE identity_verifications SET provider_session_id = 'deleted-at-didit' WHERE id = $1`,
        [a.attemptId],
      );
      await pendingFor(a.attemptId, 15); // nowhere near 24 h

      expect(await polling.runOnce()).toMatchObject({ notFound: 1, errors: 0 });

      expect(await attempt(a.attemptId)).toMatchObject({
        outcome: 'expired',
        provider_status: 'NOT_FOUND',
        verification_url: null,
        session_token: null,
      });
      expect(await userStatus(a.userId)).toBe('not_verified');
    });

    it('so at the V3 limit the user is no longer handed the dead session', async () => {
      const a = await userWithAttempt();
      // Two earlier sessions in the window, finished elsewhere.
      await db.query(
        `INSERT INTO identity_verifications (user_id, provider_session_id, provider_status, outcome)
         VALUES ($1, 'older-1', 'Declined', 'declined'), ($1, 'older-2', 'Declined', 'declined')`,
        [a.userId],
      );
      await db.query(
        `UPDATE identity_verifications SET provider_session_id = 'deleted-at-didit' WHERE id = $1`,
        [a.attemptId],
      );
      await pendingFor(a.attemptId, 15);

      await polling.runOnce();

      const response = await request(app.getHttpServer())
        .post('/verification/sessions')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .expect(429);
      expect(response.body.code).toBe('VERIFICATION_RETRY_LIMIT');
    });

    it.each([
      new DiditApiError('timeout', 'timed out'),
      new DiditApiError('server', 'boom', 503),
      new DiditApiError('rate_limited', 'slow down', 429, 30),
    ])(
      'leaves the attempt pending on a Didit $kind error and carries on with the rest',
      async (error) => {
        const older = await userWithAttempt();
        const newer = await userWithAttempt();
        await pendingFor(older.attemptId, 30);
        await pendingFor(newer.attemptId, 15);
        didit.setStatus(newer.sessionId, DiditStatus.Declined);
        didit.failNextWith(error); // the first call: the older attempt

        expect(await polling.runOnce()).toMatchObject({
          polled: 1,
          errors: 1,
          notFound: 0,
        });

        expect((await attempt(older.attemptId)).outcome).toBe('pending');
        expect((await attempt(newer.attemptId)).outcome).toBe('declined');
      },
    );
  });

  it('runs one pass at a time: a concurrent pass is skipped', async () => {
    const a = await userWithAttempt();
    await pendingFor(a.attemptId, 15);
    const realFetch = didit.getDecision.bind(didit);
    vi.spyOn(didit, 'getDecision').mockImplementation(async (id) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return realFetch(id);
    });

    const [first, second] = await Promise.all([
      polling.runOnce(),
      polling.runOnce(),
    ]);

    // Exactly one of the two passes ran; the other found the lock taken.
    expect([first.skipped, second.skipped].filter(Boolean)).toHaveLength(1);
  });

  it('the cron job does nothing when JOBS_ENABLED=false (as in tests)', async () => {
    const runOnce = vi.spyOn(polling, 'runOnce');

    await app.get(VerificationPollingJob).tick();

    expect(runOnce).not.toHaveBeenCalled();
  });
});
