import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { TEST_ENV } from './test-env.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';

const PHONE = '+251911234567';

interface Pair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
}

interface TokenRow {
  id: string;
  device_name: string | null;
  token_hash: string;
  revoked: boolean;
  replaced_by_id: string | null;
}

describe('access and refresh tokens (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  const sms = new FakeSmsSender();
  const jwt = new JwtService();

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b.overrideProvider(SmsSender).useValue(sms),
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

  const codeFor = async (phone: string) => {
    await http().post('/auth/otp/request').send({ phone }).expect(200);
    return /code is (\d{6})/.exec(sms.lastTextTo(phone) ?? '')![1];
  };

  const signIn = async (phone = PHONE, deviceName?: string): Promise<Pair> => {
    const code = await codeFor(phone);
    const response = await http()
      .post('/auth/otp/verify')
      .send({ phone, code, ...(deviceName && { deviceName }) })
      .expect(200);
    return response.body as Pair;
  };

  const refresh = (refreshToken: unknown) =>
    http().post('/auth/refresh').send({ refreshToken });

  const logout = (refreshToken: unknown) =>
    http().post('/auth/logout').send({ refreshToken });

  const jtiOf = (token: string) => (jwt.decode(token) as { jti: string }).jti;

  const row = async (token: string) =>
    (
      await db.query<TokenRow[]>(
        `SELECT id, device_name, token_hash, revoked_at IS NOT NULL AS revoked, replaced_by_id
         FROM refresh_tokens WHERE id = $1`,
        [jtiOf(token)],
      )
    )[0];

  const liveTokenCount = async () =>
    Number(
      (
        await db.query<{ n: string }[]>(
          `SELECT count(*) AS n FROM refresh_tokens WHERE revoked_at IS NULL`,
        )
      )[0].n,
    );

  const setStatus = (status: string) =>
    db.query(`UPDATE users SET status = $1 WHERE phone = $2`, [status, PHONE]);

  /** Moves a token's rotation time back, as if it was rotated `seconds` ago. */
  const rotatedSecondsAgo = (token: string, seconds: number) =>
    db.query(
      `UPDATE refresh_tokens SET revoked_at = clock_timestamp() - make_interval(secs => $2)
       WHERE id = $1`,
      [jtiOf(token), seconds],
    );

  const expectInvalid = async (refreshToken: unknown) => {
    const response = await refresh(refreshToken).expect(401);
    expect(response.body).toEqual({ code: 'INVALID_REFRESH_TOKEN' });
  };

  describe('POST /auth/otp/verify', () => {
    it('returns an access token signed with JWT_ACCESS_SECRET only', async () => {
      const pair = await signIn();
      const [user] = await db.query<{ id: string }[]>(`SELECT id FROM users`);

      expect(pair.accessTokenExpiresIn).toBe(900);
      const claims = await jwt.verifyAsync<Record<string, unknown>>(
        pair.accessToken,
        {
          secret: TEST_ENV.JWT_ACCESS_SECRET,
          algorithms: ['HS256'],
        },
      );
      expect(claims).toMatchObject({
        sub: user.id,
        typ: 'access',
        iss: 'rental-api',
        aud: 'app',
      });
      expect(Number(claims.exp) - Number(claims.iat)).toBe(900);

      for (const secret of [
        TEST_ENV.JWT_REFRESH_SECRET,
        TEST_ENV.ADMIN_JWT_SECRET,
      ]) {
        await expect(
          jwt.verifyAsync(pair.accessToken, { secret }),
        ).rejects.toThrow();
      }
    });

    it('returns a refresh token stored only as its SHA-256, with the device name', async () => {
      const pair = await signIn(PHONE, 'Samsung A14');
      const stored = await row(pair.refreshToken);

      const claims = await jwt.verifyAsync<Record<string, unknown>>(
        pair.refreshToken,
        {
          secret: TEST_ENV.JWT_REFRESH_SECRET,
        },
      );
      expect(claims).toMatchObject({
        typ: 'refresh',
        aud: 'app',
        jti: stored.id,
      });
      expect(Number(claims.exp) - Number(claims.iat)).toBe(30 * 86400);
      expect(stored.token_hash).toBe(
        createHash('sha256').update(pair.refreshToken).digest('hex'),
      );
      expect(stored.device_name).toBe('Samsung A14');
      const [{ dump }] = await db.query<{ dump: string }[]>(
        `SELECT row_to_json(t)::text AS dump FROM refresh_tokens t`,
      );
      expect(dump).not.toContain(pair.refreshToken);
    });

    it('passes OTP errors through and validates the body', async () => {
      await codeFor(PHONE);
      const wrong = await http()
        .post('/auth/otp/verify')
        .send({ phone: PHONE, code: '000000' })
        .expect(400);
      expect(wrong.body.code).toMatch(/^OTP_/);

      const malformed = await http()
        .post('/auth/otp/verify')
        .send({ phone: PHONE, code: '12ab56' })
        .expect(400);
      expect(malformed.body.code).toBe('VALIDATION_FAILED');
    });

    it.each(['banned', 'suspended'])(
      'refuses to sign in a %s user with a neutral ACCOUNT_UNAVAILABLE (A6)',
      async (status) => {
        await signIn();
        await setStatus(status);
        await db.query(`DELETE FROM refresh_tokens`);

        const code = await codeFor(PHONE);
        const response = await http()
          .post('/auth/otp/verify')
          .send({ phone: PHONE, code })
          .expect(403);

        expect(response.body).toEqual({ code: 'ACCOUNT_UNAVAILABLE' });
        expect(await liveTokenCount()).toBe(0);
      },
    );
  });

  describe('POST /auth/refresh', () => {
    it('rotates: revokes the old token, links it, and returns a working pair', async () => {
      const first = await signIn(PHONE, 'Tecno Spark');

      const second = (await refresh(first.refreshToken).expect(200))
        .body as Pair;

      const old = await row(first.refreshToken);
      expect(old.revoked).toBe(true);
      expect(old.replaced_by_id).toBe(jtiOf(second.refreshToken));
      expect((await row(second.refreshToken)).device_name).toBe('Tecno Spark');
      await refresh(second.refreshToken).expect(200);
    });

    it('A5: reuse after the replacement was used revokes every token of the user', async () => {
      const phone = await signIn(PHONE, 'phone');
      const tablet = await signIn(PHONE, 'tablet');
      const rotated = (await refresh(phone.refreshToken).expect(200))
        .body as Pair;
      await refresh(rotated.refreshToken).expect(200); // the replacement is used

      await expectInvalid(phone.refreshToken);

      expect(await liveTokenCount()).toBe(0);
      await expectInvalid(tablet.refreshToken);
    });

    it('A5: reuse after the grace window revokes every token of the user', async () => {
      const phone = await signIn(PHONE, 'phone');
      const tablet = await signIn(PHONE, 'tablet');
      await refresh(phone.refreshToken).expect(200);
      await rotatedSecondsAgo(phone.refreshToken, 61);

      await expectInvalid(phone.refreshToken);

      expect(await liveTokenCount()).toBe(0);
      await expectInvalid(tablet.refreshToken);
    });

    it('A5 grace: a retry within the window, with the replacement unused, gets a new pair', async () => {
      const phone = await signIn(PHONE, 'phone');
      const tablet = await signIn(PHONE, 'tablet');
      const lost = (await refresh(phone.refreshToken).expect(200)).body as Pair;

      const retried = (await refresh(phone.refreshToken).expect(200))
        .body as Pair;

      const newId = jtiOf(retried.refreshToken);
      expect(await row(lost.refreshToken)).toMatchObject({
        revoked: true,
        replaced_by_id: newId,
      });
      expect((await row(phone.refreshToken)).replaced_by_id).toBe(newId);
      expect((await row(retried.refreshToken)).device_name).toBe('phone');
      // Nobody else was logged out, and the new pair works.
      expect((await row(tablet.refreshToken)).revoked).toBe(false);
      await refresh(retried.refreshToken).expect(200);
    });

    it('A5 grace: the window counts from the first rotation, however many retries', async () => {
      const first = await signIn();
      await refresh(first.refreshToken).expect(200);
      await refresh(first.refreshToken).expect(200);
      await refresh(first.refreshToken).expect(200);

      await rotatedSecondsAgo(first.refreshToken, 61);
      await expectInvalid(first.refreshToken);
      expect(await liveTokenCount()).toBe(0);
    });

    it('A5 grace: once the retried pair is used, the old token is full reuse', async () => {
      const first = await signIn();
      await refresh(first.refreshToken).expect(200);
      const retried = (await refresh(first.refreshToken).expect(200))
        .body as Pair;
      await refresh(retried.refreshToken).expect(200);

      await expectInvalid(first.refreshToken);
      expect(await liveTokenCount()).toBe(0);
    });

    it('A5: a token revoked by logout is full reuse, not a grace retry', async () => {
      const phone = await signIn(PHONE, 'phone');
      await signIn(PHONE, 'tablet');
      await logout(phone.refreshToken).expect(204);

      await expectInvalid(phone.refreshToken);
      expect(await liveTokenCount()).toBe(0);
    });

    it('handles two parallel refreshes with one token via the grace (one live token after)', async () => {
      const first = await signIn();

      const responses = await Promise.all([
        refresh(first.refreshToken),
        refresh(first.refreshToken),
      ]);

      expect(responses.map((r) => r.status)).toEqual([200, 200]);
      expect(await liveTokenCount()).toBe(1);
    });

    it.each(['banned', 'suspended'])(
      'refuses to refresh for a %s user with ACCOUNT_UNAVAILABLE (A6), grace path too',
      async (status) => {
        const first = await signIn();
        const lostPair = await signIn();
        await refresh(lostPair.refreshToken).expect(200);
        await setStatus(status);

        for (const token of [first.refreshToken, lostPair.refreshToken]) {
          const response = await refresh(token).expect(403);
          expect(response.body).toEqual({ code: 'ACCOUNT_UNAVAILABLE' });
        }
      },
    );

    it('rejects an access token, a tampered token and garbage', async () => {
      const pair = await signIn();
      const [header, payload, signature] = pair.refreshToken.split('.');
      const tampered = `${header}.${payload}.${signature.slice(0, -2)}xx`;

      await expectInvalid(pair.accessToken);
      await expectInvalid(tampered);
      await expectInvalid('not-a-jwt');
      // None of these touched the real token.
      await refresh(pair.refreshToken).expect(200);
    });

    it('rejects a token signed with another secret, or with an expired JWT', async () => {
      const pair = await signIn();
      const claims = jwt.decode(pair.refreshToken) as Record<string, unknown>;
      const forged = await jwt.signAsync(
        { sub: claims.sub, typ: 'refresh' },
        {
          secret: TEST_ENV.JWT_ACCESS_SECRET,
          jwtid: String(claims.jti),
          audience: 'app',
          issuer: 'rental-api',
        },
      );
      const expired = await jwt.signAsync(
        {
          sub: claims.sub,
          typ: 'refresh',
          exp: Math.floor(Date.now() / 1000) - 10,
        },
        {
          secret: TEST_ENV.JWT_REFRESH_SECRET,
          jwtid: String(claims.jti),
          audience: 'app',
          issuer: 'rental-api',
        },
      );

      await expectInvalid(forged);
      await expectInvalid(expired);
    });

    it('rejects a token whose row has expired', async () => {
      const pair = await signIn();
      await db.query(
        `UPDATE refresh_tokens SET expires_at = now() - interval '1 second'`,
      );

      await expectInvalid(pair.refreshToken);
    });

    it('validates the body', async () => {
      const response = await http().post('/auth/refresh').send({}).expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /auth/logout', () => {
    it('revokes only that token', async () => {
      const phone = await signIn(PHONE, 'phone');
      const tablet = await signIn(PHONE, 'tablet');

      await logout(phone.refreshToken).expect(204);

      expect((await row(phone.refreshToken)).revoked).toBe(true);
      expect((await row(tablet.refreshToken)).revoked).toBe(false);
    });

    it('is a no-op for an already-revoked, unknown or invalid token', async () => {
      const phone = await signIn(PHONE, 'phone');
      const tablet = await signIn(PHONE, 'tablet');
      await logout(phone.refreshToken).expect(204);

      await logout(phone.refreshToken).expect(204);
      await logout('not-a-jwt').expect(204);
      await logout(phone.accessToken).expect(204);

      expect((await row(tablet.refreshToken)).revoked).toBe(false);
    });
  });
});
