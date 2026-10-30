import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { User } from '../../users/user.entity.js';
import { IdentityKind } from '../verification.enums.js';
import { IdentityVerification } from './identity-verification.entity.js';

/**
 * One HMAC of one identifier Didit returned for an attempt (spec V10). The raw number is never
 * stored (hard rules 1 and 2).
 */
@Entity('identity_hashes')
// The same identifier is stored once per attempt. Also serves lookups by verification_id.
@Unique('UQ_identity_hashes_verification_hash', ['verificationId', 'hash'])
@Index('IDX_identity_hashes_user_id', ['userId'])
// V5 / V6 lookups by hash, approved or not.
@Index('IDX_identity_hashes_hash', ['hash'])
// The database guarantee behind V6: an identifier can be approved for only one user, even under
// a race. A violation on approval is treated as a duplicate identity.
@Index('UQ_identity_hashes_hash_approved', ['hash'], {
  unique: true,
  where: '"is_approved"',
})
export class IdentityHash {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'verification_id', type: 'uuid' })
  verificationId: string;

  @ManyToOne(() => IdentityVerification)
  @JoinColumn({
    name: 'verification_id',
    foreignKeyConstraintName: 'FK_identity_hashes_verification_id',
  })
  verification?: IdentityVerification;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_identity_hashes_user_id',
  })
  user?: User;

  @Column({ type: 'enum', enum: IdentityKind, enumName: 'identity_kind' })
  kind: IdentityKind;

  /** HMAC-SHA256 hex (V10). */
  @Column({ type: 'varchar', length: 64 })
  hash: string;

  /** Mirrors "the attempt's outcome is approved"; updated in the same transaction. */
  @Column({ name: 'is_approved', type: 'boolean', default: false })
  isApproved: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
