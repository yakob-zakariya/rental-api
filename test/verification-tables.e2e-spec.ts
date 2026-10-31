import { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import { DataSource, QueryFailedError } from 'typeorm';
import { insertTestAdmin } from './utils/admins.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';

// Database-level rules for the verification tables (T2.2). Raw SQL on purpose: these test the
// schema, not any service.
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
// A real admin row, created before each test (the admin id columns are foreign keys).
let ADMIN_ID: string;

describe('verification tables (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let sessionCounter = 0;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DataSource);
  });

  beforeEach(async () => {
    ADMIN_ID = await insertTestAdmin(db);
  });

  afterEach(async () => {
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const one = async <T>(sql: string, params: unknown[] = []) =>
    (await db.query<T[]>(sql, params))[0];

  const createUser = async (phone: string) =>
    (
      await one<{ id: string }>(
        `INSERT INTO users (phone) VALUES ($1) RETURNING id`,
        [phone],
      )
    ).id;

  const createAttempt = async (
    userId: string,
    columns: Record<string, unknown> = {},
  ) => {
    const values: Record<string, unknown> = {
      user_id: userId,
      provider_session_id: `session-${++sessionCounter}`,
      provider_status: 'Not Started',
      ...columns,
    };
    const names = Object.keys(values);
    const row = await one<{ id: string }>(
      `INSERT INTO identity_verifications (${names.join(', ')})
       VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(values),
    );
    return row.id;
  };

  const addHash = (
    verificationId: string,
    userId: string,
    hash: string,
    isApproved = false,
    kind = 'fayda_fin',
  ) =>
    db.query(
      `INSERT INTO identity_hashes (verification_id, user_id, kind, hash, is_approved)
       VALUES ($1, $2, $3, $4, $5)`,
      [verificationId, userId, kind, hash, isApproved],
    );

  const ban = (userId: string, hash: string) =>
    db.query(
      `INSERT INTO banned_identities (user_id, kind, hash, reason, banned_by_admin_id)
       VALUES ($1, 'fayda_fin', $2, 'fraud', $3)`,
      [userId, hash, ADMIN_ID],
    );

  const constraintOf = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(QueryFailedError);
    return (
      error as QueryFailedError & { driverError: { constraint?: string } }
    ).driverError.constraint;
  };

  describe('identity_verifications', () => {
    it('defaults to provider didit, outcome pending, nothing flagged or decided', async () => {
      const userId = await createUser('+251911000001');
      const id = await createAttempt(userId, {
        verification_url: 'https://verify.didit.me/session/abc',
        session_token: 'abcdefghijkl',
      });

      expect(
        await one(
          `SELECT provider, outcome, flagged_at, decided_at, created_at IS NOT NULL AS stamped
           FROM identity_verifications WHERE id = $1`,
          [id],
        ),
      ).toEqual({
        provider: 'didit',
        outcome: 'pending',
        flagged_at: null,
        decided_at: null,
        stamped: true,
      });
    });

    it('keeps provider_session_id unique', async () => {
      const userId = await createUser('+251911000001');
      await createAttempt(userId, { provider_session_id: 'same' });

      expect(
        await constraintOf(
          createAttempt(userId, { provider_session_id: 'same' }),
        ),
      ).toBe('UQ_identity_verifications_provider_session_id');
    });

    it.each([
      'approved',
      'declined',
      'manual_review',
      'blocked',
      'abandoned',
      'expired',
    ])('rejects a resume URL or token on a %s attempt', async (outcome) => {
      const userId = await createUser('+251911000001');

      for (const column of ['verification_url', 'session_token']) {
        expect(
          await constraintOf(createAttempt(userId, { outcome, [column]: 'x' })),
        ).toBe('CHK_identity_verifications_resume_only_pending');
      }
      await expect(createAttempt(userId, { outcome })).resolves.toBeDefined();
    });

    it('rejects clearing the outcome to final while the resume fields are still set', async () => {
      const userId = await createUser('+251911000001');
      const id = await createAttempt(userId, {
        verification_url: 'u',
        session_token: 't',
      });

      expect(
        await constraintOf(
          db.query(
            `UPDATE identity_verifications SET outcome = 'declined' WHERE id = $1`,
            [id],
          ),
        ),
      ).toBe('CHK_identity_verifications_resume_only_pending');
    });

    // Columns are built when each test runs: ADMIN_ID only exists after beforeEach.
    it.each([
      [
        'decided_by_admin_id without decided_at',
        () => ({ decided_by_admin_id: ADMIN_ID }),
      ],
      [
        'decided_at without decided_by_admin_id',
        () => ({ decided_at: new Date() }),
      ],
    ])('rejects %s', async (_label, columns) => {
      const userId = await createUser('+251911000001');

      expect(await constraintOf(createAttempt(userId, columns()))).toBe(
        'CHK_identity_verifications_decided_pair',
      );
    });

    it.each([
      ['flagged_at without flag_reason', { flagged_at: new Date() }],
      ['flag_reason without flagged_at', { flag_reason: 'DUPLICATE_IDENTITY' }],
    ])('rejects %s', async (_label, columns) => {
      const userId = await createUser('+251911000001');

      expect(await constraintOf(createAttempt(userId, columns))).toBe(
        'CHK_identity_verifications_flag_pair',
      );
    });

    it('accepts a staff decision and a flag when both halves are set', async () => {
      const userId = await createUser('+251911000001');

      await expect(
        createAttempt(userId, {
          outcome: 'approved',
          decided_by_admin_id: ADMIN_ID,
          decided_at: new Date(),
          flagged_at: new Date(),
          flag_reason: 'APPROVAL_REVERSED',
        }),
      ).resolves.toBeDefined();
    });

    it('returns date_of_birth as a plain date string', async () => {
      const userId = await createUser('+251911000001');
      const id = await createAttempt(userId, { date_of_birth: '1990-05-17' });

      const row = await one<{ date_of_birth: string }>(
        `SELECT date_of_birth::text FROM identity_verifications WHERE id = $1`,
        [id],
      );
      expect(row.date_of_birth).toBe('1990-05-17');
    });
  });

  describe('identity_hashes', () => {
    it('defaults is_approved to false', async () => {
      const userId = await createUser('+251911000001');
      const attemptId = await createAttempt(userId);
      await addHash(attemptId, userId, HASH_A);

      expect(await one(`SELECT is_approved FROM identity_hashes`)).toEqual({
        is_approved: false,
      });
    });

    it('V6 backstop: one identifier can be approved for only one user', async () => {
      const alice = await createUser('+251911000001');
      const bob = await createUser('+251911000002');
      await addHash(await createAttempt(alice), alice, HASH_A, true);

      expect(
        await constraintOf(
          addHash(await createAttempt(bob), bob, HASH_A, true),
        ),
      ).toBe('UQ_identity_hashes_hash_approved');
    });

    it('allows the same identifier on any number of non-approved attempts and users', async () => {
      const alice = await createUser('+251911000001');
      const bob = await createUser('+251911000002');
      await addHash(await createAttempt(alice), alice, HASH_A, true);

      await addHash(await createAttempt(alice), alice, HASH_A, false);
      await addHash(await createAttempt(bob), bob, HASH_A, false);
      await addHash(await createAttempt(bob), bob, HASH_A, false);

      expect(
        await one(`SELECT count(*)::int AS n FROM identity_hashes`),
      ).toEqual({ n: 4 });
    });

    it('frees an identifier for another user once its approval is withdrawn', async () => {
      const alice = await createUser('+251911000001');
      const bob = await createUser('+251911000002');
      await addHash(await createAttempt(alice), alice, HASH_A, true);
      const bobsAttempt = await createAttempt(bob);
      await addHash(bobsAttempt, bob, HASH_A, false);

      await db.query(
        `UPDATE identity_hashes SET is_approved = false WHERE user_id = $1`,
        [alice],
      );
      await db.query(
        `UPDATE identity_hashes SET is_approved = true WHERE verification_id = $1`,
        [bobsAttempt],
      );

      expect(
        await one(
          `SELECT count(*)::int AS n FROM identity_hashes WHERE is_approved`,
        ),
      ).toEqual({ n: 1 });
    });

    it('stores one identifier only once per attempt', async () => {
      const userId = await createUser('+251911000001');
      const attemptId = await createAttempt(userId);
      await addHash(attemptId, userId, HASH_A, false, 'fayda_fin');

      expect(
        await constraintOf(
          addHash(attemptId, userId, HASH_A, false, 'fayda_fan'),
        ),
      ).toBe('UQ_identity_hashes_verification_hash');
      await expect(
        addHash(attemptId, userId, HASH_B, false, 'fayda_fan'),
      ).resolves.toBeDefined();
    });

    it('rejects an unknown kind', async () => {
      const userId = await createUser('+251911000001');
      const attemptId = await createAttempt(userId);

      await expect(
        addHash(attemptId, userId, HASH_A, false, 'kebele_id'),
      ).rejects.toThrow(/invalid input value for enum identity_kind/);
    });
  });

  describe('verification_webhook_events', () => {
    const insertEvent = (eventKey: string) =>
      db.query(
        `INSERT INTO verification_webhook_events
           (event_key, webhook_type, provider_session_id, provider_status)
         VALUES ($1, 'status.updated', 'session-1', 'Approved')`,
        [eventKey],
      );

    it('stamps received_at and leaves processed_at unset', async () => {
      await insertEvent('event-1');

      expect(
        await one(
          `SELECT received_at IS NOT NULL AS received, processed_at, error
           FROM verification_webhook_events`,
        ),
      ).toEqual({ received: true, processed_at: null, error: null });
    });

    it('keeps event_key unique (V11)', async () => {
      await insertEvent('event-1');

      expect(await constraintOf(insertEvent('event-1'))).toBe(
        'UQ_verification_webhook_events_event_key',
      );
    });
  });

  describe('banned_identities', () => {
    it('allows only one active ban per hash', async () => {
      const userId = await createUser('+251911000001');
      await ban(userId, HASH_A);

      expect(await constraintOf(ban(userId, HASH_A))).toBe(
        'UQ_banned_identities_hash_active',
      );
      await expect(ban(userId, HASH_B)).resolves.toBeDefined();
    });

    it('allows banning a hash again after the earlier ban was lifted', async () => {
      const userId = await createUser('+251911000001');
      await ban(userId, HASH_A);
      await db.query(
        `UPDATE banned_identities SET lifted_at = now(), lifted_by_admin_id = $1`,
        [ADMIN_ID],
      );

      await ban(userId, HASH_A);

      expect(
        await one(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE lifted_at IS NULL)::int AS active
           FROM banned_identities`,
        ),
      ).toEqual({ total: 2, active: 1 });
    });
  });
});
