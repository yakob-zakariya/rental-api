import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppThrottlerGuard } from './common/throttler.guard.js';
import { throttlerOptions } from './common/throttling.js';
import { createValidationPipe } from './common/validation.js';
import {
  type EnvironmentVariables,
  validateEnv,
} from './config/env.validation.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { SmsModule } from './modules/sms/sms.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { RedisModule } from './redis/redis.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      // Tests get a complete env from test/test-env.ts; never let a developer's .env fill gaps.
      ignoreEnvFile: process.env.NODE_ENV === 'test',
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) =>
        throttlerOptions({
          OTP_REQUEST_IP_LIMIT_PER_HOUR: config.get(
            'OTP_REQUEST_IP_LIMIT_PER_HOUR',
            { infer: true },
          ),
        }),
    }),
    DatabaseModule,
    RedisModule,
    HealthModule,
    UsersModule,
    SmsModule,
    AuthModule,
  ],
  providers: [
    { provide: APP_PIPE, useFactory: createValidationPipe },
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
  ],
})
export class AppModule {}
