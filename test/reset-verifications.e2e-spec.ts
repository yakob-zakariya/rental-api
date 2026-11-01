import { INestApplication } from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import {
  RESET_TABLES,
  resetVerifications,
} from '../src/cli/reset-verifications.lib.js';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { DiditClient } from '../src/modules/verification/didit/didit-client.js';
import { canonicalJson } from '../src/modules/verification/didit/webhook-signature.js';
import { FakeDiditClient } from './fakes/fake-didit-client.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { TEST_ENV } from './test-env.js';
import { insertTestAdmin } from './utils/admins.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import { signIn } from './utils/sign-in.js';

// dev:reset-verifications (development only): the guards are unit-tested; this runs the reset
// itself against rental_test.

/** The sandbox's one fake identity, returned for every session. */
const sameFakeIdentity = {
  status: 'Approved',
  document_type: 'Identity Card',
  document_subtype: 'ID_CARD_GENERIC',
  issuing_state: 'ETH',
  document_number: '123456789012',
  date_of_birth: '1990-05-17',
  full_name: 'Abebe Kebede',
};

describe('dev:reset-verifications (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  const sms = new FakeSmsSender();
  const didit = new FakeDiditClient();

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

  afterEach(async () => {
    sms.clear();
    didit.reset();
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  /** Signs in, starts a session and has Didit approve it with the fake identity. */
  const verify = async (phone: string) => {
    const { accessToken } = await signIn(app, sms, phone);
    await http()
      .post('/verification/sessions')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(201);
    const [{ provider_session_id: sessionId }] = await db.query<
      { provider_session_id: string }[]
    >(
      `SELECT a.provider_session_id FROM identity_verifications a
       JOIN users u ON u.id = a.user_id
       WHERE u.phone = $1 ORDER BY a.created_at DESC LIMIT 1`,
      [phone],
    );
    const body = {
      event_id: randomUUID(),
      webhook_type: 'status.updated',
      timestamp: Math.floor(Date.now() / 1000),
      environment: 'sandbox',
      session_id: sessionId,
      status: 'Approved',
      decision: {
        id_verifications: [sameFakeIdentity],
        face_matches: [{ score: 95.0 }],
      },
    };
    await http()
      .post('/webhooks/didit')
      .set('content-type', 'application/json')
      .set('x-timestamp', String(body.timestamp))
      .set(
        'x-signature-v2',
        createHmac('sha256', TEST_ENV.DIDIT_WEBHOOK_SECRET)
          .update(canonicalJson(body))
          .digest('hex'),
      )
      .send(JSON.stringify(body))
      .expect(200);
    return status(phone);
  };

  const status = async (phone: string) =>
    (
      await db.query<
        {
          verification_status: string;
          verified: boolean;
          full_name: string | null;
          date_of_birth: string | null;
        }[]
      >(
        `SELECT verification_status, verified_at IS NOT NULL AS verified, full_name,
                date_of_birth::text
         FROM users WHERE phone = $1`,
        [phone],
      )
    )[0];

  const count = async (table: string) =>
    (
      await db.query<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`)
    )[0].n;

  const reset = () => db.transaction((manager) => resetVerifications(manager));

  it('lets the same sandbox identity be approved again for a new account', async () => {
    expect((await verify('+251911000001')).verification_status).toBe(
      'approved',
    );
    // Without a reset, V6 blocks the second account.
    expect((await verify('+251911000002')).verification_status).toBe('blocked');

    await reset();

    expect((await verify('+251911000003')).verification_status).toBe(
      'approved',
    );
  });

  it('empties the verification tables and resets every user', async () => {
    await verify('+251911000001');
    await verify('+251911000002');
    const adminId = await insertTestAdmin(db);
    const [user] = await db.query<{ id: string }[]>(
      `SELECT id FROM users WHERE phone = '+251911000002'`,
    );
    await db.query(
      `INSERT INTO banned_identities (user_id, kind, hash, reason, banned_by_admin_id)
       SELECT user_id, kind, hash, 'test', $2 FROM identity_hashes WHERE user_id = $1`,
      [user.id, adminId],
    );
    await db.query(`UPDATE users SET status = 'banned' WHERE id = $1`, [
      user.id,
    ]);
    await db.query(
      `INSERT INTO admin_actions (admin_id, action, target_type, target_id)
       VALUES ($1, 'user.ban', 'user', $2)`,
      [adminId, user.id],
    );
    for (const table of RESET_TABLES)
      expect(await count(table)).toBeGreaterThan(0);
    const refreshTokens = await count('refresh_tokens');

    const removed = await reset();

    expect(removed).toEqual({
      tables: {
        identity_hashes: 2,
        banned_identities: 1,
        verification_webhook_events: 2,
        identity_verifications: 2,
      },
      users: 2,
      bannedUsers: 1,
    });
    for (const table of RESET_TABLES) expect(await count(table)).toBe(0);
    for (const phone of ['+251911000001', '+251911000002']) {
      expect(await status(phone)).toEqual({
        verification_status: 'not_verified',
        verified: false,
        full_name: null,
        date_of_birth: null,
      });
    }
    // Kept: users and their moderation status, sign-in sessions, staff, the audit log.
    expect(await count('users')).toBe(2);
    expect(await db.query(`SELECT status FROM users ORDER BY phone`)).toEqual([
      { status: 'active' },
      { status: 'banned' },
    ]);
    expect(await count('refresh_tokens')).toBe(refreshTokens);
    expect(await count('admin_users')).toBe(1);
    expect(await count('admin_actions')).toBe(1);
  });

  it('is a no-op on an empty database', async () => {
    expect(await reset()).toEqual({
      tables: {
        identity_hashes: 0,
        banned_identities: 0,
        verification_webhook_events: 0,
        identity_verifications: 0,
      },
      users: 0,
      bannedUsers: 0,
    });
  });
});
