import {
  Delete,
  Get,
  INestApplication,
  Module,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource, QueryFailedError } from 'typeorm';
import { AdminController } from '../src/modules/admin/admin-controller.decorator.js';
import { AdminModule } from '../src/modules/admin/admin.module.js';
import { AdminRole } from '../src/modules/admin/admin.enums.js';
import { MAX_FAILED_LOGINS_PER_EMAIL } from '../src/modules/admin/admin-login-limiter.js';
import {
  CreateAdminError,
  createAdmin,
} from '../src/modules/admin/admin-users.js';
import { Roles } from '../src/modules/admin/roles.decorator.js';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { REDIS } from '../src/redis/redis.module.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { TEST_ENV } from './test-env.js';
import { createTestAdmin } from './utils/admins.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import { signIn } from './utils/sign-in.js';

// Exists only in this test: every combination of method and @Roles, to prove the role rules.
@AdminController('test-only/roles')
class RolesProbeController {
  @Get('open') readOpen() {
    return { ok: true };
  }
  @Get('moderator') @Roles(AdminRole.Moderator) readModerator() {
    return { ok: true };
  }
  @Post('default') writeDefault() {
    return { ok: true };
  }
  @Put('default') putDefault() {
    return { ok: true };
  }
  @Patch('default') patchDefault() {
    return { ok: true };
  }
  @Delete('default') deleteDefault() {
    return { ok: true };
  }
  @Post('super') @Roles(AdminRole.SuperAdmin) writeSuper() {
    return { ok: true };
  }
}

// Modules with admin routes import AdminModule for the admin guards' dependencies.
@Module({ imports: [AdminModule], controllers: [RolesProbeController] })
class RolesProbeModule {}

