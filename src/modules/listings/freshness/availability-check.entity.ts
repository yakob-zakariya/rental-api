import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Listing } from '../listing.entity.js';

/** How a check ended (decided 2026-11-24, in place of the spec's `response`). */
export enum CheckOutcome {
  /** The lister confirmed it (F2), or restored it (F4) by answering late. */
  Available = 'available',
  /** The lister closed it from the check (F2, L12). */
  NotAvailable = 'not_available',
  /** No answer in the window: the listing went stale (F3). */
  NoAnswer = 'no_answer',
  /** The listing left `live` another way (an edit to review, a close, a takedown, a ban). */
  Cancelled = 'cancelled',
}

/** What happened to a push (availability_checks.push_result; for support). */
export enum PushResult {
  Sent = 'sent',
  NoDevice = 'no_device',
  Failed = 'failed',
}

/**
 * The weekly "still available?" check (spec F1–F6; T6.3). Open while `closed_at` is null: at most
 * one per listing (the partial unique index), so running the job twice can't make two. A trigger
 * cancels the open check whenever the listing leaves `live` by a path that didn't close it.
 */
@Entity('availability_checks')
@Index('UQ_availability_checks_one_open', ['listingId'], {
  unique: true,
  where: '"closed_at" IS NULL',
})
@Index('IDX_availability_checks_listing_sent', ['listingId', 'sentAt'])
@Check(
  'CHK_availability_checks_closed',
  `("closed_at" IS NULL) = ("outcome" IS NULL)`,
)
@Check(
  'CHK_availability_checks_responded',
  `("responded_at" IS NOT NULL) = COALESCE("outcome" IN ('available', 'not_available'), false)`,
)
@Check(
  'CHK_availability_checks_stale_push',
  `"stale_pushed_at" IS NULL OR COALESCE("outcome" = 'no_answer', false)`,
)
export class AvailabilityCheck {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'listing_id', type: 'uuid' })
  listingId: string;

  @ManyToOne(() => Listing)
  @JoinColumn({
    name: 'listing_id',
    foreignKeyConstraintName: 'FK_availability_checks_listing_id',
  })
  listing?: Listing;

  /** When the check was made and its push attempted; the answer window starts here (F3). */
  @Column({ name: 'sent_at', type: 'timestamptz', default: () => 'now()' })
  sentAt: Date;

  /** Null until the send returns (or if the job stopped in between; decided 2026-11-24). */
  @Column({
    name: 'push_result',
    type: 'enum',
    enum: PushResult,
    enumName: 'push_result',
    nullable: true,
  })
  pushResult: PushResult | null;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt: Date | null;

  @Column({
    type: 'enum',
    enum: CheckOutcome,
    enumName: 'availability_check_outcome',
    nullable: true,
  })
  outcome: CheckOutcome | null;

  /** When the lister answered (available or not_available only). */
  @Column({ name: 'responded_at', type: 'timestamptz', nullable: true })
  respondedAt: Date | null;

  /** The "your listing is hidden" push (decided 2026-11-24), for a no_answer check. */
  @Column({ name: 'stale_pushed_at', type: 'timestamptz', nullable: true })
  stalePushedAt: Date | null;

  @Column({
    name: 'stale_push_result',
    type: 'enum',
    enum: PushResult,
    enumName: 'push_result',
    nullable: true,
  })
  stalePushResult: PushResult | null;
}
