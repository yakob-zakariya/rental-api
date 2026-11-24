/** What a push says (spec N3, N4) and what the app does when it's tapped (`data`). */
export interface PushMessage {
  title: string;
  body: string;
  /** For the app: `type` (which notice) and `listingId` (the screen to open). Strings only (FCM). */
  data: Record<string, string>;
}

/**
 * How one send to one device went. `unregistered`: FCM no longer knows this installation (the app
 * was uninstalled, its data cleared, or it went unused for 270 days): delete the device (N2).
 */
export type PushOutcome = 'sent' | 'unregistered' | 'failed';

/**
 * Sends one push to one device. Inject `PushSender`; PushModule picks the implementation from
 * PUSH_PROVIDER (console or fcm), and tests swap in test/fakes/fake-push-sender.ts.
 */
export abstract class PushSender {
  abstract send(
    installationId: string,
    message: PushMessage,
  ): Promise<PushOutcome>;
}
