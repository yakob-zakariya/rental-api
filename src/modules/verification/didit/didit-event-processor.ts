import { Injectable, Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/** The verified envelope of a Didit webhook event (never the decision payload). */
export interface DiditWebhookEvent {
  eventId: string;
  webhookType: string;
  sessionId: string;
  status: string;
  environment: string;
  vendorData: string | null;
}

/**
 * Applies a verified Didit event (status.updated / data.updated) inside the webhook's
 * transaction. Decision data is re-fetched through DiditClient, which trims it (hard rule 1).
 * Throwing rolls the transaction back and makes the webhook return 500 so Didit retries.
 */
export abstract class DiditEventProcessor {
  abstract process(
    event: DiditWebhookEvent,
    manager: EntityManager,
  ): Promise<void>;
}

/** Placeholder until decision processing exists (T2.6): only logs the envelope. */
@Injectable()
export class LoggingDiditEventProcessor extends DiditEventProcessor {
  private readonly logger = new Logger('DiditEvents');

  process(event: DiditWebhookEvent): Promise<void> {
    this.logger.log(
      `Didit ${event.webhookType} for session ${event.sessionId}: ${event.status} (not processed yet)`,
    );
    return Promise.resolve();
  }
}
