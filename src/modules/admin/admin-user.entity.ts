import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { AdminRole } from './admin.enums.js';

/** A staff account. Completely separate from app users (hard rule 8). */
@Entity('admin_users')
@Unique('UQ_admin_users_email', ['email'])
// Emails are stored lowercase, so uniqueness and login are case-insensitive.
@Check('CHK_admin_users_email_lowercase', `"email" = lower("email")`)
export class AdminUser {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 254 })
  email: string;

  /** argon2id (PHC string). Never returned by any endpoint. */
  @Column({ name: 'password_hash', type: 'varchar', length: 255 })
  passwordHash: string;

  @Column({ type: 'enum', enum: AdminRole, enumName: 'admin_role' })
  role: AdminRole;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
