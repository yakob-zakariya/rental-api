import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { deleteApp, getApps } from 'firebase-admin/app';
import {
  ANDROID_CHANNEL_ID,
  FcmPushSender,
  fcmMessage,
  readServiceAccount,
} from './fcm-push-sender.js';
import type { PushMessage } from './push-sender.js';

// The FCM sender (N1, N2; T6.2). Firebase itself is never called: `send` is faked.

const FID = 'cR7qbBNjSmKZ3Oq0Xx9kQ1';
const MESSAGE: PushMessage = {
  title: 'Your listing is live',
  body: 'Your apartment in Bole is now visible to tenants.',
  data: { type: 'listing_approved', listingId: 'abc' },
};

const firebaseError = (code: string) =>
  Object.assign(new Error(`Requested entity was not found: ${FID}`), { code });

describe('FcmPushSender', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fcm-spec-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await Promise.all(getApps().map((app) => deleteApp(app)));
  });

  const file = (name: string, contents: string) => {
    const path = join(dir, name);
    writeFileSync(path, contents);
    return path;
  };
  const serviceAccount = () => ({
    type: 'service_account',
    project_id: 'rental-dev',
    client_email: 'firebase-adminsdk@rental-dev.iam.gserviceaccount.com',
    private_key: generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString(),
  });

  it('sends to the installation ID: a notification, the data, high priority, the listings channel', async () => {
    const send = vi.fn().mockResolvedValue('projects/rental-dev/messages/1');

    expect(await new FcmPushSender({ send }).send(FID, MESSAGE)).toBe('sent');

    expect(send).toHaveBeenCalledWith({
      fid: FID,
      notification: { title: MESSAGE.title, body: MESSAGE.body },
      data: MESSAGE.data,
      android: { priority: 'high', notification: { channelId: 'listings' } },
    });
    expect(ANDROID_CHANNEL_ID).toBe('listings');
    expect(fcmMessage(FID, MESSAGE)).not.toHaveProperty('token');
  });

  it.each([
    'messaging/installation-id-not-registered',
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
  ])('%s: unregistered, so the device is deleted (N2)', async (code) => {
    const send = vi.fn().mockRejectedValue(firebaseError(code));

    expect(await new FcmPushSender({ send }).send(FID, MESSAGE)).toBe(
      'unregistered',
    );
  });

  it.each([
    // FCM also gives invalid-argument for a bad message: a bug of ours mustn't delete devices.
    'messaging/invalid-argument',
    'messaging/server-unavailable',
    'messaging/internal-error',
    'messaging/message-rate-exceeded',
  ])('%s: failed, and the device stays', async (code) => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const send = vi.fn().mockRejectedValue(firebaseError(code));

    expect(await new FcmPushSender({ send }).send(FID, MESSAGE)).toBe('failed');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(code));
    expect(warn.mock.calls.join(' ')).not.toContain(FID);
  });

  it('a wrong key or project: failed, logged as an error pointing at the setting', async () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const send = vi
      .fn()
      .mockRejectedValue(firebaseError('messaging/mismatched-credential'));

    expect(await new FcmPushSender({ send }).send(FID, MESSAGE)).toBe('failed');

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('FCM_SERVICE_ACCOUNT_FILE'),
    );
    expect(error.mock.calls.join(' ')).not.toContain(FID);
  });

  it('an error without a code (a network failure): failed', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const send = vi.fn().mockRejectedValue(new Error('socket hang up'));

    expect(await new FcmPushSender({ send }).send(FID, MESSAGE)).toBe('failed');
  });

  describe('the service-account file, checked at startup', () => {
    it('a real key file: the sender is built (no network needed)', () => {
      const path = file('ok.json', JSON.stringify(serviceAccount()));

      expect(FcmPushSender.fromServiceAccountFile(path)).toBeInstanceOf(
        FcmPushSender,
      );
      // Building it again reuses the named Firebase app instead of failing.
      expect(FcmPushSender.fromServiceAccountFile(path)).toBeInstanceOf(
        FcmPushSender,
      );
    });

    it('a missing file, a non-JSON file, or JSON that is not a service account: a clear error', () => {
      const { private_key, ...noKey } = serviceAccount();
      void private_key;
      expect(() => readServiceAccount(join(dir, 'missing.json'))).toThrow(
        "can't read",
      );
      expect(() => readServiceAccount(file('bad.json', 'not json'))).toThrow(
        "isn't JSON",
      );
      for (const contents of [
        { ...serviceAccount(), type: 'authorized_user' },
        noKey,
        { ...serviceAccount(), project_id: '' },
        // google-services.json, the app's file, is a common mix-up.
        { project_info: { project_id: 'rental-dev' }, client: [] },
      ])
        expect(() =>
          readServiceAccount(file('wrong.json', JSON.stringify(contents))),
        ).toThrow("isn't a Firebase service-account key");
    });

    it("errors never show the file's contents", () => {
      const account = { ...serviceAccount(), type: 'nope' };
      const path = file('secret.json', JSON.stringify(account));

      expect(() => readServiceAccount(path)).toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining('PRIVATE KEY') as unknown,
        }),
      );
    });
  });
});
