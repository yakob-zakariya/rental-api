import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../users/user.entity.js';

@Entity('refresh_tokens')
// Rule A5 and bans revoke every token of a user.
@Index('IDX_refresh_tokens_user_id', ['userId'])
export class RefreshToken {
  // Set by TokenService before signing: it is the refresh JWT's `jti`.
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_refresh_tokens_user_id',
  })
  user?: User;

  // SHA-256 of the refresh JWT, hex. The token itself is never stored.
  @Column({ name: 'token_hash', type: 'varchar', length: 64 })
  tokenHash: string;

  @Column({ name: 'device_name', type: 'varchar', length: 100, nullable: true })
  deviceName: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  // The token issued in place of this one (rotation, or a lost-response retry).
  @Column({ name: 'replaced_by_id', type: 'uuid', nullable: true })
  replacedById: string | null;

  @ManyToOne(() => RefreshToken, { onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'replaced_by_id',
    foreignKeyConstraintName: 'FK_refresh_tokens_replaced_by_id',
  })
  replacedBy?: RefreshToken;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
