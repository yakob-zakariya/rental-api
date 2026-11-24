import { Logger } from '@nestjs/common';
import {
  type PushMessage,
  type PushOutcome,
  PushSender,
} from './push-sender.js';

/** Development: logs each push instead of sending it. Never logs a whole installation ID. */
export class ConsolePushSender extends PushSender {
  private readonly logger = new Logger('Push');

  send(installationId: string, message: PushMessage): Promise<PushOutcome> {
    this.logger.log(
      `To …${installationId.slice(-6)}: "${message.title}" / "${message.body}" ${JSON.stringify(message.data)}`,
    );
    return Promise.resolve('sent');
  }
}
