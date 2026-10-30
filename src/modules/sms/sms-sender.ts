/**
 * Sends text messages. Inject `SmsSender`; SmsModule picks the implementation from SMS_PROVIDER,
 * and tests swap in test/fakes/fake-sms-sender.ts.
 */
export abstract class SmsSender {
  /** `to` is E.164. Resolves once the provider has accepted the message. */
  abstract send(to: string, text: string): Promise<void>;
}
