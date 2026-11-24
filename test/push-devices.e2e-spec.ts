import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { PropertyType } from '../src/modules/listings/listings.enums.js';
import type { PushNotice } from '../src/modules/push/push-messages.js';
import { PushSender } from '../src/modules/push/push-sender.js';
import { PushService } from '../src/modules/push/push.service.js';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { FakePushSender } from './fakes/fake-push-sender.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { UnlimitedThrottlerStorage } from './fakes/unlimited-throttler-storage.js';
import { TEST_ENV } from './test-env.js';
import { createTestAdmin } from './utils/admins.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import { signIn } from './utils/sign-in.js';

// Push devices and sending (spec N1–N4; T6.1), and devices ending with their sign-in session
// (decided 2026-11-24).

const NOTICE: PushNotice = {
  kind: 'listing_approved',
  listingId: '0b9d6e3a-2f4c-4a8b-8c1d-7e6f5a4b3c2d',
  type: PropertyType.Apartment,
  neighbourhood: { nameEn: 'Bole', nameAm: 'ቦሌ' },
};

describe('push: devices and sending (e2e, T6.1)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let push: PushService;
  const sms = new FakeSmsSender();
  const sender = new FakePushSender();
  let counter = 0;

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b
        .overrideProvider(SmsSender)
        .useValue(sms)
        .overrideProvider(PushSender)
        .useValue(sender)
        .overrideProvider(ThrottlerStorage)
        .useValue(new UnlimitedThrottlerStorage()),
    );
    db = app.get(DataSource);
    push = app.get(PushService);
  });

  afterEach(async () => {
    sender.reset();
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const newPhone = () => `+2519250000${String(++counter).padStart(2, '0')}`;

  /** A sign-in (a new session) for `phone`; returns its tokens and the user id. */
  const session = async (phone: string) => {
    const tokens = await signIn(app, sms, phone);
    const [{ id }] = await db.query<{ id: string }[]>(
      `SELECT id FROM users WHERE phone = $1`,
      [phone],
    );
    return {
      ...tokens,
      userId: id,
      auth: { Authorization: `Bearer ${tokens.accessToken}` },
    };
  };
  const register = (
    auth: Record<string, string>,
    installationId: string,
    platform = 'android',
  ) => http().post('/me/devices').set(auth).send({ installationId, platform });
  const devices = (userId?: string) =>
    db.query<
      {
        id: string;
        user_id: string;
        session_id: string;
        installation_id: string;
      }[]
    >(
      `SELECT id, user_id, session_id, installation_id FROM devices
       ${userId ? 'WHERE user_id = $1' : ''} ORDER BY created_at`,
      userId ? [userId] : [],
    );

  describe('POST /me/devices (N2)', () => {
    it('registers the phone under the current sign-in session', async () => {
      const s = await session(newPhone());

      const { body } = await register(s.auth, 'fid-aaa').expect(201);

      const [device] = await devices(s.userId);
      expect(device).toMatchObject({
        id: body.id,
        user_id: s.userId,
        installation_id: 'fid-aaa',
      });
      const [{ session_id }] = await db.query<{ session_id: string }[]>(
        `SELECT session_id FROM refresh_tokens WHERE user_id = $1`,
        [s.userId],
      );
      expect(device.session_id).toBe(session_id);
    });

    it('the same FID again: the same device, seen again; the session survives token rotation', async () => {
      const s = await session(newPhone());
      const first = (await register(s.auth, 'fid-aaa').expect(201)).body.id;
      const { body: rotated } = await http()
        .post('/auth/refresh')
        .send({ refreshToken: s.refreshToken })
        .expect(200);

      const again = (
        await register(
          { Authorization: `Bearer ${rotated.accessToken}` },
          'fid-aaa',
        ).expect(201)
      ).body.id;

      expect(again).toBe(first);
      expect(await devices(s.userId)).toHaveLength(1);
    });

    it('an FID registered by another user moves to the one registering it now (a shared phone)', async () => {
      const a = await session(newPhone());
      const b = await session(newPhone());
      await register(a.auth, 'shared-phone').expect(201);

      await register(b.auth, 'shared-phone').expect(201);

      expect(await devices(a.userId)).toEqual([]);
      expect(await devices(b.userId)).toHaveLength(1);
    });

    it('at most 10 per user (decided 2026-11-24): an 11th replaces the least recently seen', async () => {
      const s = await session(newPhone());
      for (let i = 0; i < 10; i++)
        await register(s.auth, `fid-${i}`).expect(201);
      await db.query(
        `UPDATE devices SET last_seen_at = now() - interval '30 days' WHERE installation_id = 'fid-3'`,
      );

      await register(s.auth, 'fid-new').expect(201);

      const ids = (await devices(s.userId)).map((d) => d.installation_id);
      expect(ids).toHaveLength(10);
      expect(ids).not.toContain('fid-3');
      expect(ids).toContain('fid-new');
    });

    it.each([
      ['an empty FID', { installationId: '  ', platform: 'android' }],
      ['an unknown platform', { installationId: 'x', platform: 'windows' }],
      [
        'an FID over 255 characters',
        { installationId: 'x'.repeat(256), platform: 'ios' },
      ],
    ])('refuses %s: 400', async (_name, body) => {
      const s = await session(newPhone());

      const res = await http()
        .post('/me/devices')
        .set(s.auth)
        .send(body)
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('needs a signed-in user', async () => {
      await http()
        .post('/me/devices')
        .send({ installationId: 'x', platform: 'ios' })
        .expect(401);
    });

    it('an access token from before sessions had ids: 401 ACCESS_TOKEN_EXPIRED, so the app refreshes', async () => {
      const s = await session(newPhone());
      const old = await app.get(JwtService).signAsync(
        { sub: s.userId, typ: 'access' },
        {
          secret: TEST_ENV.JWT_ACCESS_SECRET,
          expiresIn: 900,
          algorithm: 'HS256',
          issuer: 'rental-api',
          audience: 'app',
        },
      );

      const { body } = await register(
        { Authorization: `Bearer ${old}` },
        'x',
      ).expect(401);

      expect(body.code).toBe('ACCESS_TOKEN_EXPIRED');
    });

    it("a session that has ended can't register a phone, even with a still-valid access token", async () => {
      const s = await session(newPhone());
      await http()
        .post('/auth/logout')
        .send({ refreshToken: s.refreshToken })
        .expect(204);

      const { body } = await register(s.auth, 'fid-aaa').expect(401);

      expect(body.code).toBe('UNAUTHENTICATED');
      expect(await devices(s.userId)).toEqual([]);
    });
  });

  describe('DELETE /me/devices/:id', () => {
    it("removes the user's own device; someone else's, an unknown or a malformed id: 404", async () => {
      const a = await session(newPhone());
      const b = await session(newPhone());
      const mine = (await register(a.auth, 'fid-a').expect(201)).body.id;
      const theirs = (await register(b.auth, 'fid-b').expect(201)).body.id;

      await http().delete(`/me/devices/${mine}`).set(a.auth).expect(204);
      for (const id of [
        theirs,
        mine,
        '00000000-0000-4000-8000-000000000000',
        'nope',
      ]) {
        const { body } = await http()
          .delete(`/me/devices/${id}`)
          .set(a.auth)
          .expect(404);
        expect(body.code).toBe('DEVICE_NOT_FOUND');
      }
      expect(await devices(b.userId)).toHaveLength(1);
    });
  });

  describe('devices end with their session (decided 2026-11-24)', () => {
    it("logout deletes that session's devices, and only those", async () => {
      const phone = newPhone();
      const phoneA = await session(phone);
      const phoneB = await session(phone); // the same user on a second phone: another session
      await register(phoneA.auth, 'phone-a').expect(201);
      await register(phoneB.auth, 'phone-b').expect(201);

      await http()
        .post('/auth/logout')
        .send({ refreshToken: phoneA.refreshToken })
        .expect(204);

      expect(
        (await devices(phoneA.userId)).map((d) => d.installation_id),
      ).toEqual(['phone-b']);
    });

    it('revoking all sessions (a reused refresh token, A5) deletes every device of the user', async () => {
      const phone = newPhone();
      const stolen = await session(phone);
      const other = await session(phone);
      await register(stolen.auth, 'phone-a').expect(201);
      await register(other.auth, 'phone-b').expect(201);
      // Rotate twice, then reuse the first token: A5 revokes every session of the user.
      const { body: second } = await http()
        .post('/auth/refresh')
        .send({ refreshToken: stolen.refreshToken })
        .expect(200);
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: second.refreshToken })
        .expect(200);
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: stolen.refreshToken })
        .expect(401);

      expect(await devices(stolen.userId)).toEqual([]);
    });

    it('a ban deletes every device of the user, in the ban transaction', async () => {
      const s = await session(newPhone());
      await register(s.auth, 'phone-a').expect(201);
      const admin = await createTestAdmin(db, { role: 'moderator' });
      const { body: login } = await http()
        .post('/admin/auth/login')
        .send({ email: admin.email, password: admin.password })
        .expect(200);

      await http()
        .post(`/admin/users/${s.userId}/ban`)
        .set({ Authorization: `Bearer ${login.accessToken}` })
        .send({ reason: 'Fake listings' })
        .expect(200);

      expect(await devices(s.userId)).toEqual([]);
    });

    it('a session that just expired gets no push; its device is deleted when one is sent', async () => {
      const s = await session(newPhone());
      await register(s.auth, 'phone-a').expect(201);
      await db.query(
        `UPDATE refresh_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1`,
        [s.userId],
      );

      expect(await push.notify(s.userId, NOTICE)).toBe('no_device');

      expect(sender.sent).toEqual([]);
      expect(await devices(s.userId)).toEqual([]);
    });
  });

  describe('PushService.notify (N1–N4)', () => {
    it("sends to each of the user's live devices, in their language, with the listing to open", async () => {
      const phone = newPhone();
      const a = await session(phone);
      const b = await session(phone);
      await register(a.auth, 'phone-a').expect(201);
      await register(b.auth, 'phone-b', 'ios').expect(201);
      await db.query(
        `UPDATE users SET preferred_language = 'am' WHERE id = $1`,
        [a.userId],
      );

      expect(await push.notify(a.userId, NOTICE)).toBe('sent');

      expect(sender.sent.map((s) => s.installationId).sort()).toEqual([
        'phone-a',
        'phone-b',
      ]);
      expect(sender.sent[0].message).toEqual({
        title: 'ማስታወቂያዎ ጸድቋል',
        body: 'በቦሌ የሚገኘው የአፓርታማ ማስታወቂያዎ አሁን ለተከራዮች ይታያል።',
        data: { type: 'listing_approved', listingId: NOTICE.listingId },
      });
    });

    it('English, and English for Afaan Oromo', async () => {
      for (const language of ['en', 'om']) {
        const s = await session(newPhone());
        await register(s.auth, `phone-${language}`).expect(201);
        await db.query(
          `UPDATE users SET preferred_language = $2 WHERE id = $1`,
          [s.userId, language],
        );
        sender.reset();

        await push.notify(s.userId, NOTICE);

        expect(sender.sent[0].message.title).toBe('Your listing is live');
      }
    });

    it('an installation Firebase no longer knows is deleted (N2); the others still get it', async () => {
      const phone = newPhone();
      const a = await session(phone);
      const b = await session(phone);
      await register(a.auth, 'gone').expect(201);
      await register(b.auth, 'fine').expect(201);
      sender.outcomes.set('gone', 'unregistered');

      expect(await push.notify(a.userId, NOTICE)).toBe('sent');

      expect((await devices(a.userId)).map((d) => d.installation_id)).toEqual([
        'fine',
      ]);
    });

    it('no device: no_device; every send failing: failed (the devices stay)', async () => {
      const s = await session(newPhone());
      expect(await push.notify(s.userId, NOTICE)).toBe('no_device');

      await register(s.auth, 'flaky').expect(201);
      sender.outcomes.set('flaky', 'failed');

      expect(await push.notify(s.userId, NOTICE)).toBe('failed');
      expect(await devices(s.userId)).toHaveLength(1);
    });
  });

  describe('PushService.sendTest (npm run push:send-test; T6.2)', () => {
    it("sends the test message to the user's live devices, in their language", async () => {
      const s = await session(newPhone());
      await register(s.auth, 'phone-a').expect(201);
      await db.query(
        `UPDATE users SET preferred_language = 'am' WHERE id = $1`,
        [s.userId],
      );

      expect(await push.sendTest(s.userId)).toBe('sent');

      expect(sender.sent).toEqual([
        {
          installationId: 'phone-a',
          message: {
            title: 'የሙከራ ማሳወቂያ',
            body: 'ማሳወቂያዎች በዚህ ስልክ ላይ ይሰራሉ።',
            data: { type: 'test' },
          },
        },
      ]);
    });
  });
});
