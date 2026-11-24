import {
  type PushMessage,
  type PushOutcome,
  PushSender,
} from '../../src/modules/push/push-sender.js';

/** Records pushes; a test can make a token fail or be invalid. */
export class FakePushSender extends PushSender {
  sent: { token: string; message: PushMessage }[] = [];
  outcomes = new Map<string, PushOutcome>();

  send(fcmToken: string, message: PushMessage): Promise<PushOutcome> {
    const outcome = this.outcomes.get(fcmToken) ?? 'sent';
    if (outcome === 'sent') this.sent.push({ token: fcmToken, message });
    return Promise.resolve(outcome);
  }

  reset(): void {
    this.sent = [];
    this.outcomes.clear();
  }
}
