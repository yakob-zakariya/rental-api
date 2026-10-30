import {
  Controller,
  Get,
  INestApplication,
  Module,
  UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { VerifiedGuard } from '../src/modules/auth/guards/verified.guard.js';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { VerificationStatus } from '../src/modules/users/user.enums.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { TEST_ENV } from './test-env.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import { signIn } from './utils/sign-in.js';

const PHONE = '+251911234567';

// Exists only in this test: Phase 1 has no production route that needs VerifiedGuard.
@Controller('test-only/verified')
class VerifiedOnlyController {
  @Get()
  @UseGuards(VerifiedGuard)
  get() {
    return { ok: true };
  }
}

@Module({ controllers: [VerifiedOnlyController] })
class VerifiedOnlyModule {}

describe('global guards and /me (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  const sms = new FakeSmsSender();
  const jwt = new JwtService();

  beforeAll(async () => {
    app = await createTestApp(
      (b) => b.overrideProvider(SmsSender).useValue(sms),
      [VerifiedOnlyModule],
    );
    db = app.get(DataSource);
  });

  afterEach(async () => {
    sms.clear();
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const getMe = (authorization?: string) => {
    const req = http().get('/me');
    return authorization === undefined
      ? req
      : req.set('Authorization', authorization);
  };
  const patchMe = (accessToken: string, body: object) =>
    http()
      .patch('/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body);

  const userId = async () =>
    (
      await db.query<{ id: string }[]>(
        `SELECT id FROM users WHERE phone = $1`,
        [PHONE],
      )
    )[0].id;

  const accessTokenSignedWith = async (
    secret: string,
    overrides: { typ?: string; audience?: string; expiresIn?: number } = {},
  ) =>
    jwt.signAsync(
      { sub: await userId(), typ: overrides.typ ?? 'access' },
      {
        secret,
        algorithm: 'HS256',
        issuer: 'rental-api',
        audience: overrides.audience ?? 'app',
        expiresIn: overrides.expiresIn ?? 900,
      },
    );

  describe('JwtAuthGuard', () => {
    it('lets a valid access token through to GET /me', async () => {
      const { accessToken } = await signIn(app, sms, PHONE);

      const response = await getMe(`Bearer ${accessToken}`).expect(200);

      expect(response.body).toEqual({
        id: await userId(),
        phone: PHONE,
        fullName: null,
        dateOfBirth: null,
        preferredLanguage: 'am',
        verificationStatus: 'not_verified',
        verifiedAt: null,
        createdAt: expect.any(String),
      });
    });

    it.each([
      ['no header', undefined],
      ['an empty header', ''],
      ['a non-Bearer scheme', 'Basic dXNlcjpwYXNz'],
      ['Bearer without a token', 'Bearer '],
      ['extra parts', 'Bearer a b'],
      ['garbage', 'Bearer not-a-jwt'],
    ])('rejects %s with UNAUTHENTICATED', async (_label, authorization) => {
      const response = await getMe(authorization).expect(401);

      expect(response.body).toEqual({ code: 'UNAUTHENTICATED' });
    });

    it('rejects a refresh token used as an access token', async () => {
      const { refreshToken } = await signIn(app, sms, PHONE);

      const response = await getMe(`Bearer ${refreshToken}`).expect(401);
      expect(response.body).toEqual({ code: 'UNAUTHENTICATED' });
    });

    it.each([
      ['the refresh secret', TEST_ENV.JWT_REFRESH_SECRET, {}],
      ['the admin secret (hard rule 8)', TEST_ENV.ADMIN_JWT_SECRET, {}],
      ['the admin audience', TEST_ENV.JWT_ACCESS_SECRET, { audience: 'admin' }],
      ['typ refresh', TEST_ENV.JWT_ACCESS_SECRET, { typ: 'refresh' }],
    ])('rejects a token signed with %s', async (_label, secret, overrides) => {
      await signIn(app, sms, PHONE);
      const token = await accessTokenSignedWith(secret, overrides);

      const response = await getMe(`Bearer ${token}`).expect(401);
      expect(response.body).toEqual({ code: 'UNAUTHENTICATED' });
    });

    it('rejects an expired access token with ACCESS_TOKEN_EXPIRED', async () => {
      await signIn(app, sms, PHONE);
      const expired = await accessTokenSignedWith(TEST_ENV.JWT_ACCESS_SECRET, {
        expiresIn: -10,
      });

      const response = await getMe(`Bearer ${expired}`).expect(401);
      expect(response.body).toEqual({ code: 'ACCESS_TOKEN_EXPIRED' });
    });

    it('leaves @Public() routes open without a token', async () => {
      await http().get('/health').expect(200);
      await http().post('/auth/otp/request').send({ phone: PHONE }).expect(200);
      await http()
        .post('/auth/otp/verify')
        .send({ phone: PHONE, code: '000000' })
        .expect((r) => expect(r.status).toBe(400));
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: 'x' })
        .expect(401);
      await http().post('/auth/logout').send({ refreshToken: 'x' }).expect(204);
    });
  });

  describe('ActiveAccountGuard', () => {
    it.each(['banned', 'suspended'])(
      'blocks a %s user at once, even with a still-valid access token',
      async (status) => {
        const { accessToken } = await signIn(app, sms, PHONE);
        await getMe(`Bearer ${accessToken}`).expect(200);

        await db.query(`UPDATE users SET status = $1 WHERE phone = $2`, [
          status,
          PHONE,
        ]);

        const response = await getMe(`Bearer ${accessToken}`).expect(403);
        expect(response.body).toEqual({ code: 'ACCOUNT_UNAVAILABLE' });
      },
    );

    it('blocks a token whose user no longer exists', async () => {
      const { accessToken } = await signIn(app, sms, PHONE);
      await resetDatabase(app);

      const response = await getMe(`Bearer ${accessToken}`).expect(403);
      expect(response.body).toEqual({ code: 'ACCOUNT_UNAVAILABLE' });
    });
  });

  describe('PATCH /me', () => {
    it('changes the preferred language', async () => {
      const { accessToken } = await signIn(app, sms, PHONE);

      const response = await patchMe(accessToken, {
        preferredLanguage: 'om',
      }).expect(200);

      expect(response.body.preferredLanguage).toBe('om');
      expect(
        (await getMe(`Bearer ${accessToken}`)).body.preferredLanguage,
      ).toBe('om');
    });

    it.each([{}, { preferredLanguage: 'fr' }, { preferredLanguage: 1 }])(
      'rejects %j with VALIDATION_FAILED',
      async (body) => {
        const { accessToken } = await signIn(app, sms, PHONE);

        const response = await patchMe(accessToken, body).expect(400);
        expect(response.body.code).toBe('VALIDATION_FAILED');
      },
    );

    it.each([
      { fullName: 'Someone Else' },
      { dateOfBirth: '2000-01-01' },
      { verificationStatus: 'approved' },
      { verifiedAt: '2026-01-01T00:00:00Z' },
      { status: 'active' },
      { phone: '+251711234567' },
    ])(
      'V9: rejects %j for a verified user and changes nothing',
      async (field) => {
        const { accessToken } = await signIn(app, sms, PHONE);
        await db.query(
          `UPDATE users SET verification_status = 'approved', verified_at = now(),
                          full_name = 'Abebe Kebede', date_of_birth = '1990-05-17'
         WHERE phone = $1`,
          [PHONE],
        );
        const before = (await getMe(`Bearer ${accessToken}`)).body;

        const response = await patchMe(accessToken, {
          preferredLanguage: 'en',
          ...field,
        }).expect(400);

        expect(response.body.code).toBe('VALIDATION_FAILED');
        expect((await getMe(`Bearer ${accessToken}`)).body).toEqual(before);
      },
    );
  });

  describe('VerifiedGuard', () => {
    it.each(
      Object.values(VerificationStatus).filter(
        (s) => s !== VerificationStatus.Approved,
      ),
    )('refuses a %s user with VERIFICATION_REQUIRED', async (status) => {
      const { accessToken } = await signIn(app, sms, PHONE);
      await db.query(
        `UPDATE users SET verification_status = $1 WHERE phone = $2`,
        [status, PHONE],
      );

      const response = await http()
        .get('/test-only/verified')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
      expect(response.body).toEqual({ code: 'VERIFICATION_REQUIRED' });
    });

    it('lets an approved user through', async () => {
      const { accessToken } = await signIn(app, sms, PHONE);
      await db.query(
        `UPDATE users SET verification_status = 'approved' WHERE phone = $1`,
        [PHONE],
      );

      await http()
        .get('/test-only/verified')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200, { ok: true });
    });

    it('still needs a token first (global guards run before it)', async () => {
      await http().get('/test-only/verified').expect(401);
    });
  });
});
