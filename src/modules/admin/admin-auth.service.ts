import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { durationToSeconds } from '../../common/duration.js';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import { AdminLoginLimiter, hashEmail } from './admin-login-limiter.js';
import { AdminActionType, AuditTargetType } from './audit/audit.enums.js';
import { AuditService } from './audit/audit.service.js';
import { AdminUser } from './admin-user.entity.js';
import { dummyPasswordHash, verifyPassword } from './password.js';

const JWT_ISSUER = 'rental-api';
/** Staff tokens: their own secret and audience, so they never pass the app guards (hard rule 8). */
export const ADMIN_AUDIENCE = 'admin';
const ADMIN_TOKEN_TYPE = 'admin_access';

export interface AdminLoginResult {
  accessToken: string;
  /** Seconds until the token expires (ADMIN_JWT_TTL). Staff sign in again after that. */
  accessTokenExpiresIn: number;
}

/** The same response for every failure, so it reveals nothing about which accounts exist. */
const invalidCredentials = () =>
  new UnauthorizedException({ code: 'INVALID_CREDENTIALS' });

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger('AdminAuth');
  private readonly secret: string;
  private readonly ttlSeconds: number;

  constructor(
    @InjectRepository(AdminUser) private readonly admins: Repository<AdminUser>,
    private readonly jwt: JwtService,
    private readonly limiter: AdminLoginLimiter,
    private readonly audit: AuditService,
    private readonly dataSource: DataSource,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.secret = config.get('ADMIN_JWT_SECRET', { infer: true });
    this.ttlSeconds = durationToSeconds(
      config.get('ADMIN_JWT_TTL', { infer: true }),
    );
  }

  /** POST /admin/auth/login. Every failure is 401 INVALID_CREDENTIALS. */
  async login(email: string, password: string): Promise<AdminLoginResult> {
    const admin = await this.checkCredentials(email, password);
    if (!admin) throw invalidCredentials();

    // last_login_at and the admin.login audit row commit together (S1).
    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        AdminUser,
        { id: admin.id },
        { lastLoginAt: new Date() },
      );
      await this.audit.record(manager, {
        adminId: admin.id,
        action: AdminActionType.AdminLogin,
        targetType: AuditTargetType.AdminUser,
        targetId: admin.id,
      });
    });
    const accessToken = await this.jwt.signAsync(
      { sub: admin.id, typ: ADMIN_TOKEN_TYPE },
      {
        secret: this.secret,
        expiresIn: this.ttlSeconds,
        algorithm: 'HS256',
        issuer: JWT_ISSUER,
        audience: ADMIN_AUDIENCE,
      },
    );
    return { accessToken, accessTokenExpiresIn: this.ttlSeconds };
  }

  /**
   * The active admin for these credentials, or null. Shared by login and the production /docs
   * HTTP Basic check, so both get the per-email limit and the timing protection.
   */
  async checkCredentials(
    rawEmail: string,
    password: string,
  ): Promise<AdminUser | null> {
    const email = normaliseEmail(rawEmail);
    // Limited: refuse without checking the password, so a guess can't be confirmed meanwhile.
    if (await this.limiter.isLimited(email)) {
      this.logFailure(email, 'too many failed attempts');
      return null;
    }

    const admin = await this.admins.findOneBy({ email });
    const valid = await verifyPassword(
      admin?.passwordHash ?? (await dummyPasswordHash()),
      password,
    );
    if (!admin || !valid || !admin.isActive) {
      await this.limiter.recordFailure(email);
      this.logFailure(email, 'invalid credentials');
      return null;
    }
    await this.limiter.reset(email);
    return admin;
  }

  /** Failed staff logins are logged with the hashed email only — never the address or password. */
  private logFailure(email: string, reason: string): void {
    this.logger.warn(
      `Failed staff login (email sha256 ${hashEmail(email).slice(0, 16)}): ${reason}`,
    );
  }
  /** For AdminAuthGuard: only staff access tokens signed with ADMIN_JWT_SECRET pass. */
  async verifyAccessToken(
    token: string,
  ): Promise<{ adminId: string } | 'expired' | null> {
    try {
      const claims = await this.jwt.verifyAsync<{
        sub?: unknown;
        typ?: unknown;
      }>(token, {
        secret: this.secret,
        algorithms: ['HS256'],
        issuer: JWT_ISSUER,
        audience: ADMIN_AUDIENCE,
      });
      if (claims.typ !== ADMIN_TOKEN_TYPE || typeof claims.sub !== 'string')
        return null;
      return { adminId: claims.sub };
    } catch (error) {
      return (error as Error).name === 'TokenExpiredError' ? 'expired' : null;
    }
  }
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
