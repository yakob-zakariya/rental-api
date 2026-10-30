import { HealthIndicatorService } from '@nestjs/terminus';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { HealthIndicators } from './health.indicators.js';

const LEAKY_ERROR = 'connect ECONNREFUSED 10.0.3.4:6379';

const build = (db: () => Promise<unknown>, ping: () => Promise<unknown>) =>
  new HealthIndicators(
    new HealthIndicatorService(),
    { query: db } as unknown as DataSource,
    { ping } as unknown as Redis,
  );

const ok = () => Promise.resolve('PONG');
const fail = () => Promise.reject(new Error(LEAKY_ERROR));

describe('HealthIndicators', () => {
  it('reports both services up', async () => {
    const indicators = build(ok, ok);

    expect(await indicators.database()).toEqual({ database: { status: 'up' } });
    expect(await indicators.redisPing()).toEqual({ redis: { status: 'up' } });
  });

  it('reports the database down without exposing the error', async () => {
    const result = await build(fail, ok).database();

    expect(result).toEqual({ database: { status: 'down' } });
    expect(JSON.stringify(result)).not.toContain('10.0.3.4');
  });

  it('reports Redis down without exposing the error', async () => {
    const result = await build(ok, fail).redisPing();

    expect(result).toEqual({ redis: { status: 'down' } });
    expect(JSON.stringify(result)).not.toContain('10.0.3.4');
  });

  it('reports down when a check hangs past the timeout', async () => {
    const hang = () => new Promise(() => {});

    expect(await build(ok, hang).redisPing()).toEqual({
      redis: { status: 'down' },
    });
  });
});
