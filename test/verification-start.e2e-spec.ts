import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { DiditApiError } from '../src/modules/verification/didit/didit-api.error.js';
import { DiditClient } from '../src/modules/verification/didit/didit-client.js';
import { DiditStatus } from '../src/modules/verification/didit/didit.types.js';
import { VerificationStatusService } from '../src/modules/verification/verification-status.service.js';
import { FakeDiditClient } from './fakes/fake-didit-client.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import { signIn } from './utils/sign-in.js';

const PHONE = '+251911234567';

interface AttemptRow {
  id: string;
  provider_session_id: string;
  provider_status: string;
  outcome: string;
  verification_url: string | null;
  session_token: string | null;
  flag_reason: string | null;
}

describe('POST /verification/sessions (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  const sms = new FakeSmsSender();
  const didit = new FakeDiditClient();
  let accessToken: string;
  let userId: string;

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
    ({ accessToken } = await signIn(app, sms, PHONE));
    userId = (await db.query<{ id: string }[]>(`SELECT id FROM users`))[0].id;
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

  const start = (token = accessToken) =>
    request(app.getHttpServer())
      .post('/verification/sessions')
      .set('Authorization', `Bearer ${token}`);

  const attempts = () =>
    db.query<AttemptRow[]>(
      `SELECT id, provider_session_id, provider_status, outcome, verification_url,
              session_token, flag_reason
       FROM identity_verifications ORDER BY created_at`,
    );

  const userStatus = async () =>
    (
      await db.query<{ s: string }[]>(
        `SELECT verification_status AS s FROM users`,
      )
    )[0].s;

  const setUserStatus = (status: string) =>
    db.query(`UPDATE users SET verification_status = $1`, [status]);

  /** Moves an attempt's creation time back, as if created `minutes` ago. */
  const age = (attemptId: string, minutes: number) =>
    db.query(
      `UPDATE identity_verifications
       SET created_at = clock_timestamp() - make_interval(mins => $2) WHERE id = $1`,
      [attemptId, minutes],
    );

  /**
   * Creates one session and lets it finish at Didit (so Didit won't reuse it), aged past the V2
   * window. Locally it stays pending, as if the webhook hadn't arrived yet.
   */
  const startFinishedSession = async (
    minutesAgo = 31,
    diditStatus = DiditStatus.Declined,
  ) => {
    await start().expect(201);
    const latest = (await attempts()).at(-1)!;
    didit.setStatus(latest.provider_session_id, diditStatus);
    await age(latest.id, minutesAgo);
    return latest;
  };

  describe('creating a session', () => {
    it('creates a pending attempt, sets the user pending and returns the Didit URL and token', async () => {
      const response = await start().expect(201);

      const [attempt] = await attempts();
      expect(response.body).toEqual({
        verificationUrl: attempt.verification_url,
        sessionToken: attempt.session_token,
      });
      expect(response.body.verificationUrl).toMatch(
        /^https:\/\/verify\.didit\.me\/session\//,
      );
      expect(attempt).toMatchObject({
        outcome: 'pending',
        provider_status: 'Not Started',
      });
      expect(await userStatus()).toBe('pending');
      expect(didit.createdCount).toBe(1);
    });

    it('requires a signed-in user', async () => {
      await request(app.getHttpServer())
        .post('/verification/sessions')
        .expect(401);
    });
  });

  describe('V1 and V13: who may start', () => {
    it.each([
      ['approved', 409, 'ALREADY_VERIFIED'],
      ['manual_review', 409, 'VERIFICATION_IN_REVIEW'],
      ['blocked', 403, 'VERIFICATION_UNAVAILABLE'],
    ])(
      'a %s user gets %i %s and Didit is not called',
      async (status, httpStatus, code) => {
        await setUserStatus(status);

        const response = await start().expect(httpStatus);

        expect(response.body).toEqual({ code });
        expect(didit.createdCount).toBe(0);
        expect(await attempts()).toHaveLength(0);
      },
    );

    it.each(['not_verified', 'declined'])(
      'a %s user may start',
      async (status) => {
        await setUserStatus(status);

        await start().expect(201);
      },
    );
  });

  describe('V2: resume', () => {
    it('returns the same session for a pending attempt younger than 30 minutes, without calling Didit', async () => {
      const first = await start().expect(201);
      const createSpy = vi.spyOn(didit, 'createSession');
      await age((await attempts())[0].id, 29);

      const second = await start().expect(201);

      expect(second.body).toEqual(first.body);
      expect(createSpy).not.toHaveBeenCalled();
      expect(await attempts()).toHaveLength(1);
    });

    it('creates a new session once the pending attempt is 30 minutes old (if Didit finished it)', async () => {
      await startFinishedSession(30);

      await start().expect(201);

      expect(await attempts()).toHaveLength(2);
      expect(didit.createdCount).toBe(2);
    });
  });

  describe('Didit reusing an unfinished session', () => {
    it('is a resume: refreshes URL and token, adds no attempt and does not count toward V3', async () => {
      await start().expect(201);
      const [attempt] = await attempts();
      await age(attempt.id, 45); // past V2, but Didit still has it unfinished
      await db.query(
        `UPDATE identity_verifications SET verification_url = 'stale', session_token = 'stale'`,
      );

      const response = await start().expect(201);

      const rows = await attempts();
      expect(rows).toHaveLength(1);
      expect(rows[0].verification_url).toBe(response.body.verificationUrl);
      expect(rows[0].verification_url).not.toBe('stale');
      expect(didit.createdCount).toBe(1);
    });

    it('reopens an attempt we had marked abandoned while Didit still has it unfinished', async () => {
      await start().expect(201);
      const [attempt] = await attempts();
      await db.query(
        `UPDATE identity_verifications
         SET outcome = 'abandoned', verification_url = NULL, session_token = NULL`,
      );
      await age(attempt.id, 45);

      await start().expect(201);

      const [reopened] = await attempts();
      expect(reopened).toMatchObject({ id: attempt.id, outcome: 'pending' });
      expect(reopened.verification_url).not.toBeNull();
      expect(await userStatus()).toBe('pending');
    });

    it('reopens an attempt V16 expired after 24 h while Didit (7-day sessions) still has it open', async () => {
      // Day 1: the user starts, gets part-way through, then leaves.
      await start().expect(201);
      const [attempt] = await attempts();
      didit.setStatus(attempt.provider_session_id, DiditStatus.InProgress);
      // 26 hours later the polling job has expired it locally (V16) and cleared its URL/token.
      await age(attempt.id, 26 * 60);
      await db.query(
        `UPDATE identity_verifications
         SET outcome = 'expired', verification_url = NULL, session_token = NULL`,
      );
      await new VerificationStatusService().recomputeVerificationStatus(
        userId,
        db.manager,
      );
      expect(await userStatus()).toBe('not_verified');

      // Day 2: the user comes back. Didit returns the same, still-open session.
      const response = await start().expect(201);

      const rows = await attempts();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: attempt.id,
        outcome: 'pending',
        provider_status: 'In Progress',
        verification_url: response.body.verificationUrl,
        session_token: response.body.sessionToken,
      });
      expect(rows[0].flag_reason).toBeNull();
      expect(await userStatus()).toBe('pending');
      expect(didit.createdCount).toBe(1);

      // And again later the same day: still a resume, never a 503.
      await age(attempt.id, 27 * 60);
      await start().expect(201);
      expect(await attempts()).toHaveLength(1);
    });

    it.each(['declined', 'approved', 'blocked', 'manual_review'])(
      'flags a conflict and returns 503 when Didit returns an attempt that is %s locally',
      async (outcome) => {
        await start().expect(201);
        const [attempt] = await attempts();
        await db.query(
          `UPDATE identity_verifications
           SET outcome = $1, verification_url = NULL, session_token = NULL`,
          [outcome],
        );
        await age(attempt.id, 45);

        const response = await start().expect(503);

        expect(response.body).toEqual({
          code: 'VERIFICATION_PROVIDER_UNAVAILABLE',
        });
        const rows = await attempts();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          outcome,
          flag_reason: 'PROVIDER_SESSION_STATE_CONFLICT',
        });
      },
    );

    it('does not overwrite an existing flag on a conflicting attempt', async () => {
      await start().expect(201);
      const [attempt] = await attempts();
      await db.query(
        `UPDATE identity_verifications
         SET outcome = 'blocked', verification_url = NULL, session_token = NULL,
             flagged_at = now(), flag_reason = 'DUPLICATE_IDENTITY'`,
      );
      await age(attempt.id, 45);

      await start().expect(503);

      expect((await attempts())[0].flag_reason).toBe('DUPLICATE_IDENTITY');
    });
  });

  describe('V14: superseding', () => {
    it('marks the older pending attempt abandoned and clears its URL and token', async () => {
      const older = await startFinishedSession();

      await start().expect(201);

      const [abandoned, current] = await attempts();
      expect(abandoned).toMatchObject({
        id: older.id,
        outcome: 'abandoned',
        verification_url: null,
        session_token: null,
      });
      expect(current.outcome).toBe('pending');
      expect(await userStatus()).toBe('pending');
    });
  });

  describe('V3: retry limit', () => {
    it('allows 3 sessions per 24 hours, then VERIFICATION_RETRY_LIMIT with Retry-After', async () => {
      await startFinishedSession(120);
      await startFinishedSession(60);
      await startFinishedSession(31);
      // Didit's webhook for the 3rd has arrived, so nothing is pending (else it's resumed).
      await db.query(
        `UPDATE identity_verifications
         SET outcome = 'declined', provider_status = 'Approved', decline_reason = 'UNDERAGE',
             verification_url = NULL, session_token = NULL
         WHERE outcome = 'pending'`,
      );

      const response = await start().expect(429);

      expect(response.body).toMatchObject({
        code: 'VERIFICATION_RETRY_LIMIT',
        manualReviewAvailable: false,
      });
      // The oldest counted attempt (120 minutes old) leaves the window in about 22 hours.
      const expected = 22 * 3600;
      expect(response.body.retryAfterSeconds).toBeGreaterThan(expected - 60);
      expect(response.body.retryAfterSeconds).toBeLessThanOrEqual(expected);
      expect(response.headers['retry-after']).toBe(
        String(response.body.retryAfterSeconds),
      );
      expect(didit.createdCount).toBe(3);
    });

    it('counts abandoned and expired attempts too', async () => {
      await startFinishedSession(120);
      await startFinishedSession(60);
      await startFinishedSession(31);
      await db.query(
        `UPDATE identity_verifications
         SET outcome = 'expired', verification_url = NULL, session_token = NULL`,
      );

      await start().expect(429);
    });

    it('stops counting an attempt once it is older than 24 hours', async () => {
      const oldest = await startFinishedSession(120);
      await startFinishedSession(60);
      await startFinishedSession(31);
      await age(oldest.id, 24 * 60 + 1);

      await start().expect(201);
    });

    it('offers manual review when the latest attempt was declined by Didit', async () => {
      await startFinishedSession(120);
      await startFinishedSession(60);
      const latest = await startFinishedSession(31);
      await db.query(
        `UPDATE identity_verifications
         SET outcome = 'declined', provider_status = 'Declined',
             verification_url = NULL, session_token = NULL
         WHERE id = $1`,
        [latest.id],
      );
      await new VerificationStatusService().recomputeVerificationStatus(
        userId,
        db.manager,
      );

      const response = await start().expect(429);
      expect(response.body.manualReviewAvailable).toBe(true);
    });

    it('does not offer manual review when we declined an approval (e.g. underage)', async () => {
      await startFinishedSession(120);
      await startFinishedSession(60);
      const latest = await startFinishedSession(31);
      await db.query(
        `UPDATE identity_verifications
         SET outcome = 'declined', provider_status = 'Approved', decline_reason = 'UNDERAGE',
             verification_url = NULL, session_token = NULL
         WHERE id = $1`,
        [latest.id],
      );
      await new VerificationStatusService().recomputeVerificationStatus(
        userId,
        db.manager,
      );

      const response = await start().expect(429);
      expect(response.body.manualReviewAvailable).toBe(false);
    });

    it('does not count a resume', async () => {
      await startFinishedSession(120);
      await startFinishedSession(60);
      await start().expect(201); // 3rd session, left unfinished at Didit
      const third = (await attempts()).at(-1)!;
      await age(third.id, 45);

      await start().expect(201); // Didit reuses it: a resume
      await start().expect(201); // and again

      expect(await attempts()).toHaveLength(3);
    });
  });

  describe('V3 limit with a pending attempt (resume from stored data)', () => {
    it('resumes a pending attempt of any age from stored data, without calling Didit', async () => {
      await startFinishedSession(300);
      await startFinishedSession(200);
      const first = await start().expect(201); // 3rd session; then it ages past V2
      const third = (await attempts()).at(-1)!;
      await age(third.id, 120);
      const createSpy = vi.spyOn(didit, 'createSession');

      const response = await start().expect(201);

      expect(response.body).toEqual(first.body);
      expect(createSpy).not.toHaveBeenCalled();
      expect(await attempts()).toHaveLength(3);
    });

    it('still returns VERIFICATION_RETRY_LIMIT when no attempt is pending', async () => {
      await startFinishedSession(300);
      await startFinishedSession(200);
      const third = await startFinishedSession(100);
      await db.query(
        `UPDATE identity_verifications
         SET outcome = 'declined', provider_status = 'Declined',
             verification_url = NULL, session_token = NULL
         WHERE id = $1`,
        [third.id],
      );
      await db.query(
        `UPDATE identity_verifications
         SET outcome = 'abandoned', verification_url = NULL, session_token = NULL
         WHERE outcome = 'pending'`,
      );
      const createSpy = vi.spyOn(didit, 'createSession');

      await start().expect(429);
      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  describe('Didit failures', () => {
    it('returns 503 with Retry-After on a Didit 429 and changes nothing', async () => {
      const older = await startFinishedSession();
      didit.failNextWith(
        new DiditApiError('rate_limited', 'slow down', 429, 30),
      );

      const response = await start().expect(503);

      expect(response.body).toEqual({
        code: 'VERIFICATION_PROVIDER_UNAVAILABLE',
        retryAfterSeconds: 30,
      });
      expect(response.headers['retry-after']).toBe('30');
      // Rolled back: the older attempt was not superseded.
      const rows = await attempts();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: older.id, outcome: 'pending' });
    });

    it.each([
      new DiditApiError('timeout', 'timed out'),
      new DiditApiError('auth', 'check DIDIT_API_KEY', 403),
      new DiditApiError('server', 'boom', 500),
    ])(
      'returns 503 without Retry-After for a Didit $kind error',
      async (error) => {
        didit.failNextWith(error);

        const response = await start().expect(503);

        expect(response.body).toEqual({
          code: 'VERIFICATION_PROVIDER_UNAVAILABLE',
        });
        expect(response.headers['retry-after']).toBeUndefined();
        expect(await attempts()).toHaveLength(0);
        expect(await userStatus()).toBe('not_verified');
      },
    );
  });

  it('creates exactly one attempt under concurrent starts', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => start()),
    );

    expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(responses.map((r) => r.body.sessionToken)).size).toBe(1);
    expect(await attempts()).toHaveLength(1);
    expect(didit.createdCount).toBe(1);
  });
});

