import { readFileSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import {
  type FidMessage,
  getMessaging,
  type Messaging,
} from 'firebase-admin/messaging';
import {
  type PushMessage,
  type PushOutcome,
  PushSender,
} from './push-sender.js';

// Firebase Cloud Messaging (spec N1; T6.2), through firebase-admin (HTTP v1). Phones are
// addressed by their Firebase Installation ID (FID): Firebase deprecated registration tokens.
// Android only for now; iOS needs an APNs key in Firebase first (a later task).

/** The Android notification channel every Phase 2 push uses; the app creates it (api-for-mobile). */
export const ANDROID_CHANNEL_ID = 'listings';

/** A named Firebase app, so nothing else in the process can pick up these credentials by default. */
const FIREBASE_APP_NAME = 'rental-api';

/**
 * firebase-admin's codes for "this installation is gone": delete the device (N2). FIDs give
 * installation-id-not-registered; the token codes are kept for safety. `invalid-argument` isn't
 * here: FCM also returns it for a bad message, and a bug of ours mustn't delete every device.
 */
const UNREGISTERED_CODES = new Set([
  'messaging/installation-id-not-registered',
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/** Our own setup is wrong (another project's key, a revoked key): no device is at fault. */
const CONFIGURATION_CODES = new Set([
  'messaging/mismatched-credential',
  'messaging/authentication-error',
  'messaging/invalid-credential',
]);

/** The FCM message for one push: a visible notification, the data for the app, Android settings. */
export function fcmMessage(
  installationId: string,
  message: PushMessage,
): FidMessage {
  return {
    fid: installationId,
    notification: { title: message.title, body: message.body },
    data: message.data,
    android: {
      // Shown at once, even when the phone is idle: these are notices the lister acts on.
      priority: 'high',
      notification: { channelId: ANDROID_CHANNEL_ID },
    },
  };
}

interface ServiceAccountFile {
  project_id: string;
  client_email: string;
  private_key: string;
}

/**
 * Reads and checks the service-account JSON, so a wrong file stops the app at startup instead of
 * failing every push later. Errors name the file but never show its contents.
 */
export function readServiceAccount(path: string): ServiceAccountFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`FCM_SERVICE_ACCOUNT_FILE: can't read ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`FCM_SERVICE_ACCOUNT_FILE: ${path} isn't JSON`);
  }
  const account = json as Partial<Record<string, unknown>>;
  const fields = ['project_id', 'client_email', 'private_key'] as const;
  if (
    account.type !== 'service_account' ||
    fields.some((f) => typeof account[f] !== 'string' || account[f] === '')
  ) {
    throw new Error(
      `FCM_SERVICE_ACCOUNT_FILE: ${path} isn't a Firebase service-account key ` +
        '(Project settings → Service accounts → Generate new private key)',
    );
  }
  return account as unknown as ServiceAccountFile;
}

/** Sends through FCM. Inject `PushSender`; PushModule builds this when PUSH_PROVIDER=fcm. */
export class FcmPushSender extends PushSender {
  private readonly logger = new Logger('Push');

  constructor(private readonly messaging: Pick<Messaging, 'send'>) {
    super();
  }

  static fromServiceAccountFile(path: string): FcmPushSender {
    const account = readServiceAccount(path);
    const app =
      getApps().find((a) => a.name === FIREBASE_APP_NAME) ??
      initializeApp(
        {
          credential: cert({
            projectId: account.project_id,
            clientEmail: account.client_email,
            privateKey: account.private_key,
          }),
          projectId: account.project_id,
        },
        FIREBASE_APP_NAME,
      );
    return new FcmPushSender(getMessaging(app));
  }

  async send(
    installationId: string,
    message: PushMessage,
  ): Promise<PushOutcome> {
    try {
      // firebase-admin itself retries FCM's 503s and some 500s.
      await this.messaging.send(fcmMessage(installationId, message));
      return 'sent';
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && UNREGISTERED_CODES.has(code))
        return 'unregistered';
      // Only the code and the ID's last characters are logged: the error text can echo the ID.
      const where = `…${installationId.slice(-6)}`;
      if (typeof code === 'string' && CONFIGURATION_CODES.has(code))
        this.logger.error(
          `Push to ${where} refused (${code}): check FCM_SERVICE_ACCOUNT_FILE`,
        );
      else
        this.logger.warn(
          `Push to ${where} failed (${typeof code === 'string' ? code : 'no code'})`,
        );
      return 'failed';
    }
  }
}
