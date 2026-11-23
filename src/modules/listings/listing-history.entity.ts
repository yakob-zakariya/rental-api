import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import {
  ActorType,
  CloseReason,
  ListingHistoryEvent,
  ListingStatus,
  StaffReasonCode,
} from './listings.enums.js';
import { Listing } from './listing.entity.js';

/**
 * Every state change and every rent or available-from change of a listing (spec section 2,
 * overview §6), written in the same transaction as the change. Rows are never changed (a trigger
 * refuses UPDATE); they go only when a never-reviewed draft is deleted, with the draft.
 */
@Entity('listing_history')
@Index('IDX_listing_history_listing_id_created_at', ['listingId', 'createdAt'])
// Each event fills its own columns and no others.
@Check(
  'CHK_listing_history_event_fields',
  `("event" = 'status' AND "new_status" IS NOT NULL
     AND "old_monthly_rent_birr" IS NULL AND "new_monthly_rent_birr" IS NULL
     AND "old_available_from" IS NULL AND "new_available_from" IS NULL)
   OR ("event" = 'monthly_rent'
     AND "old_monthly_rent_birr" IS NOT NULL AND "new_monthly_rent_birr" IS NOT NULL
     AND "old_status" IS NULL AND "new_status" IS NULL
     AND "old_available_from" IS NULL AND "new_available_from" IS NULL)
   OR ("event" = 'available_from'
     AND "old_available_from" IS NOT NULL AND "new_available_from" IS NOT NULL
     AND "old_status" IS NULL AND "new_status" IS NULL
     AND "old_monthly_rent_birr" IS NULL AND "new_monthly_rent_birr" IS NULL)`,
)
// Reasons go with the status change that closed, rejected or took down the listing.
@Check(
  'CHK_listing_history_reasons',
  `"event" = 'status' OR ("close_reason" IS NULL AND "staff_reason_code" IS NULL)`,
)
@Check(
  'CHK_listing_history_monthly_rent_birr',
  `"old_monthly_rent_birr" > 0 AND "new_monthly_rent_birr" > 0`,
)
// A scheduled job has no id; a user or a staff member always does.
@Check(
  'CHK_listing_history_actor',
  `("actor_type" = 'system') = ("actor_id" IS NULL)`,
)
export class ListingHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'listing_id', type: 'uuid' })
  listingId: string;

  // Deleting a draft takes its history with it (a draft was never reviewed, so nothing is kept).
  @ManyToOne(() => Listing, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'listing_id',
    foreignKeyConstraintName: 'FK_listing_history_listing_id',
  })
  listing?: Listing;

  @Column({
    type: 'enum',
    enum: ListingHistoryEvent,
    enumName: 'listing_history_event',
  })
  event: ListingHistoryEvent;

  /** Null on creation. */
  @Column({
    name: 'old_status',
    type: 'enum',
    enum: ListingStatus,
    enumName: 'listing_status',
    nullable: true,
  })
  oldStatus: ListingStatus | null;

  @Column({
    name: 'new_status',
    type: 'enum',
    enum: ListingStatus,
    enumName: 'listing_status',
    nullable: true,
  })
  newStatus: ListingStatus | null;

  @Column({ name: 'old_monthly_rent_birr', type: 'int', nullable: true })
  oldMonthlyRentBirr: number | null;

  @Column({ name: 'new_monthly_rent_birr', type: 'int', nullable: true })
  newMonthlyRentBirr: number | null;

  @Column({ name: 'old_available_from', type: 'date', nullable: true })
  oldAvailableFrom: string | null;

  @Column({ name: 'new_available_from', type: 'date', nullable: true })
  newAvailableFrom: string | null;

  @Column({
    name: 'close_reason',
    type: 'enum',
    enum: CloseReason,
    enumName: 'listing_close_reason',
    nullable: true,
  })
  closeReason: CloseReason | null;

  @Column({
    name: 'staff_reason_code',
    type: 'enum',
    enum: StaffReasonCode,
    enumName: 'staff_reason_code',
    nullable: true,
  })
  staffReasonCode: StaffReasonCode | null;

  @Column({
    name: 'actor_type',
    type: 'enum',
    enum: ActorType,
    enumName: 'actor_type',
  })
  actorType: ActorType;

  /** A user or staff id, by actor_type; no foreign key, since it can point at either table. */
  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
