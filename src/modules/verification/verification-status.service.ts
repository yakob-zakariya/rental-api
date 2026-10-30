import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { VerificationStatus } from '../users/user.enums.js';
import { VerificationOutcome } from './verification.enums.js';
import { deriveVerificationStatus } from './verification-status.js';

@Injectable()
export class VerificationStatusService {
  /**
   * The ONLY code that writes users.verification_status. Call it after every change to a user's
   * attempts, inside the same transaction (pass that transaction's manager).
   */
  async recomputeVerificationStatus(
    userId: string,
    manager: EntityManager,
  ): Promise<VerificationStatus> {
    const rows = await manager.query<{ outcome: VerificationOutcome }[]>(
      `SELECT outcome FROM identity_verifications
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC`,
      [userId],
    );
    const status = deriveVerificationStatus(rows.map((row) => row.outcome));

    await manager.query(
      `UPDATE users SET verification_status = $2 WHERE id = $1`,
      [userId, status],
    );
    return status;
  }
}