describe('recomputeVerificationStatus (e2e, writes users.verification_status)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let service: VerificationStatusService;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DataSource);
    service = app.get(VerificationStatusService);
  });

  afterEach(async () => {
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const createUser = async (phone: string) =>
    (
      await db.query<{ id: string }[]>(
        `INSERT INTO users (phone) VALUES ($1) RETURNING id`,
        [phone],
      )
    )[0].id;

  const addAttempt = (userId: string, outcome: string, minutesAgo: number) =>
    db.query(
      `INSERT INTO identity_verifications (user_id, provider_session_id, provider_status, outcome, created_at)
       VALUES ($1, gen_random_uuid()::text, 'x', $2, now() - make_interval(mins => $3))`,
      [userId, outcome, minutesAgo],
    );

  const statusOf = async (userId: string) =>
    (
      await db.query<{ s: string }[]>(
        `SELECT verification_status AS s FROM users WHERE id = $1`,
        [userId],
      )
    )[0].s;

  it.each<[string, [string, number][], string]>([
    ['no attempts', [], 'not_verified'],
    [
      'blocked beats approved',
      [
        ['approved', 10],
        ['blocked', 20],
      ],
      'blocked',
    ],
    [
      'approved beats a newer decline',
      [
        ['approved', 30],
        ['declined', 5],
      ],
      'approved',
    ],
    [
      'the newest counted attempt wins',
      [
        ['declined', 30],
        ['manual_review', 20],
        ['pending', 10],
      ],
      'pending',
    ],
    [
      'newer abandoned/expired attempts are skipped',
      [
        ['declined', 30],
        ['abandoned', 20],
        ['expired', 10],
      ],
      'declined',
    ],
    [
      'only abandoned/expired → not_verified',
      [
        ['abandoned', 20],
        ['expired', 10],
      ],
      'not_verified',
    ],
  ])('%s', async (_label, rows, expected) => {
    const userId = await createUser('+251911000001');
    for (const [outcome, minutesAgo] of rows)
      await addAttempt(userId, outcome, minutesAgo);

    const result = await service.recomputeVerificationStatus(
      userId,
      db.manager,
    );

    expect(result).toBe(expected);
    expect(await statusOf(userId)).toBe(expected);
  });

  it('only changes that user', async () => {
    const alice = await createUser('+251911000001');
    const bob = await createUser('+251911000002');
    await addAttempt(alice, 'blocked', 5);
    await db.query(
      `UPDATE users SET verification_status = 'approved' WHERE id = $1`,
      [bob],
    );

    await service.recomputeVerificationStatus(alice, db.manager);

    expect(await statusOf(alice)).toBe('blocked');
    expect(await statusOf(bob)).toBe('approved');
  });
});
