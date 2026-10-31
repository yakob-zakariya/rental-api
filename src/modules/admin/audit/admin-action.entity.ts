import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AdminUser } from '../admin-user.entity.js';
import type { AuditDetails } from './audit-details.js';

/**
 * One staff action (spec S1). Append-only: a database trigger rejects UPDATE and DELETE.
 * Never holds personal documents or raw ID numbers (hard rules 1 and 11).
 */
@Entity('admin_actions')
// GET /admin/actions?targetId=…, newest first.
@Index('IDX_admin_actions_target_id_created_at', ['targetId', 'createdAt'])
@Index('IDX_admin_actions_admin_id_created_at', ['adminId', 'createdAt'])
export class AdminAction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'admin_id', type: 'uuid' })
  adminId: string;

  @ManyToOne(() => AdminUser)
  @JoinColumn({
    name: 'admin_id',
    foreignKeyConstraintName: 'FK_admin_actions_admin_id',
  })
  admin?: AdminUser;

  /** An AdminActionType, e.g. verification.approve. */
  @Column({ type: 'varchar', length: 64 })
  action: string;

  /** An AuditTargetType, e.g. user. */
  @Column({ name: 'target_type', type: 'varchar', length: 32 })
  targetType: string;

  @Column({ name: 'target_id', type: 'uuid' })
  targetId: string;

  // Written as an object so TypeORM's schema diff matches Postgres's '{}'::jsonb (no false drift).
  @Column({ type: 'jsonb', default: {} })
  details: AuditDetails;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
