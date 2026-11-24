import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { UserLanguage } from '../users/user.enums.js';
import { type PushNotice, pushMessage } from './push-messages.js';
import { PushSender } from './push-sender.js';

/** How a notice went, as availability_checks.push_result records it (spec section 2, F). */
export type NotifyResult = 'sent' | 'no_device' | 'failed';

/**
 * Sends a notice to every device of a user (spec N1–N4), in their language. Only devices whose
 * sign-in session is still live get it: a session that ended (logout, revocation) has already
 * lost its devices; one that simply expired is found here, and its devices are deleted.
 * Tokens FCM reports as invalid are deleted too (N2).
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly sender: PushSender,
  ) {}

  async notify(userId: string, notice: PushNotice): Promise<NotifyResult> {
    const [user] = await this.dataSource.query<
      { preferred_language: UserLanguage }[]
    >(`SELECT preferred_language FROM users WHERE id = $1`, [userId]);
    if (!user) return 'no_device';

    const devices = await this.dataSource.query<
      { id: string; fcm_token: string; live: boolean }[]
    >(
      `SELECT d.id, d.fcm_token,
         EXISTS (SELECT 1 FROM refresh_tokens r
                 WHERE r.session_id = d.session_id AND r.revoked_at IS NULL
                   AND r.expires_at > clock_timestamp()) AS live
       FROM devices d WHERE d.user_id = $1`,
      [userId],
    );
    const dead = devices.filter((d) => !d.live).map((d) => d.id);
    if (dead.length > 0) await this.delete(dead);
    const live = devices.filter((d) => d.live);
    if (live.length === 0) return 'no_device';

    const message = pushMessage(notice, user.preferred_language);
    let sent = 0;
    const invalid: string[] = [];
    for (const device of live) {
      const outcome = await this.sender
        .send(device.fcm_token, message)
        .catch((error: Error): 'failed' => {
          this.logger.warn(`Push failed: ${error.message}`);
          return 'failed';
        });
      if (outcome === 'sent') sent++;
      if (outcome === 'invalid_token') invalid.push(device.id);
    }
    if (invalid.length > 0) await this.delete(invalid);
    if (sent > 0) return 'sent';
    return invalid.length === live.length ? 'no_device' : 'failed';
  }

  private async delete(ids: string[]): Promise<void> {
    await this.dataSource.query(`DELETE FROM devices WHERE id = ANY ($1)`, [
      ids,
    ]);
  }
}
