import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  AdminActionType,
  AuditTargetType,
} from '../admin/audit/audit.enums.js';
import { AuditService } from '../admin/audit/audit.service.js';
import { TokenService } from '../auth/token.service.js';
import { UserStatus } from '../users/user.enums.js';
import { DecisionService } from '../verification/decision/decision.service.js';
import type {
  AdminUserDetailDto,
  BanResultDto,
} from './user-moderation.dto.js';

const userNotFound = () => new NotFoundException({ code: 'USER_NOT_FOUND' });

/** Staff ban and unban (spec S5), and the user view staff check before acting. */
@Injectable()
export class UserModerationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tokens: TokenService,
    private readonly decisions: DecisionService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Ban (moderator+): status banned, every refresh token revoked, and the hashes of the user's
   * approved attempt copied into banned_identities (V5 then blocks that identity everywhere).
   * Only approved hashes: others might be someone else's number on a fake document.
   */
  async ban(
    adminId: string,
    userId: string,
    reason: string,
  ): Promise<BanResultDto> {
    return this.dataSource.transaction(async (manager) => {
      const status = await this.lockUser(manager, userId);
      if (status === UserStatus.Banned)
        throw new ConflictException({ code: 'ALREADY_BANNED' });

      await manager.query(`UPDATE users SET status = 'banned' WHERE id = $1`, [
        userId,
      ]);
      await this.tokens.revokeAllForUser(userId, manager);
      // An identifier already under an active ban (from another ban) is skipped.
      const inserted = await manager.query<{ id: string }[]>(
        `INSERT INTO banned_identities (user_id, kind, hash, reason, banned_by_admin_id)
         SELECT h.user_id, h.kind, h.hash, $2, $3
         FROM identity_hashes h JOIN identity_verifications a ON a.id = h.verification_id
         WHERE h.user_id = $1 AND a.outcome = 'approved' AND h.is_approved
         ON CONFLICT (hash) WHERE lifted_at IS NULL DO NOTHING
         RETURNING id`,
        [userId, reason, adminId],
      );
      await this.audit.record(manager, {
        adminId,
        action: AdminActionType.UserBan,
        targetType: AuditTargetType.User,
        targetId: userId,
        details: { reason },
      });
      return {
        userId,
        status: UserStatus.Banned,
        identitiesBanned: inserted.length,
      };
    });
  }

  /**
   * Unban (super_admin only): status active, this user's active bans lifted (other users' bans of
   * the same identifier stay), verification status recomputed. Attempts blocked during the ban
   * stay blocked; staff approve them via the review queue if appropriate. Tokens stay revoked.
   */
  async unban(
    adminId: string,
    userId: string,
    note: string,
  ): Promise<AdminUserDetailDto> {
    await this.dataSource.transaction(async (manager) => {
      const status = await this.lockUser(manager, userId);
      if (status !== UserStatus.Banned)
        throw new ConflictException({ code: 'NOT_BANNED' });

      await manager.query(`UPDATE users SET status = 'active' WHERE id = $1`, [
        userId,
      ]);
      await manager.query(
        `UPDATE banned_identities SET lifted_at = clock_timestamp(), lifted_by_admin_id = $2
         WHERE user_id = $1 AND lifted_at IS NULL`,
        [userId, adminId],
      );
      await this.decisions.syncUser(manager, userId);
      await this.audit.record(manager, {
        adminId,
        action: AdminActionType.UserUnban,
        targetType: AuditTargetType.User,
        targetId: userId,
        details: { note },
      });
    });
    return this.detail(userId);
  }

  /** GET /admin/users/:userId (any staff role). Identity kinds only, never hashes or numbers. */
  async detail(userId: string): Promise<AdminUserDetailDto> {
    const [user] = await this.dataSource.query<
      {
        id: string;
        phone: string;
        status: string;
        verification_status: string;
        verified_at: Date | null;
        full_name: string | null;
        date_of_birth: string | null;
        created_at: Date;
      }[]
    >(
      `SELECT id, phone, status, verification_status, verified_at, full_name,
              date_of_birth::text, created_at
       FROM users WHERE id = $1`,
      [userId],
    );
    if (!user) throw userNotFound();

    const identities = await this.dataSource.query<
      { kind: string; is_approved: boolean }[]
    >(
      `SELECT DISTINCT kind, is_approved FROM identity_hashes WHERE user_id = $1 ORDER BY kind, is_approved`,
      [userId],
    );
    const bans = await this.dataSource.query<
      { kind: string; reason: string; created_at: Date }[]
    >(
      `SELECT kind, reason, created_at FROM banned_identities
       WHERE user_id = $1 AND lifted_at IS NULL ORDER BY created_at`,
      [userId],
    );
    const attempts = await this.dataSource.query<
      {
        id: string;
        outcome: string;
        provider_status: string;
        decline_reason: string | null;
        flag_reason: string | null;
        decided: boolean;
        created_at: Date;
        completed_at: Date | null;
      }[]
    >(
      `SELECT id, outcome, provider_status, decline_reason, flag_reason,
              decided_by_admin_id IS NOT NULL AS decided, created_at, completed_at
       FROM identity_verifications WHERE user_id = $1 ORDER BY created_at DESC, id DESC`,
      [userId],
    );

    return {
      id: user.id,
      phone: user.phone,
      status: user.status,
      verificationStatus: user.verification_status,
      verifiedAt: user.verified_at?.toISOString() ?? null,
      fullName: user.full_name,
      dateOfBirth: user.date_of_birth,
      createdAt: user.created_at.toISOString(),
      identities: identities.map((i) => ({
        kind: i.kind,
        isApproved: i.is_approved,
      })),
      activeBans: bans.map((b) => ({
        kind: b.kind,
        reason: b.reason,
        bannedAt: b.created_at.toISOString(),
      })),
      attempts: attempts.map((a) => ({
        attemptId: a.id,
        outcome: a.outcome,
        providerStatus: a.provider_status,
        declineReason: a.decline_reason,
        flagReason: a.flag_reason,
        decided: a.decided,
        createdAt: a.created_at.toISOString(),
        completedAt: a.completed_at?.toISOString() ?? null,
      })),
    };
  }

  private async lockUser(
    manager: EntityManager,
    userId: string,
  ): Promise<UserStatus> {
    const [user] = await manager.query<{ status: UserStatus }[]>(
      `SELECT status FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (!user) throw userNotFound();
    return user.status;
  }
}
