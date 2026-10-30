import { Inject, Injectable, Logger } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS } from '../../redis/redis.module.js';

const TIMEOUT_MS = 1000;

/**
 * Database and Redis checks for GET /health. The endpoint is public, so a failing check reports
 * only `down`; the underlying error (which may name internal hosts) goes to the server log.
 */
@Injectable()
export class HealthIndicators {
  private readonly logger = new Logger('Health');

  constructor(
    private readonly health: HealthIndicatorService,
    private readonly dataSource: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  database() {
    return this.probe('database', () => this.dataSource.query('SELECT 1'));
  }

  redisPing() {
    return this.probe('redis', () => this.redis.ping());
  }

  private async probe<const Key extends string>(
    key: Key,
    fn: () => Promise<unknown>,
  ) {
    const result = await this.health
      .check(key)
      .attempt(async () => {
        await fn();
      })
      .withTimeout(TIMEOUT_MS);

    if (result[key].status === 'up') return this.health.check(key).up();

    this.logger.warn(`${key} check failed: ${String(result[key].message)}`);
    return this.health.check(key).down();
  }
}
