import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { assertSafeDetails, type AuditDetails } from './audit-details.js';
import type { AdminActionType, AuditTargetType } from './audit.enums.js';

export interface AuditEntry {
  adminId: string;
  action: AdminActionType;
  targetType: AuditTargetType;
  targetId: string;
  details?: AuditDetails;
}

/**
 * Writes admin_actions rows (spec S1). Takes the caller's transaction manager on purpose: the
 * audit row and the change it describes commit together, or neither does. Details are checked
 * first (assertSafeDetails): an ID number in a note is a 400 and rolls the change back.
 */
@Injectable()
export class AuditService {
  async record(manager: EntityManager, entry: AuditEntry): Promise<void> {
    const details = entry.details ?? {};
    assertSafeDetails(details);
    await manager.query(
      `INSERT INTO admin_actions (admin_id, action, target_type, target_id, details, created_at)
       VALUES ($1, $2, $3, $4, $5, clock_timestamp())`,
      [
        entry.adminId,
        entry.action,
        entry.targetType,
        entry.targetId,
        JSON.stringify(details),
      ],
    );
  }
}