describe('staff auth (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let redis: Redis;
  const sms = new FakeSmsSender();
  const jwt = new JwtService();

  beforeAll(async () => {
    app = await createTestApp(
      (b) => b.overrideProvider(SmsSender).useValue(sms),
      [RolesProbeModule],
    );
    db = app.get(DataSource);
    redis = app.get(REDIS);
  });

  afterEach(async () => {
    sms.clear();
    await redis.flushdb();
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const login = (email: string, password: string) =>
    http().post('/admin/auth/login').send({ email, password });
  const tokenFor = async (role: string) => {
    const admin = await createTestAdmin(db, { role });
    const { body } = await login(admin.email, admin.password).expect(200);
    return { ...admin, token: body.accessToken as string };
  };
  const withToken = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);

  describe('POST /admin/auth/login', () => {
    it('returns an 8-hour admin token signed with ADMIN_JWT_SECRET only, and sets last_login_at', async () => {
      const admin = await createTestAdmin(db, { role: 'super_admin' });

      const { body } = await login(admin.email, admin.password).expect(200);

      expect(body.accessTokenExpiresIn).toBe(8 * 3600);
      const claims = await jwt.verifyAsync<Record<string, unknown>>(
        body.accessToken,
        {
          secret: TEST_ENV.ADMIN_JWT_SECRET,
        },
      );
      expect(claims).toMatchObject({
        sub: admin.id,
        typ: 'admin_access',
        aud: 'admin',
        iss: 'rental-api',
      });
      expect(Number(claims.exp) - Number(claims.iat)).toBe(8 * 3600);
      for (const secret of [
        TEST_ENV.JWT_ACCESS_SECRET,
        TEST_ENV.JWT_REFRESH_SECRET,
      ]) {
        await expect(
          jwt.verifyAsync(body.accessToken, { secret }),
        ).rejects.toThrow();
      }
      const [row] = await db.query<{ last: boolean }[]>(
        `SELECT last_login_at IS NOT NULL AS last FROM admin_users WHERE id = $1`,
        [admin.id],
      );
      expect(row.last).toBe(true);
    });

    it('treats the email case-insensitively', async () => {
      const admin = await createTestAdmin(db, { email: 'staff@example.test' });

      await login('  STAFF@Example.Test ', admin.password).expect(200);
    });

    it('gives the same neutral 401 for a wrong password, an unknown email and an inactive account', async () => {
      const admin = await createTestAdmin(db);
      const inactive = await createTestAdmin(db);
      await db.query(`UPDATE admin_users SET is_active = false WHERE id = $1`, [
        inactive.id,
      ]);

      const responses = await Promise.all([
        login(admin.email, 'wrong password!!'),
        login('nobody@example.test', admin.password),
        login(inactive.email, inactive.password),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(401);
        expect(response.body).toEqual({ code: 'INVALID_CREDENTIALS' });
      }
    });

    it('validates the body', async () => {
      const response = await login('not-an-email', 'x').expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    describe(`per-email limit (${MAX_FAILED_LOGINS_PER_EMAIL} failures / 15 min, in Redis)`, () => {
      it('refuses even the right password once the limit is reached, with the same neutral 401', async () => {
        const admin = await createTestAdmin(db);
        for (let i = 0; i < MAX_FAILED_LOGINS_PER_EMAIL; i++) {
          await login(admin.email, `wrong password ${i}`).expect(401);
        }

        const response = await login(admin.email, admin.password).expect(401);

        expect(response.body).toEqual({ code: 'INVALID_CREDENTIALS' });
      });

      it('is per email: other accounts are unaffected', async () => {
        const target = await createTestAdmin(db);
        const other = await createTestAdmin(db);
        for (let i = 0; i < MAX_FAILED_LOGINS_PER_EMAIL; i++)
          await login(target.email, 'wrong password!!');

        await login(other.email, other.password).expect(200);
      });

      it('also counts unknown emails (so it reveals nothing)', async () => {
        for (let i = 0; i < MAX_FAILED_LOGINS_PER_EMAIL + 2; i++) {
          const response = await login(
            'nobody@example.test',
            'wrong password!!',
          );
          expect(response.body).toEqual({ code: 'INVALID_CREDENTIALS' });
        }
      });

      it('is temporary: the counter expires after 15 minutes (no permanent lockout)', async () => {
        const admin = await createTestAdmin(db);
        await login(admin.email, 'wrong password!!').expect(401);

        const keys = await redis.keys('admin-login-failures:*');
        expect(keys).toHaveLength(1);
        const ttl = await redis.ttl(keys[0]);
        expect(ttl).toBeGreaterThan(14 * 60);
        expect(ttl).toBeLessThanOrEqual(15 * 60);
        expect(keys[0]).not.toContain(admin.email); // hashed, not stored

        // Simulate the window passing.
        for (let i = 0; i < MAX_FAILED_LOGINS_PER_EMAIL; i++)
          await login(admin.email, 'wrong password!!');
        await redis.del(keys[0]);
        await login(admin.email, admin.password).expect(200);
      });

      it('resets after a successful login', async () => {
        const admin = await createTestAdmin(db);
        for (let i = 0; i < MAX_FAILED_LOGINS_PER_EMAIL - 1; i++)
          await login(admin.email, 'wrong password!!');
        await login(admin.email, admin.password).expect(200);

        await login(admin.email, 'wrong password!!').expect(401);
        await login(admin.email, admin.password).expect(200);
      });
    });
  });

  describe('admin tokens and app tokens are never interchangeable (S3, hard rule 8)', () => {
    it('GET /admin/auth/me works with an admin token', async () => {
      const admin = await tokenFor('moderator');

      const { body } = await withToken(admin.token)(
        http().get('/admin/auth/me'),
      ).expect(200);

      expect(body).toEqual({
        id: admin.id,
        email: admin.email,
        role: 'moderator',
      });
      expect(body).not.toHaveProperty('passwordHash');
    });

    it('rejects an app-user token on an admin route', async () => {
      const { accessToken } = await signIn(app, sms, '+251911234567');

      const response = await withToken(accessToken)(
        http().get('/admin/auth/me'),
      ).expect(401);
      expect(response.body).toEqual({ code: 'UNAUTHENTICATED' });
    });

    it('rejects an admin token on an app route', async () => {
      const admin = await tokenFor('super_admin');

      const response = await withToken(admin.token)(http().get('/me')).expect(
        401,
      );
      expect(response.body).toEqual({ code: 'UNAUTHENTICATED' });
    });

    it('rejects a token with the admin secret but the app audience or type', async () => {
      const admin = await createTestAdmin(db);
      for (const [audience, typ] of [
        ['app', 'admin_access'],
        ['admin', 'access'],
      ]) {
        const forged = await jwt.signAsync(
          { sub: admin.id, typ },
          {
            secret: TEST_ENV.ADMIN_JWT_SECRET,
            audience,
            issuer: 'rental-api',
            expiresIn: 600,
          },
        );
        await withToken(forged)(http().get('/admin/auth/me')).expect(401);
      }
    });

    it('rejects no token, garbage, and an expired token (ACCESS_TOKEN_EXPIRED)', async () => {
      const admin = await createTestAdmin(db);
      const expired = await jwt.signAsync(
        { sub: admin.id, typ: 'admin_access' },
        {
          secret: TEST_ENV.ADMIN_JWT_SECRET,
          audience: 'admin',
          issuer: 'rental-api',
          expiresIn: -10,
        },
      );

      await http().get('/admin/auth/me').expect(401);
      await withToken('garbage')(http().get('/admin/auth/me')).expect(401);
      const response = await withToken(expired)(
        http().get('/admin/auth/me'),
      ).expect(401);
      expect(response.body).toEqual({ code: 'ACCESS_TOKEN_EXPIRED' });
    });

    it('stops a deactivated admin at once, even with a valid token', async () => {
      const admin = await tokenFor('super_admin');
      await db.query(`UPDATE admin_users SET is_active = false WHERE id = $1`, [
        admin.id,
      ]);

      await withToken(admin.token)(http().get('/admin/auth/me')).expect(401);
    });

    it('applies a role change at once', async () => {
      const admin = await tokenFor('super_admin');
      await withToken(admin.token)(
        http().post('/admin/test-only/roles/super'),
      ).expect(201);

      await db.query(`UPDATE admin_users SET role = 'support' WHERE id = $1`, [
        admin.id,
      ]);

      await withToken(admin.token)(
        http().post('/admin/test-only/roles/super'),
      ).expect(403);
    });
  });

  describe('roles: minimum levels, fail closed', () => {
    const routes: [
      string,
      'get' | 'post' | 'put' | 'patch' | 'delete',
      string,
    ][] = [
      ['GET without @Roles', 'get', '/admin/test-only/roles/open'],
      ['GET @Roles(moderator)', 'get', '/admin/test-only/roles/moderator'],
      ['POST without @Roles', 'post', '/admin/test-only/roles/default'],
      ['PUT without @Roles', 'put', '/admin/test-only/roles/default'],
      ['PATCH without @Roles', 'patch', '/admin/test-only/roles/default'],
      ['DELETE without @Roles', 'delete', '/admin/test-only/roles/default'],
      ['POST @Roles(super_admin)', 'post', '/admin/test-only/roles/super'],
    ];
    // Expected access: support / moderator / super_admin.
    const expected: Record<string, [boolean, boolean, boolean]> = {
      'GET without @Roles': [true, true, true],
      'GET @Roles(moderator)': [false, true, true],
      'POST without @Roles': [false, true, true],
      'PUT without @Roles': [false, true, true],
      'PATCH without @Roles': [false, true, true],
      'DELETE without @Roles': [false, true, true],
      'POST @Roles(super_admin)': [false, false, true],
    };

    it.each(routes)('%s', async (label, method, path) => {
      const tokens = [
        await tokenFor('support'),
        await tokenFor('moderator'),
        await tokenFor('super_admin'),
      ];

      const allowed = await Promise.all(
        tokens.map(async (admin) => {
          const response = await withToken(admin.token)(http()[method](path));
          if (response.status === 403)
            expect(response.body).toEqual({ code: 'INSUFFICIENT_ROLE' });
          return response.status < 400;
        }),
      );

      expect(allowed).toEqual(expected[label]);
    });

    it('a write route without @Roles is refused for support: the fail-closed default', async () => {
      const support = await tokenFor('support');

      const response = await withToken(support.token)(
        http().post('/admin/test-only/roles/default'),
      ).expect(403);
      expect(response.body).toEqual({ code: 'INSUFFICIENT_ROLE' });
    });
  });

  describe('createAdmin (the admin:create CLI)', () => {
    it('stores a lowercase email and an argon2id hash, never the password', async () => {
      const admin = await createAdmin(db.manager, {
        email: ' Root@Example.TEST ',
        role: 'super_admin',
        password: 'correct horse battery',
      });

      const [row] = await db.query<
        {
          email: string;
          password_hash: string;
          role: string;
          is_active: boolean;
        }[]
      >(
        `SELECT email, password_hash, role, is_active FROM admin_users WHERE id = $1`,
        [admin.id],
      );
      expect(row).toMatchObject({
        email: 'root@example.test',
        role: 'super_admin',
        is_active: true,
      });
      expect(row.password_hash).toMatch(/^\$argon2id\$/);
      expect(row.password_hash).not.toContain('correct horse battery');
    });

    it.each([
      [
        'a short password',
        { email: 'a@example.test', role: 'super_admin', password: 'short' },
        'at least 12',
      ],
      [
        'an unknown role',
        {
          email: 'a@example.test',
          role: 'owner',
          password: 'correct horse battery',
        },
        'Role must be one of',
      ],
      [
        'an invalid email',
        {
          email: 'not-an-email',
          role: 'support',
          password: 'correct horse battery',
        },
        'valid email',
      ],
    ])('refuses %s', async (_label, input, message) => {
      await expect(createAdmin(db.manager, input)).rejects.toThrow(message);
    });

    it('refuses a duplicate email (case-insensitive)', async () => {
      await createAdmin(db.manager, {
        email: 'a@example.test',
        role: 'support',
        password: 'correct horse battery',
      });

      await expect(
        createAdmin(db.manager, {
          email: 'A@EXAMPLE.TEST',
          role: 'support',
          password: 'correct horse battery',
        }),
      ).rejects.toBeInstanceOf(CreateAdminError);
    });

    it('the database also refuses a non-lowercase email', async () => {
      const error = await db
        .query(
          `INSERT INTO admin_users (email, password_hash, role) VALUES ('Mixed@Example.test', 'x', 'support')`,
        )
        .catch((e: unknown) => e);

      expect(
        (error as QueryFailedError & { driverError: { constraint: string } })
          .driverError.constraint,
      ).toBe('CHK_admin_users_email_lowercase');
    });
  });

  it('the staff id columns are now foreign keys to admin_users', async () => {
    const rows = await db.query<{ conname: string }[]>(
      `SELECT conname FROM pg_constraint
       WHERE contype = 'f' AND confrelid = 'admin_users'::regclass ORDER BY conname`,
    );

    expect(rows.map((r) => r.conname)).toEqual([
      'FK_banned_identities_banned_by_admin_id',
      'FK_banned_identities_lifted_by_admin_id',
      'FK_identity_verifications_decided_by_admin_id',
    ]);
  });
});
