/** What a push says (spec N3, N4) and what the app does when it's tapped (`data`). */
export interface PushMessage {
  title: string;
  body: string;
  /** For the app: `type` (which notice) and `listingId` (the screen to open). Strings only (FCM). */
  data: Record<string, string>;
}

/** How one send to one device went. `invalid_token`: the device is gone; delete it (N2). */
export type PushOutcome = 'sent' | 'invalid_token' | 'failed';

/**
 * Sends one push to one device. Inject `PushSender`; PushModule picks the implementation from
 * PUSH_PROVIDER (console now; FCM in T6.2), and tests swap in test/fakes/fake-push-sender.ts.
 */
export abstract class PushSender {
  abstract send(fcmToken: string, message: PushMessage): Promise<PushOutcome>;
}
