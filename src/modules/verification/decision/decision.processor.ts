import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  DiditEventProcessor,
  type DiditWebhookEvent,
} from '../didit/didit-event-processor.js';
import { DecisionService } from './decision.service.js';

/** Webhook events → decision processing (spec §4 flow step 3). */
@Injectable()
export class DecisionProcessor extends DiditEventProcessor {
  constructor(private readonly decisions: DecisionService) {
    super();
  }

  async process(
    event: DiditWebhookEvent,
    manager: EntityManager,
  ): Promise<void> {
    if (event.webhookType === 'data.updated') {
      // Someone edited the extracted data in Didit: tell staff, never change name/DOB (V9).
      const [attempt] = await manager.query<{ id: string }[]>(
        `SELECT id FROM identity_verifications WHERE provider_session_id = $1 FOR UPDATE`,
        [event.sessionId],
      );
      if (attempt) await this.decisions.flag(manager, attempt, 'DATA_UPDATED');
      return;
    }

    await this.decisions.apply(
      {
        sessionId: event.sessionId,
        status: event.status,
        idVerifications: event.idVerifications,
      },
      manager,
    );
  }
}
