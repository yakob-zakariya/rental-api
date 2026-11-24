import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AdminUser } from '../admin/admin-user.entity.js';
import {
  CloseReason,
  ListingStatus,
  StaffReasonCode,
} from './listings.enums.js';
import { Property } from './property.entity.js';

/**
 * One period of availability of a property (spec section 2). Closed listings are kept, so the
 * property's history survives relisting (L11, overview §6).
 */
@Entity('listings')
// At most one open listing per property (L10). A partial index whose WHERE TypeORM can't keep in
// step with Postgres's own rewrite of it, so it lives only in the migration.
@Index('UQ_listings_one_open_per_property', { synchronize: false })
// Browse's default order, newest first (G5, T5.1): live listings only. A partial index, so like
// the one above it lives only in the migration.
@Index('IDX_listings_live_newest', { synchronize: false })
@Check('CHK_listings_monthly_rent_birr', `"monthly_rent_birr" > 0`)
@Check('CHK_listings_advance_months', `"advance_months" BETWEEN 1 AND 12`)
@Check('CHK_listings_version', `"version" >= 1`)
@Check('CHK_listings_lister_note', `"lister_note" ~ '\\S'`)
// A draft may be half-filled (decided 2026-11-23); past draft, the listing's own fields are set.
// The property's fields are in another table, so submitting checks those (L2).
@Check(
  'CHK_listings_complete_unless_draft',
  `"status" = 'draft' OR ("monthly_rent_birr" IS NOT NULL AND "advance_months" IS NOT NULL
     AND "negotiable" IS NOT NULL AND "available_from" IS NOT NULL)`,
)
// Closing needs a reason, and the reason fits the state (L12, R5); open listings have none.
// IS NOT NULL is needed: NULL IN (...) is unknown, not false, and a CHECK passes on unknown.
@Check(
  'CHK_listings_close_reason',
  `("status" = 'rented' AND "close_reason" IS NOT NULL
     AND "close_reason" IN ('rented_in_app', 'rented_elsewhere'))
   OR ("status" = 'removed' AND "close_reason" IS NOT NULL
     AND "close_reason" IN ('no_longer_for_rent', 'staff_takedown'))
   OR ("status" NOT IN ('rented', 'removed') AND "close_reason" IS NULL)`,
)
@Check(
  'CHK_listings_closed_at',
  `("status" IN ('rented', 'removed')) = ("closed_at" IS NOT NULL)`,
)
export class Listing {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'property_id', type: 'uuid' })
  propertyId: string;

  @ManyToOne(() => Property)
  @JoinColumn({
    name: 'property_id',
    foreignKeyConstraintName: 'FK_listings_property_id',
  })
  property?: Property;

  /** Whole birr (hard rule 6). */
  @Column({ name: 'monthly_rent_birr', type: 'int', nullable: true })
  monthlyRentBirr: number | null;

  @Column({ name: 'advance_months', type: 'int', nullable: true })
  advanceMonths: number | null;

  @Column({ type: 'boolean', nullable: true })
  negotiable: boolean | null;

  // 'YYYY-MM-DD', a calendar date in Addis Ababa; a string so it never shifts by a time zone.
  @Column({ name: 'available_from', type: 'date', nullable: true })
  availableFrom: string | null;

  @Column({
    type: 'enum',
    enum: ListingStatus,
    enumName: 'listing_status',
    default: ListingStatus.Draft,
  })
  status: ListingStatus;

  @Column({
    name: 'close_reason',
    type: 'enum',
    enum: CloseReason,
    enumName: 'listing_close_reason',
    nullable: true,
  })
  closeReason: CloseReason | null;

  /** The last rejection or takedown reason (R4). */
  @Column({
    name: 'staff_reason_code',
    type: 'enum',
    enum: StaffReasonCode,
    enumName: 'staff_reason_code',
    nullable: true,
  })
  staffReasonCode: StaffReasonCode | null;

  /** Staff's note to the lister with that decision (R4). */
  @Column({ name: 'lister_note', type: 'varchar', length: 300, nullable: true })
  listerNote: string | null;

  /** An expired listing was changed in a way that needs review; reopening then goes to review (L6). */
  @Column({ name: 'needs_review', type: 'boolean', default: false })
  needsReview: boolean;

  /**
   * Goes up by 1 on every edit of the listing, its property or its photos. A reviewer's decision
   * names the version they looked at; any other version is refused (R2, T4.2). Not TypeORM's
   * @VersionColumn: that counts only saves of this row, and property and photo edits matter too.
   */
  @Column({ type: 'int', default: 1 })
  version: number;

  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ name: 'last_confirmed_at', type: 'timestamptz', nullable: true })
  lastConfirmedAt: Date | null;

  @Column({ name: 'stale_at', type: 'timestamptz', nullable: true })
  staleAt: Date | null;

  @Column({ name: 'expired_at', type: 'timestamptz', nullable: true })
  expiredAt: Date | null;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt: Date | null;

  @Column({ name: 'reviewed_by_admin_id', type: 'uuid', nullable: true })
  reviewedByAdminId: string | null;

  @ManyToOne(() => AdminUser)
  @JoinColumn({
    name: 'reviewed_by_admin_id',
    foreignKeyConstraintName: 'FK_listings_reviewed_by_admin_id',
  })
  reviewedByAdmin?: AdminUser;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
