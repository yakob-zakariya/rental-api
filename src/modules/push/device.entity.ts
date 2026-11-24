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
} from 'typeorm';
import { User } from '../users/user.entity.js';

export enum DevicePlatform {
  Android = 'android',
  Ios = 'ios',
}

/**
 * A phone that receives push notifications (spec N2). Registered under a sign-in session and
 * deleted when that session ends, for any reason (decided 2026-11-24): logout, revoking all of the
 * user's sessions (token reuse, A5; a ban; later the lost-SIM move), so a stolen phone stops
 * receiving the lister's notices. A session that just expires is caught when sending (PushService).
 */
@Entity('devices')
@Unique('UQ_devices_installation_id', ['installationId'])
@Index('IDX_devices_user_id', ['userId'])
@Index('IDX_devices_session_id', ['sessionId'])
@Check('CHK_devices_installation_id', `"installation_id" ~ '\\S'`)
export class Device {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_devices_user_id',
  })
  user?: User;

  /** The sign-in session it was registered under (refresh_tokens.session_id; not a foreign key: a session spans several token rows). */
  @Column({ name: 'session_id', type: 'uuid' })
  sessionId: string;

  /**
   * The phone app's Firebase Installation ID (FID), which FCM sends to (T6.2: Firebase deprecated
   * registration tokens in favour of FIDs). Firebase documents no length; FIDs are short (about 22
   * characters), so 255 leaves room.
   */
  @Column({ name: 'installation_id', type: 'varchar', length: 255 })
  installationId: string;

  @Column({ type: 'enum', enum: DevicePlatform, enumName: 'device_platform' })
  platform: DevicePlatform;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /** Updated on every registration (the app registers on each start). */
  @Column({ name: 'last_seen_at', type: 'timestamptz', default: () => 'now()' })
  lastSeenAt: Date;
}
