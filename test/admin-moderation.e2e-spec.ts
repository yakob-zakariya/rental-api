import { INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { DecisionService } from '../src/modules/verification/decision/decision.service.js';
import { IdentityHasher } from '../src/modules/verification/identity-hasher.js';
import { IdentityKind } from '../src/modules/verification/verification.enums.js';
import { REDIS } from '../src/redis/redis.module.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { createTestAdmin } from './utils/admins.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import { signIn } from './utils/sign-in.js';

const FIN = '123456789012';
const FAN = '1234567890123456';

describe('ban and unban (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let hasher: IdentityHasher;
  const sms = new FakeSmsSender();
  let support: { id: string; token: string };
  let moderator: { id: string; token: string };
  let superAdmin: { id: string; token: string };
  let counter = 0;

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b.overrideProvider(SmsSender).useValue(sms),
    );
    db = app.get(DataSource);
    hasher = app.get(IdentityHasher);
  });

  beforeEach(async () => {
    [support, moderator, superAdmin] = [
      await staff('support'),
      await staff('moderator'),
      await staff('super_admin'),
    ];
  });

  afterEach(async () => {
    sms.clear();
    await app.get<Redis>(REDIS).flushdb();
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
    return { id: admin.id, token: body.accessToken as string };
  }
  const as = (who: { token: string }) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${who.token}`);
  const ban = (userId: string, who = moderator, reason = 'Fake listings') =>
    as(who)(http().post(`/admin/users/${userId}/ban`).send({ reason }));
  const unban = (userId: string, who = superAdmin, note = 'Appeal accepted') =>
    as(who)(http().post(`/admin/users/${userId}/unban`).send({ note }));

  const finHash = (number = FIN) =>
    hasher.hash({ kind: IdentityKind.FaydaFin, number });

  /** A signed-in app user (with tokens) and, optionally, an approved attempt with hashes. */
  const appUser = async ({ approvedWith = [] as string[] } = {}) => {
    const phone = `+2519140000${String(++counter).padStart(2, '0')}`;
    const tokens = await signIn(app, sms, phone);
    const [{ id: userId }] = await db.query<{ id: string }[]>(
      `SELECT id FROM users WHERE phone = $1`,
      [phone],
    );
    if (approvedWith.length > 0) {
      const [{ id: attemptId }] = await db.query<{ id: string }[]>(
        `INSERT INTO identity_verifications (user_id, provider_session_id, provider_status, outcome, verified_name, date_of_birth)
         VALUES ($1, $2, 'Approved', 'approved', 'Abebe Kebede', '1990-05-17') RETURNING id`,
        [userId, `session-${++counter}`],
      );
      for (const number of approvedWith) {
        const kind =
          number.length === 16 ? IdentityKind.FaydaFan : IdentityKind.FaydaFin;
        await db.query(
          `INSERT INTO identity_hashes (verification_id, user_id, kind, hash, is_approved) VALUES ($1, $2, $3, $4, true)`,
          [attemptId, userId, kind, hasher.hash({ kind, number })],
        );
      }
      await db.transaction((m) => app.get(DecisionService).syncUser(m, userId));
    }
    return { userId, phone, ...tokens };
  };

  const activeBans = (userId?: string) =>
    db.query<
      {
        user_id: string;
        kind: string;
        hash: string;
        reason: string;
        banned_by_admin_id: string;
      }[]
    >(
      `SELECT user_id, kind, hash, reason, banned_by_admin_id FROM banned_identities
       WHERE lifted_at IS NULL ${userId ? 'AND user_id = $1' : ''} ORDER BY kind::text`,
      userId ? [userId] : [],
    );
  const status = async (userId: string) =>
    (
      await db.query<{ status: string; verification_status: string }[]>(
        `SELECT status, verification_status FROM users WHERE id = $1`,
        [userId],
      )
    )[0];
  const auditRows = () =>
    db.query<
      {
        action: string;
        target_id: string;
        admin_id: string;
        details: unknown;
      }[]
    >(
      `SELECT action, target_id, admin_id, details FROM admin_actions WHERE action LIKE 'user.%' ORDER BY created_at`,
    );

  describe('POST /admin/users/:userId/ban (moderator+)', () => {
    it('bans: status, refresh tokens revoked, approved hashes copied, audit row', async () => {
      const u = await appUser({ approvedWith: [FIN, FAN] });

      const { body } = await ban(u.userId).expect(200);

      expect(body).toEqual({
        userId: u.userId,
        status: 'banned',
        identitiesBanned: 2,
      });
      expect((await status(u.userId)).status).toBe('banned');
      const [{ live }] = await db.query<{ live: number }[]>(
        `SELECT count(*)::int AS live FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`,
        [u.userId],
      );
      expect(live).toBe(0);
      expect(await activeBans(u.userId)).toEqual(
        [
          {
            user_id: u.userId,
            kind: 'fayda_fin',
            hash: finHash(),
            reason: 'Fake listings',
            banned_by_admin_id: moderator.id,
          },
          {
            user_id: u.userId,
            kind: 'fayda_fan',
            hash: hasher.hash({ kind: IdentityKind.FaydaFan, number: FAN }),
            reason: 'Fake listings',
            banned_by_admin_id: moderator.id,
          },
        ].sort((a, b) => a.kind.localeCompare(b.kind)),
      );
      expect(await auditRows()).toEqual([
        {
          action: 'user.ban',
          target_id: u.userId,
          admin_id: moderator.id,
          details: { reason: 'Fake listings' },
        },
      ]);
    });

    it('takes effect at once: the still-valid access token, refresh and a new sign-in are all refused', async () => {
      const u = await appUser({ approvedWith: [FIN] });
      await http()
        .get('/me')
        .set('Authorization', `Bearer ${u.accessToken}`)
        .expect(200);

      await ban(u.userId).expect(200);

      expect(
        (
          await http()
            .get('/me')
            .set('Authorization', `Bearer ${u.accessToken}`)
            .expect(403)
        ).body,
      ).toEqual({
        code: 'ACCOUNT_UNAVAILABLE',
      });
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: u.refreshToken })
        .expect(401);
      await http()
        .post('/auth/otp/request')
        .send({ phone: u.phone })
        .expect(200);
      const code = /code is (\d{6})/.exec(sms.lastTextTo(u.phone) ?? '')![1];
      expect(
        (
          await http()
            .post('/auth/otp/verify')
            .send({ phone: u.phone, code })
            .expect(403)
        ).body,
      ).toEqual({
        code: 'ACCOUNT_UNAVAILABLE',
      });
    });

    it('V5: another account verifying with the banned identity ends up blocked', async () => {
      const banned = await appUser({ approvedWith: [FIN] });
      await ban(banned.userId).expect(200);
      const other = await appUser();
      await db.query(
        `INSERT INTO identity_verifications (user_id, provider_session_id, provider_status, outcome, verification_url, session_token)
         VALUES ($1, 'evasion-session', 'In Progress', 'pending', 'u', 't')`,
        [other.userId],
      );

      await db.transaction((m) =>
        app.get(DecisionService).apply(
          {
            sessionId: 'evasion-session',
            status: 'Approved',
            idVerifications: [
              {
                status: 'Approved',
                documentType: 'Identity Card',
                documentSubtype: null,
                documentNumber: FIN,
                personalNumber: null,
                issuingState: 'ETH',
                dateOfBirth: '1991-01-01',
                fullName: 'Different Name',
                firstName: null,
                lastName: null,
              },
            ],
          },
          m,
        ),
      );

      expect(await status(other.userId)).toMatchObject({
        status: 'active',
        verification_status: 'blocked',
      });
    });

    it('a user with no approved attempt is only set to banned', async () => {
      const u = await appUser();

      expect((await ban(u.userId).expect(200)).body).toEqual({
        userId: u.userId,
        status: 'banned',
        identitiesBanned: 0,
      });
      expect(await activeBans()).toEqual([]);
    });

    it('does not ban hashes from non-approved attempts (they may be someone else’s number)', async () => {
      const u = await appUser();
      const [{ id }] = await db.query<{ id: string }[]>(
        `INSERT INTO identity_verifications (user_id, provider_session_id, provider_status, outcome) VALUES ($1, 's-x', 'Approved', 'manual_review') RETURNING id`,
        [u.userId],
      );
      await db.query(
        `INSERT INTO identity_hashes (verification_id, user_id, kind, hash) VALUES ($1, $2, 'fayda_fin', $3)`,
        [id, u.userId, finHash()],
      );

      expect((await ban(u.userId).expect(200)).body.identitiesBanned).toBe(0);
    });

    it('skips an identifier already under an active ban from someone else', async () => {
      const u = await appUser({ approvedWith: [FIN, FAN] });
      const other = await appUser();
      await db.query(
        `INSERT INTO banned_identities (user_id, kind, hash, reason, banned_by_admin_id) VALUES ($1, 'fayda_fin', $2, 'earlier', $3)`,
        [other.userId, finHash(), moderator.id],
      );

      expect((await ban(u.userId).expect(200)).body.identitiesBanned).toBe(1); // only the FAN
      expect(
        (await activeBans())
          .map((b) => b.user_id)
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual([other.userId, u.userId].sort((a, b) => a.localeCompare(b)));
    });

    it('409 ALREADY_BANNED, also when two bans race', async () => {
      const u = await appUser({ approvedWith: [FIN] });

      const statuses = await Promise.all(
        [ban(u.userId), ban(u.userId), ban(u.userId)].map((r) =>
          r.then((x) => x.status),
        ),
      );

      expect(statuses.sort((a, b) => a - b)).toEqual([200, 409, 409]);
      expect((await ban(u.userId).expect(409)).body).toEqual({
        code: 'ALREADY_BANNED',
      });
      expect(await auditRows()).toHaveLength(1);
    });

    it.each([
      ['an unknown id', '00000000-0000-4000-8000-000000000999'],
      ['a non-uuid', 'nope'],
    ])('404 USER_NOT_FOUND for %s', async (_label, id) => {
      expect((await ban(id).expect(404)).body).toEqual({
        code: 'USER_NOT_FOUND',
      });
    });

    it('validates the reason: required, ≤ 255, no ID numbers', async () => {
      const u = await appUser();

      await as(moderator)(
        http().post(`/admin/users/${u.userId}/ban`).send({}),
      ).expect(400);
      await ban(u.userId, moderator, 'x'.repeat(256)).expect(400);
      expect(
        (await ban(u.userId, moderator, `fraud with FIN ${FIN}`).expect(400))
          .body,
      ).toEqual({
        code: 'NOTE_CONTAINS_ID_NUMBER',
      });
      expect((await status(u.userId)).status).toBe('active');
    });
  });

  describe('POST /admin/users/:userId/unban (super_admin only)', () => {
    it('unbans: status active, this user’s bans lifted, recomputed, audit row; they can sign in again', async () => {
      const u = await appUser({ approvedWith: [FIN] });
      await ban(u.userId).expect(200);

      const { body } = await unban(u.userId).expect(200);

      expect(body).toMatchObject({
        id: u.userId,
        status: 'active',
        verificationStatus: 'approved',
        activeBans: [],
      });
      const [{ lifted, by }] = await db.query<{ lifted: number; by: string }[]>(
        `SELECT count(*) FILTER (WHERE lifted_at IS NOT NULL)::int AS lifted, max(lifted_by_admin_id::text) AS by
         FROM banned_identities WHERE user_id = $1`,
        [u.userId],
      );
      expect({ lifted, by }).toEqual({ lifted: 1, by: superAdmin.id });
      expect((await auditRows()).map((r) => r.action)).toEqual([
        'user.ban',
        'user.unban',
      ]);
      expect((await auditRows())[1]).toMatchObject({
        admin_id: superAdmin.id,
        details: { note: 'Appeal accepted' },
      });
      // Old tokens stay revoked; a fresh sign-in works.
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: u.refreshToken })
        .expect(401);
      const fresh = await signIn(app, sms, u.phone);
      await http()
        .get('/me')
        .set('Authorization', `Bearer ${fresh.accessToken}`)
        .expect(200);
    });

    it('lifts only this user’s bans: another ban of the same identifier stays', async () => {
      const u = await appUser({ approvedWith: [FIN] });
      const other = await appUser();
      await ban(u.userId).expect(200);
      // Lift ours by hand, then let the other user's ban of the same FIN be the active one.
      await db.query(
        `UPDATE banned_identities SET lifted_at = now(), lifted_by_admin_id = $1 WHERE user_id = $2`,
        [superAdmin.id, u.userId],
      );
      await db.query(
        `INSERT INTO banned_identities (user_id, kind, hash, reason, banned_by_admin_id) VALUES ($1, 'fayda_fin', $2, 'theirs', $3)`,
        [other.userId, finHash(), moderator.id],
      );

      await unban(u.userId).expect(200);

      expect((await activeBans()).map((b) => b.user_id)).toEqual([
        other.userId,
      ]);
    });

    it('leaves attempts blocked during the ban blocked (staff approve them via the review queue)', async () => {
      const u = await appUser();
      await ban(u.userId).expect(200);
      await db.query(
        `INSERT INTO identity_verifications (user_id, provider_session_id, provider_status, outcome, decline_reason)
         VALUES ($1, 's-blocked', 'Approved', 'blocked', 'BANNED_IDENTITY')`,
        [u.userId],
      );
      await db.transaction((m) =>
        app.get(DecisionService).syncUser(m, u.userId),
      );

      const { body } = await unban(u.userId).expect(200);

      expect(body).toMatchObject({
        status: 'active',
        verificationStatus: 'blocked',
      });
    });

    it('409 NOT_BANNED for an active user', async () => {
      const u = await appUser();
      expect((await unban(u.userId).expect(409)).body).toEqual({
        code: 'NOT_BANNED',
      });
    });

    it('requires a note without ID numbers', async () => {
      const u = await appUser();
      await ban(u.userId).expect(200);

      await as(superAdmin)(
        http().post(`/admin/users/${u.userId}/unban`).send({}),
      ).expect(400);
      expect(
        (
          await unban(
            u.userId,
            superAdmin,
            'passport EP1234567 checked',
          ).expect(400)
        ).body,
      ).toEqual({
        code: 'NOTE_CONTAINS_ID_NUMBER',
      });
      expect((await status(u.userId)).status).toBe('banned');
    });
  });

  describe('S2 and roles', () => {
    it('support can read but not ban or unban', async () => {
      const u = await appUser();

      await as(support)(http().get(`/admin/users/${u.userId}`)).expect(200);
      expect((await ban(u.userId, support).expect(403)).body).toEqual({
        code: 'INSUFFICIENT_ROLE',
      });
      await ban(u.userId).expect(200);
      expect((await unban(u.userId, support).expect(403)).body).toEqual({
        code: 'INSUFFICIENT_ROLE',
      });
    });

    it('a moderator can ban but not unban (super_admin only)', async () => {
      const u = await appUser();
      await ban(u.userId, moderator).expect(200);

      expect((await unban(u.userId, moderator).expect(403)).body).toEqual({
        code: 'INSUFFICIENT_ROLE',
      });
      expect((await status(u.userId)).status).toBe('banned');
    });

    it('app tokens are refused', async () => {
      const u = await appUser();
      await http()
        .post(`/admin/users/${u.userId}/ban`)
        .set('Authorization', `Bearer ${u.accessToken}`)
        .send({ reason: 'x' })
        .expect(401);
    });
  });

  describe('GET /admin/users/:userId (any staff role)', () => {
    it('shows status, identity kinds and active bans, never hashes or numbers', async () => {
      const u = await appUser({ approvedWith: [FIN] });
      await ban(u.userId).expect(200);

      const { body } = await as(support)(
        http().get(`/admin/users/${u.userId}`),
      ).expect(200);

      expect(body).toMatchObject({
        id: u.userId,
        phone: u.phone,
        status: 'banned',
        verificationStatus: 'approved',
        fullName: 'Abebe Kebede',
        identities: [{ kind: 'fayda_fin', isApproved: true }],
        activeBans: [
          {
            kind: 'fayda_fin',
            reason: 'Fake listings',
            bannedAt: expect.any(String),
          },
        ],
        attempts: [{ outcome: 'approved' }],
      });
      const text = JSON.stringify(body);
      expect(text).not.toContain(finHash());
      expect(text).not.toContain(FIN);
    });

    it('404 USER_NOT_FOUND for an unknown user', async () => {
      await as(support)(
        http().get('/admin/users/00000000-0000-4000-8000-000000000999'),
      ).expect(404);
    });
  });
});
