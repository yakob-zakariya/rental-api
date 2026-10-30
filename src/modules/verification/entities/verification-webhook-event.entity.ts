import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * One Didit webhook event, for idempotency (V11) and audit. Stores no payload, images or ID
 * numbers.
 */
@Entity('verification_webhook_events')
@Unique('UQ_verification_webhook_events_event_key', ['eventKey'])
@Index('IDX_verification_webhook_events_provider_session_id', [
  'providerSessionId',
])
export class VerificationWebhookEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Didit's event_id, the same on every retry of an event. */
  @Column({ name: 'event_key', type: 'varchar', length: 64 })
  eventKey: string;

  /** e.g. status.updated, data.updated. */
  @Column({ name: 'webhook_type', type: 'varchar', length: 64 })
  webhookType: string;

  @Column({ name: 'provider_session_id', type: 'varchar', length: 64 })
  providerSessionId: string;

  @Column({
    name: 'provider_status',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  providerStatus: string | null;

  @CreateDateColumn({ name: 'received_at', type: 'timestamptz' })
  receivedAt: Date;

  /** Set only after processing succeeded; an event is skipped only when this is set (V11). */
  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;
}
