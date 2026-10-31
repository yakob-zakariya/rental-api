import type { EntityManager } from 'typeorm';
import type { DiditIdVerification } from './didit.types.js';

/** A verified Didit webhook event: its envelope plus the trimmed documents of its decision. */
export interface DiditWebhookEvent {
  eventId: string;
  webhookType: string;
  sessionId: string;
  status: string;
  environment: string;
  vendorData: string | null;
  /** decision.id_verifications[], trimmed (hard rule 1); null when the payload had no decision. */
  idVerifications: DiditIdVerification[] | null;
}

/**
 * Applies a verified Didit event (status.updated / data.updated) inside the webhook's
 * transaction. Its decision data has already been trimmed (hard rule 1).
 * Throwing rolls the transaction back and makes the webhook return 500 so Didit retries.
 */
export abstract class DiditEventProcessor {
  abstract process(
    event: DiditWebhookEvent,
    manager: EntityManager,
  ): Promise<void>;
}
