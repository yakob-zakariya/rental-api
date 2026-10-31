import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import { REDIS } from '../../redis/redis.module.js';

/** Failed logins allowed per email per window, across all IPs and restarts. */
export const MAX_FAILED_LOGINS_PER_EMAIL = 10;
export const FAILED_LOGIN_WINDOW_SECONDS = 15 * 60;

/**
 * Per-email limit on failed staff logins, counted in Redis (survives restarts and IP rotation).
 * Temporary only: the counter expires FAILED_LOGIN_WINDOW_SECONDS after the first failure, and a
 * successful login clears it. There is no permanent lockout.
 */
@Injectable()
export class AdminLoginLimiter {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async isLimited(email: string): Promise<boolean> {
    const count = Number(await this.redis.get(keyOf(email)));
    return count >= MAX_FAILED_LOGINS_PER_EMAIL;
  }

  async recordFailure(email: string): Promise<void> {
    const key = keyOf(email);
    const count = await this.redis.incr(key);
    // The window starts at the first failure (fixed window).
    if (count === 1) await this.redis.expire(key, FAILED_LOGIN_WINDOW_SECONDS);
  }

  async reset(email: string): Promise<void> {
    await this.redis.del(keyOf(email));
  }
}

/** SHA-256 of a (normalised) staff email: Redis keys and logs never hold the address itself. */
export function hashEmail(email: string): string {
  return createHash('sha256').update(email).digest('hex');
}

function keyOf(email: string): string {
  return `admin-login-failures:${hashEmail(email)}`;
}
