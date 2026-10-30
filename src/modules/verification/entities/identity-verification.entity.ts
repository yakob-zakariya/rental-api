import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/user.entity.js';
import { VerificationOutcome } from '../verification.enums.js';

/** One identity verification attempt (one Didit session). Never stores images or raw ID numbers. */
@Entity('identity_verifications')
@Unique('UQ_identity_verifications_provider_session_id', ['providerSessionId'])
// V3 counts and recompute's "most recent attempt" both read a user's attempts by date.
@Index('IDX_identity_verifications_user_id_created_at', ['userId', 'createdAt'])
// The resume URL and token only exist while the attempt is pending (cleared on a final outcome).
@Check(
  'CHK_identity_verifications_resume_only_pending',
  `"outcome" = 'pending' OR ("verification_url" IS NULL AND "session_token" IS NULL)`,
)
@Check(
  'CHK_identity_verifications_decided_pair',
  `("decided_by_admin_id" IS NULL) = ("decided_at" IS NULL)`,
)
@Check(
  'CHK_identity_verifications_flag_pair',
  `("flagged_at" IS NULL) = ("flag_reason" IS NULL)`,
)
export class IdentityVerification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_identity_verifications_user_id',
  })
  user?: User;

  @Column({ type: 'varchar', length: 32, default: 'didit' })
  provider: string;

  @Column({ name: 'provider_session_id', type: 'varchar', length: 64 })
  providerSessionId: string;

  /** Didit's latest status as received, e.g. "In Progress" — always recorded. */
  @Column({ name: 'provider_status', type: 'varchar', length: 32 })
  providerStatus: string;

  @Column({
    type: 'enum',
    enum: VerificationOutcome,
    enumName: 'verification_outcome',
    default: VerificationOutcome.Pending,
  })
  outcome: VerificationOutcome;

  /** Internal reason code, e.g. UNDERAGE. */
  @Column({
    name: 'decline_reason',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  declineReason: string | null;

  @Column({
    name: 'document_type',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  documentType: string | null;

  @Column({ name: 'verified_name', type: 'varchar', nullable: true })
  verifiedName: string | null;

  // 'YYYY-MM-DD', a string so it never shifts through time zone conversion.
  @Column({ name: 'date_of_birth', type: 'date', nullable: true })
  dateOfBirth: string | null;

  /** For resuming (V2); null once the outcome is final. */
  @Column({
    name: 'verification_url',
    type: 'varchar',
    length: 2048,
    nullable: true,
  })
  verificationUrl: string | null;

  /** For resuming (V2); null once the outcome is final. A secret. */
  @Column({
    name: 'session_token',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  sessionToken: string | null;

  @Column({
    name: 'manual_review_requested_at',
    type: 'timestamptz',
    nullable: true,
  })
  manualReviewRequestedAt: Date | null;

  @Column({ name: 'flagged_at', type: 'timestamptz', nullable: true })
  flaggedAt: Date | null;

  /** e.g. DUPLICATE_IDENTITY, APPROVAL_REVERSED, DATA_UPDATED. */
  @Column({ name: 'flag_reason', type: 'varchar', length: 64, nullable: true })
  flagReason: string | null;

  // References admin_users once that table exists; the foreign key is added in T3.1.
  @Column({ name: 'decided_by_admin_id', type: 'uuid', nullable: true })
  decidedByAdminId: string | null;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
