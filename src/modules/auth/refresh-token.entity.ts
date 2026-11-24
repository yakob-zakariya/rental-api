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
// Push devices end with their session (T6.1); finding a session's live token must be quick.
@Index('IDX_refresh_tokens_session_id', ['sessionId'])
export class RefreshToken {
  // Set by TokenService before signing: it is the refresh JWT's `jti`.
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /**
   * The sign-in session this token belongs to (T6.1): the id of the session's first token, copied
   * to every token rotated from it, so a session keeps one identity through rotation. Access
   * tokens carry it as `sid`; push devices are registered under it and end with it.
   */
  @Column({ name: 'session_id', type: 'uuid' })
  sessionId: string;

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
