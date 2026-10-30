import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource, Repository } from 'typeorm';
import { hashOtpCode } from '../src/modules/auth/otp-crypto.js';
import { OtpService } from '../src/modules/auth/otp.service.js';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { User } from '../src/modules/users/user.entity.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { TEST_ENV } from './test-env.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';

const PHONE = '+251911234567';

describe('phone OTP (e2e)', () => {
  let app: INestApplication<App>;
  let otp: OtpService;
  let db: DataSource;
  let users: Repository<User>;
  const sms = new FakeSmsSender();

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b.overrideProvider(SmsSender).useValue(sms),
    );
    otp = app.get(OtpService);
    db = app.get(DataSource);
    users = app.get(getRepositoryToken(User));
  });

  afterEach(async () => {
    sms.clear();
    vi.restoreAllMocks();
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const requestOtp = (phone: unknown) =>
    request(app.getHttpServer()).post('/auth/otp/request').send({ phone });

  /** Requests a code over HTTP and returns it from the fake SMS. */
  const sendCode = async (phone = PHONE) => {
    await requestOtp(phone).expect(200);
    const code = /code is (\d{6})/.exec(sms.lastTextTo(PHONE) ?? '')?.[1];
    expect(code).toBeDefined();
    return code!;
  };

  /** The service's error body, e.g. { code: 'OTP_INVALID', attemptsRemaining: 4 }. */
  const verifyError = async (phone: string, code: string) => {
    const error = await otp.verify(phone, code).then(
      () => null,
      (e: { getResponse(): unknown }) => e,
    );
    expect(error).not.toBeNull();
    return error!.getResponse();
  };

  const otpRows = () =>
    db.query<{ code_hash: string; attempts: number; consumed: boolean }[]>(
      `SELECT code_hash, attempts, consumed_at IS NOT NULL AS consumed
       FROM otp_codes WHERE phone = $1 ORDER BY created_at`,
      [PHONE],
    );

  describe('POST /auth/otp/request', () => {
    it('sends a 6-digit code by SMS with the agreed text (A1, A7)', async () => {
      const response = await requestOtp(PHONE).expect(200);

      expect(response.body).toEqual({ expiresInSeconds: 300 });
      expect(sms.sent).toHaveLength(1);
      expect(sms.sent[0].to).toBe(PHONE);
      expect(sms.sent[0].text).toMatch(
        /^Your rental code is \d{6}\. Valid for 5 minutes\. Never share this code with anyone\.$/,
      );
    });

    it('normalises the phone before storing and sending', async () => {
      await requestOtp('0911 234 567').expect(200);

      expect(sms.sent[0].to).toBe(PHONE);
      expect(await otpRows()).toHaveLength(1);
    });

    it('stores only the HMAC of the code, never the code (A9)', async () => {
      const code = await sendCode();
      const [row] = await otpRows();

      expect(row.code_hash).toBe(
        hashOtpCode(TEST_ENV.OTP_HASH_SECRET, PHONE, code),
      );
      const [{ dump }] = await db.query<{ dump: string }[]>(
        `SELECT row_to_json(o)::text AS dump FROM otp_codes o`,
      );
      expect(dump).not.toContain(code);
    });

    it('expires the code after OTP_TTL_SECONDS (A1)', async () => {
      const [{ ttl }] = await (async () => {
        await sendCode();
        return db.query<{ ttl: number }[]>(
          `SELECT round(extract(epoch FROM expires_at - created_at))::int AS ttl FROM otp_codes`,
        );
      })();

      expect(ttl).toBe(300);
    });

    it('responds identically for new and existing accounts', async () => {
      const forNew = await requestOtp(PHONE).expect(200);
      await resetDatabase(app);
      await users.save(users.create({ phone: PHONE }));
      const forExisting = await requestOtp(PHONE).expect(200);

      expect(forExisting.body).toEqual(forNew.body);
    });

    it.each([
      ['a landline', '0111234567'],
      ['a foreign number', '+447700900123'],
      ['garbage', 'call me'],
    ])(
      'rejects %s with INVALID_PHONE and sends nothing',
      async (_label, phone) => {
        const response = await requestOtp(phone).expect(400);

        expect(response.body).toEqual({ code: 'INVALID_PHONE' });
        expect(sms.sent).toHaveLength(0);
      },
    );

    it('rejects a missing phone or unknown fields with VALIDATION_FAILED', async () => {
      await request(app.getHttpServer())
        .post('/auth/otp/request')
        .send({})
        .expect(400)
        .expect(({ body }) => expect(body.code).toBe('VALIDATION_FAILED'));
      await request(app.getHttpServer())
        .post('/auth/otp/request')
        .send({ phone: PHONE, isAdmin: true })
        .expect(400)
        .expect(({ body }) => expect(body.code).toBe('VALIDATION_FAILED'));
    });

    it('allows 3 requests per phone per 10 minutes, then OTP_RATE_LIMITED (A3)', async () => {
      for (let i = 0; i < 3; i++) await requestOtp(PHONE).expect(200);

      const response = await requestOtp(PHONE).expect(429);
      expect(response.body.code).toBe('OTP_RATE_LIMITED');
      expect(response.body.retryAfterSeconds).toBeGreaterThan(0);
      expect(response.body.retryAfterSeconds).toBeLessThanOrEqual(600);
      expect(sms.sent).toHaveLength(3);
      expect(await otpRows()).toHaveLength(3);
    });

    it('counts the A3 limit per phone, not globally', async () => {
      for (let i = 0; i < 3; i++) await requestOtp(PHONE).expect(200);

      await requestOtp('+251711234567').expect(200);
    });

    it('allows requests again once older codes leave the 10-minute window (A3)', async () => {
      for (let i = 0; i < 3; i++) await requestOtp(PHONE).expect(200);
      await db.query(
        `UPDATE otp_codes SET created_at = created_at - interval '10 minutes 1 second'`,
      );

      await requestOtp(PHONE).expect(200);
    });

    it('holds the A3 limit under concurrent requests', async () => {
      const statuses = await Promise.all(
        Array.from({ length: 6 }, () =>
          requestOtp(PHONE).then((r) => r.status),
        ),
      );

      expect(statuses.filter((s) => s === 200)).toHaveLength(3);
      expect(statuses.filter((s) => s === 429)).toHaveLength(3);
      expect(await otpRows()).toHaveLength(3);
    });

    it('returns SMS_SEND_FAILED when sending fails, and still counts the request (A3)', async () => {
      vi.spyOn(sms, 'send').mockRejectedValueOnce(new Error('gateway down'));

      const response = await requestOtp(PHONE).expect(503);

      expect(response.body).toEqual({ code: 'SMS_SEND_FAILED' });
      expect(await otpRows()).toHaveLength(1);
    });
  });

  describe('OtpService.verify', () => {
    it('signs in a new phone: consumes the code and creates the user (A1)', async () => {
      const code = await sendCode();

      const user = await otp.verify('0911234567', code);

      expect(user.phone).toBe(PHONE);
      expect(await users.countBy({ phone: PHONE })).toBe(1);
      expect((await otpRows())[0].consumed).toBe(true);
    });

    it('returns the existing user on later sign-ins', async () => {
      const first = await otp.verify(PHONE, await sendCode());
      const second = await otp.verify(PHONE, await sendCode());

      expect(second.id).toBe(first.id);
      expect(await users.countBy({ phone: PHONE })).toBe(1);
    });

    it('refuses to reuse a consumed code', async () => {
      const code = await sendCode();
      await otp.verify(PHONE, code);

      expect(await verifyError(PHONE, code)).toEqual({ code: 'OTP_EXPIRED' });
    });

    it('refuses an expired code (A1)', async () => {
      const code = await sendCode();
      await db.query(
        `UPDATE otp_codes SET expires_at = now() - interval '1 second'`,
      );

      expect(await verifyError(PHONE, code)).toEqual({ code: 'OTP_EXPIRED' });
      expect(await users.countBy({ phone: PHONE })).toBe(0);
    });

    it('kills a code after 5 wrong attempts, even if the right code follows (A2)', async () => {
      const code = await sendCode();
      const wrong = code === '000000' ? '111111' : '000000';

      for (let remaining = 4; remaining >= 1; remaining--) {
        expect(await verifyError(PHONE, wrong)).toEqual({
          code: 'OTP_INVALID',
          attemptsRemaining: remaining,
        });
      }
      expect(await verifyError(PHONE, wrong)).toEqual({
        code: 'OTP_ATTEMPTS_EXCEEDED',
      });
      expect(await verifyError(PHONE, code)).toEqual({
        code: 'OTP_ATTEMPTS_EXCEEDED',
      });
      expect((await otpRows())[0].attempts).toBe(5);
    });

    it('never counts more than 5 attempts under concurrent guesses (A2)', async () => {
      const code = await sendCode();
      const wrong = code === '000000' ? '111111' : '000000';

      await Promise.allSettled(
        Array.from({ length: 12 }, () => otp.verify(PHONE, wrong)),
      );

      expect((await otpRows())[0].attempts).toBe(5);
      expect(await verifyError(PHONE, code)).toEqual({
        code: 'OTP_ATTEMPTS_EXCEEDED',
      });
    });

    it('lets a code be consumed only once under concurrent verifies', async () => {
      const code = await sendCode();

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => otp.verify(PHONE, code)),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await users.countBy({ phone: PHONE })).toBe(1);
    });

    it('invalidates the previous code when a new one is requested (A4)', async () => {
      const first = await sendCode();
      const second = await sendCode();
      // The older code is no longer the phone's latest, so it's just a wrong code now
      // (unless both happen to be equal: a one-in-a-million draw).
      if (first !== second) {
        expect(await verifyError(PHONE, first)).toEqual({
          code: 'OTP_INVALID',
          attemptsRemaining: 4,
        });
      }

      const user = await otp.verify(PHONE, second);
      expect(user.phone).toBe(PHONE);
    });

    it('does not count codes from earlier requests as still usable (A4)', async () => {
      await sendCode();
      await sendCode();

      const [older, newer] = await db.query<{ usable: boolean }[]>(
        `SELECT consumed_at IS NULL AND expires_at > now() AS usable
         FROM otp_codes ORDER BY created_at`,
      );
      expect(older.usable).toBe(false);
      expect(newer.usable).toBe(true);
    });

    it('returns OTP_INVALID when no code was ever requested', async () => {
      expect(await verifyError(PHONE, '123456')).toEqual({
        code: 'OTP_INVALID',
      });
    });

    it('returns OTP_INVALID for an invalid phone', async () => {
      expect(await verifyError('0111234567', '123456')).toEqual({
        code: 'OTP_INVALID',
      });
    });
  });
});
