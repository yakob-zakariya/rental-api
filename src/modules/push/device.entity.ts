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
@Unique('UQ_devices_fcm_token', ['fcmToken'])
@Index('IDX_devices_user_id', ['userId'])
@Index('IDX_devices_session_id', ['sessionId'])
@Check('CHK_devices_fcm_token', `"fcm_token" ~ '\\S'`)
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

  /** Firebase's registration token. Google sets no length; usually about 160 characters. */
  @Column({ name: 'fcm_token', type: 'varchar', length: 4096 })
  fcmToken: string;

  @Column({ type: 'enum', enum: DevicePlatform, enumName: 'device_platform' })
  platform: DevicePlatform;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /** Updated on every registration (the app registers on each start). */
  @Column({ name: 'last_seen_at', type: 'timestamptz', default: () => 'now()' })
  lastSeenAt: Date;
}
