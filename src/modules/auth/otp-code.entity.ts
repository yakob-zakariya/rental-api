import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('otp_codes')
// Serves "latest code for this phone" (verify) and "codes in the last 10 minutes" (rule A3).
@Index('IDX_otp_codes_phone_created_at', ['phone', 'createdAt'])
@Check('CHK_otp_codes_phone_e164', `"phone" ~ '^\\+[1-9][0-9]{7,14}$'`)
export class OtpCode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 16 })
  phone: string;

  // Rule A9: HMAC_SHA256(OTP_HASH_SECRET, phone + ":" + code), hex. The code itself is never stored.
  @Column({ name: 'code_hash', type: 'varchar', length: 64 })
  codeHash: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
