import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { UserLanguage, UserStatus, VerificationStatus } from './user.enums.js';

@Entity('users')
@Unique('UQ_users_phone', ['phone'])
// Any E.164 number (hard rule 7). Which countries/number types may sign up is app policy
// (phone normalisation, OTP request), so it can change without a migration.
@Check('CHK_users_phone_e164', `"phone" ~ '^\\+[1-9][0-9]{7,14}$'`)
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 16 })
  phone: string;

  // full_name and date_of_birth come from verification and are locked once verified (hard rule 9).
  @Column({ name: 'full_name', type: 'varchar', nullable: true })
  fullName: string | null;

  // 'YYYY-MM-DD'. Kept as a string so it never shifts by a day through time zone conversion.
  @Column({ name: 'date_of_birth', type: 'date', nullable: true })
  dateOfBirth: string | null;

  @Column({
    name: 'preferred_language',
    type: 'enum',
    enum: UserLanguage,
    enumName: 'user_language',
    default: UserLanguage.Amharic,
  })
  preferredLanguage: UserLanguage;

  @Column({
    type: 'enum',
    enum: UserStatus,
    enumName: 'user_status',
    default: UserStatus.Active,
  })
  status: UserStatus;

  // Derived: only recomputeVerificationStatus(userId) writes this.
  @Column({
    name: 'verification_status',
    type: 'enum',
    enum: VerificationStatus,
    enumName: 'verification_status',
    default: VerificationStatus.NotVerified,
  })
  verificationStatus: VerificationStatus;

  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true })
  verifiedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
