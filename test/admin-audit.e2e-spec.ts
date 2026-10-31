import { INestApplication, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource, QueryFailedError } from 'typeorm';
import {
  AdminActionType,
  AuditTargetType,
} from '../src/modules/admin/audit/audit.enums.js';
import { AuditService } from '../src/modules/admin/audit/audit.service.js';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { REDIS } from '../src/redis/redis.module.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { createTestAdmin } from './utils/admins.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import { signIn } from './utils/sign-in.js';

const TARGET = '11111111-1111-4111-8111-111111111111';
const OTHER_TARGET = '22222222-2222-4222-8222-222222222222';

describe('audit log (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let audit: AuditService;
  const sms = new FakeSmsSender();

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b.overrideProvider(SmsSender).useValue(sms),
    );
    db = app.get(DataSource);
    audit = app.get(AuditService);
  });

  afterEach(async () => {
    sms.clear();
    vi.restoreAllMocks();
    await app.get<Redis>(REDIS).flushdb();
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const login = (email: string, password: string) =>
    http().post('/admin/auth/login').send({ email, password });
  const signedIn = async (role = 'support') => {
    const admin = await createTestAdmin(db, { role });
    const { body } = await login(admin.email, admin.password).expect(200);
    return { ...admin, token: body.accessToken as string };
  };
  const list = (token: string, query = '') =>
    http()
      .get(`/admin/actions${query}`)
      .set('Authorization', `Bearer ${token}`);
  const actions = () =>
    db.query<
      {
        action: string;
        target_type: string;
        target_id: string;
        admin_id: string;
        details: unknown;
      }[]
    >(
      `SELECT action, target_type, target_id, admin_id, details FROM admin_actions ORDER BY created_at, id`,
    );
  const record = (
    adminId: string,
    overrides: Partial<Parameters<AuditService['record']>[1]> = {},
  ) =>
    db.transaction((manager) =>
      audit.record(manager, {
        adminId,
        action: AdminActionType.UserBan,
        targetType: AuditTargetType.User,
        targetId: TARGET,
        ...overrides,
      }),
    );

  describe('the table', () => {
    it('is append-only: UPDATE and DELETE are rejected by the database', async () => {
      const admin = await createTestAdmin(db);
      await record(admin.id, { details: { reason: 'fraud' } });

      for (const sql of [
        `UPDATE admin_actions SET details = '{"reason":"edited"}'`,
        `DELETE FROM admin_actions`,
      ]) {
        const error = await db.query(sql).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(QueryFailedError);
        expect((error as Error).message).toContain(
          'admin_actions is append-only',
        );
      }
      expect(await actions()).toMatchObject([{ details: { reason: 'fraud' } }]);
    });

    it('requires a real admin (foreign key) and defaults details to {}', async () => {
      const admin = await createTestAdmin(db);
      await db.query(
        `INSERT INTO admin_actions (admin_id, action, target_type, target_id) VALUES ($1, 'user.ban', 'user', $2)`,
        [admin.id, TARGET],
      );
      expect((await actions())[0].details).toEqual({});

      const error = await db
        .query(
          `INSERT INTO admin_actions (admin_id, action, target_type, target_id)
           VALUES (gen_random_uuid(), 'user.ban', 'user', $1)`,
          [TARGET],
        )
        .catch((e: unknown) => e);
      expect(
        (error as QueryFailedError & { driverError: { constraint: string } })
          .driverError.constraint,
      ).toBe('FK_admin_actions_admin_id');
    });
  });

  describe('AuditService.record', () => {
    it('writes inside the caller’s transaction: a rollback leaves no audit row', async () => {
      const admin = await createTestAdmin(db);

      await expect(
        db.transaction(async (manager) => {
          await audit.record(manager, {
            adminId: admin.id,
            action: AdminActionType.UserBan,
            targetType: AuditTargetType.User,
            targetId: TARGET,
          });
          throw new Error('the change failed');
        }),
      ).rejects.toThrow('the change failed');

      expect(await actions()).toEqual([]);
    });

    it.each([
      ['a Fayda number', { note: 'checked 123456789012' }],
      ['full-width digits', { reason: 'ID １２３４５６７８９０１２' }],
      ['a passport number', { note: 'passport EP 1234567' }],
    ])(
      'rejects %s in a note with 400 NOTE_CONTAINS_ID_NUMBER and stores nothing',
      async (_label, details) => {
        const admin = await createTestAdmin(db);

        const error = await record(admin.id, { details }).catch(
          (e: unknown) => e,
        );

        expect((error as { getResponse(): unknown }).getResponse()).toEqual({
          code: 'NOTE_CONTAINS_ID_NUMBER',
        });
        expect(await actions()).toEqual([]);
      },
    );
  });

  describe('admin.login', () => {
    it('records each successful login', async () => {
      const admin = await createTestAdmin(db);

      await login(admin.email, admin.password).expect(200);

      expect(await actions()).toEqual([
        {
          action: 'admin.login',
          target_type: 'admin_user',
          target_id: admin.id,
          admin_id: admin.id,
          details: {},
        },
      ]);
    });

    it('logs a failed login with the hashed email only, never the address or the password', async () => {
      const admin = await createTestAdmin(db, {
        email: 'secret-staff@example.test',
      });
      const warn = vi.spyOn(Logger.prototype, 'warn');

      await login(admin.email, 'the-wrong-password-123').expect(401);

      const lines = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((l) => l.includes('Failed staff login'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(
        /email sha256 [0-9a-f]{16}\): invalid credentials$/,
      );
      expect(lines[0]).not.toContain('secret-staff');
      expect(lines[0]).not.toContain('the-wrong-password-123');
      expect(await actions()).toEqual([]); // no audit row for a failure
    });
  });

  describe('GET /admin/actions', () => {
    it('lists newest first, with the admin, for any staff role (support can read)', async () => {
      const support = await signedIn('support'); // its login is the first action
      await record(support.id, { details: { reason: 'fraud' } });

      const { body } = await list(support.token).expect(200);

      expect(body.nextCursor).toBeNull();
      expect(body.items.map((i: { action: string }) => i.action)).toEqual([
        'user.ban',
        'admin.login',
      ]);
      expect(body.items[0]).toEqual({
        id: expect.any(String),
        action: 'user.ban',
        targetType: 'user',
        targetId: TARGET,
        details: { reason: 'fraud' },
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        admin: { id: support.id, email: support.email },
      });
    });

    it('filters by targetId, adminId and action', async () => {
      const a = await signedIn('moderator');
      const b = await createTestAdmin(db);
      await record(a.id, { targetId: TARGET });
      await record(b.id, {
        targetId: OTHER_TARGET,
        action: AdminActionType.UserUnban,
      });

      const byTarget = (
        await list(a.token, `?targetId=${OTHER_TARGET}`).expect(200)
      ).body.items;
      const byAdmin = (await list(a.token, `?adminId=${b.id}`).expect(200)).body
        .items;
      const byAction = (await list(a.token, '?action=admin.login').expect(200))
        .body.items;

      expect(byTarget.map((i: { targetId: string }) => i.targetId)).toEqual([
        OTHER_TARGET,
      ]);
      expect(byAdmin.map((i: { action: string }) => i.action)).toEqual([
        'user.unban',
      ]);
      expect(byAction).toHaveLength(1);
    });

    it('pages with a composite (created_at, id) cursor, even when timestamps are identical', async () => {
      const admin = await signedIn('support');
      // 7 actions with the SAME created_at, plus the login: ties are broken by id.
      await db.query(
        `INSERT INTO admin_actions (admin_id, action, target_type, target_id, created_at)
         SELECT $1, 'user.ban', 'user', $2, '2026-01-01T00:00:00.123456Z'
         FROM generate_series(1, 7)`,
        [admin.id, TARGET],
      );
      const expected = (
        await db.query<{ id: string }[]>(
          `SELECT id FROM admin_actions ORDER BY created_at DESC, id DESC`,
        )
      ).map((r) => r.id);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const response: request.Response = await list(
          admin.token,
          `?limit=3${cursor ? `&before=${cursor}` : ''}`,
        ).expect(200);
        seen.push(...response.body.items.map((i: { id: string }) => i.id));
        cursor = response.body.nextCursor;
        pages++;
      } while (cursor && pages < 10);

      expect(pages).toBe(3);
      expect(seen).toEqual(expected); // all 8, in order, no duplicates or gaps
    });

    it.each([
      ['an invalid cursor', '?before=not-a-cursor', 'INVALID_CURSOR'],
      ['a non-uuid targetId', '?targetId=123', 'VALIDATION_FAILED'],
      ['an unknown action', '?action=user.delete', 'VALIDATION_FAILED'],
      ['limit 0', '?limit=0', 'VALIDATION_FAILED'],
      ['limit over 200', '?limit=201', 'VALIDATION_FAILED'],
    ])('rejects %s with 400', async (_label, query, code) => {
      const admin = await signedIn('support');

      expect((await list(admin.token, query).expect(400)).body.code).toBe(code);
    });

    it('is staff-only: no token or an app token gets 401', async () => {
      const { accessToken } = await signIn(app, sms, '+251911234567');

      await http().get('/admin/actions').expect(401);
      await list(accessToken).expect(401);
    });
  });
});
