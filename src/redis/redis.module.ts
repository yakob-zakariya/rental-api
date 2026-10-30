import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { EnvironmentVariables } from '../config/env.validation.js';

/** Injection token for the shared ioredis client: `@Inject(REDIS) redis: Redis`. */
export const REDIS = Symbol('REDIS');

export function createRedisClient(
  url: string,
  logger = new Logger('Redis'),
): Redis {
  const client = new Redis(url);
  // ioredis keeps reconnecting on its own. Log state changes rather than every retry, and always
  // handle 'error' — an unhandled one is printed as a crash-looking stack on each attempt.
  let healthy = true;
  client.on('error', (error: Error) => {
    if (!healthy) return;
    healthy = false;
    logger.warn(`Connection lost: ${error.message}`);
  });
  client.on('ready', () => {
    if (healthy) return;
    healthy = true;
    logger.log('Connection restored');
  });
  return client;
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) =>
        createRedisClient(config.get('REDIS_URL', { infer: true })),
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown() {
    // quit() waits for pending replies; it can fail if the connection is already down.
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
