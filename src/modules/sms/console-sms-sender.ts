import { Injectable, Logger } from '@nestjs/common';
import { SmsSender } from './sms-sender.js';

/**
 * Development only (rule A7): logs messages, including OTP codes, instead of sending them.
 * validateEnv refuses SMS_PROVIDER=console in production.
 */
@Injectable()
export class ConsoleSmsSender extends SmsSender {
  private readonly logger = new Logger('SMS');

  send(to: string, text: string): Promise<void> {
    this.logger.log(`To ${to}: ${text}`);
    return Promise.resolve();
  }
}
