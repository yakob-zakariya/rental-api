import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type {
  DiditEnvironment,
  EnvironmentVariables,
} from '../../config/env.validation.js';
import {
  DiditEventProcessor,
  type DiditWebhookEvent,
} from './didit/didit-event-processor.js';
import { trimIdVerifications } from './didit/decision-parser.js';
import { verifyDiditSignature } from './didit/webhook-signature.js';

/** Event types handed to the processor; any other type is recorded and marked processed. */
export const HANDLED_WEBHOOK_TYPES = ['status.updated', 'data.updated'];
const MAX_ERROR_LENGTH = 500;

export interface WebhookDelivery {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: Buffer;
}

/**
 * POST /webhooks/didit (spec §4 flow step 3, V11). Responses: 200 processed or duplicate;
 * 401 WEBHOOK_SIGNATURE_INVALID; 400 WEBHOOK_ENVIRONMENT_MISMATCH / WEBHOOK_INVALID_PAYLOAD
 * (not retried by Didit); 500 WEBHOOK_PROCESSING_FAILED (Didit retries; polling is the backstop).
 * The payload itself is never stored or logged.
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger('DiditWebhook');
  private readonly secret: string;
  private readonly environment: DiditEnvironment;

  constructor(
    private readonly dataSource: DataSource,
    private readonly processor: DiditEventProcessor,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.secret = config.get('DIDIT_WEBHOOK_SECRET', { infer: true });
    this.environment = config.get('DIDIT_ENVIRONMENT', { infer: true });
  }

  async receive(delivery: WebhookDelivery): Promise<void> {
    // Hard rule 4: nothing is read from the payload before its signature is verified.
    const check = verifyDiditSignature({
      ...delivery,
      secret: this.secret,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!check.ok) {
      this.logger.warn(`Rejected a Didit webhook: ${check.reason}`);
      throw new UnauthorizedException({ code: 'WEBHOOK_SIGNATURE_INVALID' });
    }
    this.logger.debug(`Didit webhook signature verified via ${check.via}`);

    const event = parseEnvelope(delivery.body);
    if (event.environment !== this.environment) {
      // A destination of the wrong Didit app points at this server: a configuration problem.
      this.logger.warn(
        `Rejected a Didit webhook for environment "${event.environment}": ` +
          `this server accepts "${this.environment}" (check the webhook destination)`,
      );
      throw new BadRequestException({ code: 'WEBHOOK_ENVIRONMENT_MISMATCH' });
    }

    try {
      await this.process(event);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const message =
        `${(error as Error).name}: ${(error as Error).message}`.slice(
          0,
          MAX_ERROR_LENGTH,
        );
      this.logger.error(
        `Processing Didit event ${event.eventId} failed: ${message}`,
      );
      await this.recordError(event, message);
      throw new InternalServerErrorException({
        code: 'WEBHOOK_PROCESSING_FAILED',
      });
    }
  }

  /** One transaction: the event row and the processing's effects commit together. */
  private process(event: DiditWebhookEvent): Promise<void> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO verification_webhook_events
           (event_key, webhook_type, provider_session_id, provider_status)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (event_key) DO NOTHING`,
        [event.eventId, event.webhookType, event.sessionId, event.status],
      );
      // FOR UPDATE: concurrent deliveries of one event take turns, so it's processed once.
      const [row] = await manager.query<{ id: string; processed: boolean }[]>(
        `SELECT id, processed_at IS NOT NULL AS processed
         FROM verification_webhook_events WHERE event_key = $1 FOR UPDATE`,
        [event.eventId],
      );
      // V11: skipped only once processing has succeeded.
      if (row.processed) return;

      if (HANDLED_WEBHOOK_TYPES.includes(event.webhookType)) {
        await this.processor.process(event, manager);
      }
      await manager.query(
        `UPDATE verification_webhook_events
         SET processed_at = clock_timestamp(), error = NULL
         WHERE id = $1`,
        [row.id],
      );
    });
  }

  /** After a rollback: keep the event (unprocessed) with its error, so a retry processes it. */
  private async recordError(
    event: DiditWebhookEvent,
    message: string,
  ): Promise<void> {
    try {
      await this.dataSource.query(
        `INSERT INTO verification_webhook_events
           (event_key, webhook_type, provider_session_id, provider_status, error)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (event_key) DO UPDATE SET error = EXCLUDED.error`,
        [
          event.eventId,
          event.webhookType,
          event.sessionId,
          event.status,
          message,
        ],
      );
    } catch (error) {
      this.logger.error(
        `Could not record the error: ${(error as Error).message}`,
      );
    }
  }
}

/** The envelope fields we need, all strings. Anything else is a malformed delivery. */
function parseEnvelope(body: unknown): DiditWebhookEvent {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  const fields = [
    'event_id',
    'webhook_type',
    'session_id',
    'status',
    'environment',
  ] as const;
  if (
    !fields.every((field) => typeof b[field] === 'string' && b[field] !== '')
  ) {
    throw new BadRequestException({ code: 'WEBHOOK_INVALID_PAYLOAD' });
  }
  return {
    eventId: b.event_id as string,
    webhookType: b.webhook_type as string,
    sessionId: b.session_id as string,
    status: b.status as string,
    environment: b.environment as string,
    vendorData: typeof b.vendor_data === 'string' ? b.vendor_data : null,
    idVerifications: idVerificationsOf(b.decision),
  };
}

/** decision.id_verifications[], trimmed; null when there is no decision (or no such array). */
function idVerificationsOf(decision: unknown) {
  if (typeof decision !== 'object' || decision === null) return null;
  const items = (decision as Record<string, unknown>).id_verifications;
  return Array.isArray(items) ? trimIdVerifications(items) : null;
}
