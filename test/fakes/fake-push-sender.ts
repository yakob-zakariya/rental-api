import {
  type PushMessage,
  type PushOutcome,
  PushSender,
} from '../../src/modules/push/push-sender.js';

/** Records pushes; a test can make an installation fail or be unregistered. */
export class FakePushSender extends PushSender {
  sent: { installationId: string; message: PushMessage }[] = [];
  outcomes = new Map<string, PushOutcome>();

  send(installationId: string, message: PushMessage): Promise<PushOutcome> {
    const outcome = this.outcomes.get(installationId) ?? 'sent';
    if (outcome === 'sent') this.sent.push({ installationId, message });
    return Promise.resolve(outcome);
  }

  reset(): void {
    this.sent = [];
    this.outcomes.clear();
  }
}
