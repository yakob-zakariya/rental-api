import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { durationToSeconds } from '../../common/duration.js';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import { User } from '../users/user.entity.js';
import { UserStatus } from '../users/user.enums.js';

export const JWT_ISSUER = 'rental-api';
/** App-user tokens. Staff tokens use their own secret and audience (hard rule 8). */
export const APP_AUDIENCE = 'app';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  accessTokenExpiresIn: number;
}

interface RefreshClaims {
  sub: string;
  jti: string;
  typ: 'refresh';
}

interface RefreshRow {
  id: string;
  user_id: string;
  token_hash: string;
  device_name: string | null;
  replaced_by_id: string | null;
  revoked: boolean;
  expired: boolean;
  within_grace: boolean;
}

type RotateOutcome =
  | { kind: 'ok'; pair: TokenPair }
  | { kind: 'invalid' }
  | { kind: 'unavailable' };

const invalidRefreshToken = () =>
  new UnauthorizedException({ code: 'INVALID_REFRESH_TOKEN' });
/** Rule A6: neutral, the same for suspended and banned users. */
export const accountUnavailable = () =>
  new ForbiddenException({ code: 'ACCOUNT_UNAVAILABLE' });

/**
 * App-user access and refresh tokens (spec section 3, rules A5, A6). Both are HS256 JWTs; a
 * refresh token's `jti` is its refresh_tokens row, which stores only the token's SHA-256.
 */
