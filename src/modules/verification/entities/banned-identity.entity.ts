import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AdminUser } from '../../admin/admin-user.entity.js';
import { User } from '../../users/user.entity.js';
import { IdentityKind } from '../verification.enums.js';

/** One banned identity hash (V5). Lifting sets lifted_at; the row is kept. */
@Entity('banned_identities')
@Index('IDX_banned_identities_hash', ['hash'])
// One active ban per hash; a lifted hash can be banned again.
@Index('UQ_banned_identities_hash_active', ['hash'], {
  unique: true,
  where: '"lifted_at" IS NULL',
})
export class BannedIdentity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The user whose ban produced this row. */
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_banned_identities_user_id',
  })
  user?: User;

  @Column({ type: 'enum', enum: IdentityKind, enumName: 'identity_kind' })
  kind: IdentityKind;

  /** Same value as in identity_hashes. */
  @Column({ type: 'varchar', length: 64 })
  hash: string;

  @Column({ type: 'varchar', length: 255 })
  reason: string;

  @Column({ name: 'banned_by_admin_id', type: 'uuid' })
  bannedByAdminId: string;

  @ManyToOne(() => AdminUser)
  @JoinColumn({
    name: 'banned_by_admin_id',
    foreignKeyConstraintName: 'FK_banned_identities_banned_by_admin_id',
  })
  bannedByAdmin?: AdminUser;

  @Column({ name: 'lifted_at', type: 'timestamptz', nullable: true })
  liftedAt: Date | null;

  @Column({ name: 'lifted_by_admin_id', type: 'uuid', nullable: true })
  liftedByAdminId: string | null;

  @ManyToOne(() => AdminUser)
  @JoinColumn({
    name: 'lifted_by_admin_id',
    foreignKeyConstraintName: 'FK_banned_identities_lifted_by_admin_id',
  })
  liftedByAdmin?: AdminUser;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
