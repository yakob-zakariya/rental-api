import { SmsSender } from '../../src/modules/sms/sms-sender.js';

export interface SentSms {
  to: string;
  text: string;
}

/**
 * Records messages instead of sending them. Use with
 * `Test.createTestingModule(...).overrideProvider(SmsSender).useValue(fakeSms)`.
 */
export class FakeSmsSender extends SmsSender {
  readonly sent: SentSms[] = [];

  send(to: string, text: string): Promise<void> {
    this.sent.push({ to, text });
    return Promise.resolve();
  }

  /** The most recent message sent to `to`, or undefined. */
  lastTextTo(to: string): string | undefined {
    return this.sent.findLast((sms) => sms.to === to)?.text;
  }

  clear(): void {
    this.sent.length = 0;
  }
}