@Injectable()
export class TokenService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;
  private readonly graceSeconds: number;

  constructor(
    private readonly dataSource: DataSource,
    private readonly jwt: JwtService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.accessSecret = config.get('JWT_ACCESS_SECRET', { infer: true });
    this.refreshSecret = config.get('JWT_REFRESH_SECRET', { infer: true });
    this.accessTtlSeconds = durationToSeconds(
      config.get('JWT_ACCESS_TTL', { infer: true }),
    );
    this.refreshTtlSeconds = durationToSeconds(
      config.get('JWT_REFRESH_TTL', { infer: true }),
    );
    this.graceSeconds = config.get('REFRESH_REUSE_GRACE_SECONDS', {
      infer: true,
    });
  }

  /** Issues a new pair after sign-in. The caller checks account status (rule A6) first. */
  issue(user: User, deviceName: string | null = null): Promise<TokenPair> {
    return this.dataSource.transaction((manager) =>
      this.createPair(manager, user.id, deviceName),
    );
  }

  /**
   * Rotates a refresh token: revokes it and returns a new pair. Reuse of a revoked token revokes
   * all the user's tokens (A5), except a retry after a lost response (see the A5 grace in the
   * spec). Errors: INVALID_REFRESH_TOKEN (401), ACCOUNT_UNAVAILABLE (403, rule A6).
   */
  async rotate(refreshToken: string): Promise<TokenPair> {
    const claims = await this.verifyRefreshJwt(refreshToken);
    if (!claims) throw invalidRefreshToken();

    // Decided inside the transaction and thrown after commit, so an A5 "revoke all" is kept.
    const outcome = await this.dataSource.transaction((manager) =>
      this.rotateLocked(manager, claims, refreshToken),
    );
    if (outcome.kind === 'invalid') throw invalidRefreshToken();
    if (outcome.kind === 'unavailable') throw accountUnavailable();
    return outcome.pair;
  }

  /** Logout. Always succeeds: an unknown, invalid or already-revoked token is a no-op. */
  async revoke(refreshToken: string): Promise<void> {
    const claims = await this.verifyRefreshJwt(refreshToken, {
      ignoreExpiration: true,
    });
    if (!claims) return;

    await this.dataSource.transaction(async (manager) => {
      const row = await this.lockRow(manager, claims.jti);
      if (
        !row ||
        row.revoked ||
        !this.hashMatches(refreshToken, row.token_hash)
      )
        return;
      await manager.query(
        `UPDATE refresh_tokens SET revoked_at = clock_timestamp() WHERE id = $1`,
        [row.id],
      );
    });
  }

  /** Rule A5, and bans (T3): revokes every live refresh token of a user. */
  async revokeAllForUser(
    userId: string,
    manager?: EntityManager,
  ): Promise<void> {
    await (manager ?? this.dataSource.manager).query(
      `UPDATE refresh_tokens SET revoked_at = clock_timestamp()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  }

  private async rotateLocked(
    manager: EntityManager,
    claims: RefreshClaims,
    refreshToken: string,
  ): Promise<RotateOutcome> {
    const row = await this.lockRow(manager, claims.jti);
    if (!row || row.user_id !== claims.sub) return { kind: 'invalid' };
    if (!this.hashMatches(refreshToken, row.token_hash) || row.expired) {
      return { kind: 'invalid' };
    }

    const [user] = await manager.query<{ status: UserStatus }[]>(
      `SELECT status FROM users WHERE id = $1`,
      [row.user_id],
    );
    if (!user) return { kind: 'invalid' };

    if (row.revoked) {
      const retried = await this.retryAfterLostResponse(
        manager,
        row,
        user.status,
      );
      if (retried) return retried;
      // Rule A5: a revoked token used again. Same response as any invalid token.
      await this.revokeAllForUser(row.user_id, manager);
      return { kind: 'invalid' };
    }

    if (user.status !== UserStatus.Active) return { kind: 'unavailable' };

    const pair = await this.createPair(
      manager,
      row.user_id,
      row.device_name,
      (newId) =>
        manager.query(
          `UPDATE refresh_tokens SET revoked_at = clock_timestamp(), replaced_by_id = $2
         WHERE id = $1`,
          [row.id, newId],
        ),
    );
    return { kind: 'ok', pair };
  }

  /**
   * The A5 grace: the client never received the pair from its last refresh and retried with the
   * old token. Allowed only within the window of the old token's first rotation, and only if
   * its replacement was never used (not rotated, not revoked). Returns null when not allowed.
   */
  private async retryAfterLostResponse(
    manager: EntityManager,
    row: RefreshRow,
    status: UserStatus,
  ): Promise<RotateOutcome | null> {
    if (!row.within_grace || !row.replaced_by_id) return null;

    const replacement = await this.lockRow(manager, row.replaced_by_id);
    if (!replacement || replacement.revoked || replacement.replaced_by_id)
      return null;

    if (status !== UserStatus.Active) return { kind: 'unavailable' };

    const pair = await this.createPair(
      manager,
      row.user_id,
      row.device_name,
      async (newId) => {
        await manager.query(
          `UPDATE refresh_tokens SET revoked_at = clock_timestamp(), replaced_by_id = $2
         WHERE id = $1`,
          [replacement.id, newId],
        );
        // revoked_at stays at the first rotation, so retries can't stretch the window.
        await manager.query(
          `UPDATE refresh_tokens SET replaced_by_id = $2 WHERE id = $1`,
          [row.id, newId],
        );
      },
    );
    return { kind: 'ok', pair };
  }

  private async createPair(
    manager: EntityManager,
    userId: string,
    deviceName: string | null,
    beforeReturn?: (newId: string) => Promise<unknown>,
  ): Promise<TokenPair> {
    const id = randomUUID();
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(
        { sub: userId, typ: 'access' },
        {
          secret: this.accessSecret,
          expiresIn: this.accessTtlSeconds,
          algorithm: 'HS256',
          issuer: JWT_ISSUER,
          audience: APP_AUDIENCE,
        },
      ),
      this.jwt.signAsync(
        { sub: userId, typ: 'refresh' },
        {
          secret: this.refreshSecret,
          expiresIn: this.refreshTtlSeconds,
          algorithm: 'HS256',
          issuer: JWT_ISSUER,
          audience: APP_AUDIENCE,
          jwtid: id,
        },
      ),
    ]);

    await manager.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, device_name, expires_at, created_at)
       VALUES ($1, $2, $3, $4, clock_timestamp() + make_interval(secs => $5), clock_timestamp())`,
      [id, userId, sha256(refreshToken), deviceName, this.refreshTtlSeconds],
    );
    await beforeReturn?.(id);

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresIn: this.accessTtlSeconds,
    };
  }

  private lockRow(
    manager: EntityManager,
    id: string,
  ): Promise<RefreshRow | undefined> {
    return manager
      .query<RefreshRow[]>(
        `SELECT id, user_id, token_hash, device_name, replaced_by_id,
                revoked_at IS NOT NULL AS revoked,
                expires_at <= clock_timestamp() AS expired,
                coalesce(revoked_at > clock_timestamp() - make_interval(secs => $2), false)
                  AS within_grace
         FROM refresh_tokens WHERE id = $1 FOR UPDATE`,
        [id, this.graceSeconds],
      )
      .then((rows) => rows[0]);
  }

  private async verifyRefreshJwt(
    token: string,
    { ignoreExpiration = false } = {},
  ): Promise<RefreshClaims | null> {
    if (typeof token !== 'string') return null;
    try {
      const claims = await this.jwt.verifyAsync<Partial<RefreshClaims>>(token, {
        secret: this.refreshSecret,
        algorithms: ['HS256'],
        issuer: JWT_ISSUER,
        audience: APP_AUDIENCE,
        ignoreExpiration,
      });
      const isUuid = (v: unknown) =>
        typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
      if (
        claims.typ !== 'refresh' ||
        !isUuid(claims.jti) ||
        !isUuid(claims.sub)
      ) {
        return null;
      }
      return claims as RefreshClaims;
    } catch {
      return null;
    }
  }

  private hashMatches(token: string, storedHash: string): boolean {
    if (!/^[0-9a-f]{64}$/.test(storedHash)) return false;
    return timingSafeEqual(
      Buffer.from(sha256(token), 'hex'),
      Buffer.from(storedHash, 'hex'),
    );
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
