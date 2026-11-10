import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppThrottlerGuard } from './common/throttler.guard.js';
import { throttlerOptions } from './common/throttling.js';
import { createValidationPipe } from './common/validation.js';
import {
  type EnvironmentVariables,
  validateEnv,
} from './config/env.validation.js';
import { DatabaseModule } from './database/database.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { AreasModule } from './modules/areas/areas.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ActiveAccountGuard } from './modules/auth/guards/active-account.guard.js';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard.js';
import { HealthModule } from './modules/health/health.module.js';
import { ModerationModule } from './modules/moderation/moderation.module.js';
import { SmsModule } from './modules/sms/sms.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { VerificationModule } from './modules/verification/verification.module.js';
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
            {
              infer: true,
            },
          ),
          ADMIN_LOGIN_IP_LIMIT_PER_15_MIN: config.get(
            'ADMIN_LOGIN_IP_LIMIT_PER_15_MIN',
            {
              infer: true,
            },
          ),
        }),
    }),
    // Cron jobs; each job checks JOBS_ENABLED itself.
    ScheduleModule.forRoot(),
    DatabaseModule,
    RedisModule,
    HealthModule,
    UsersModule,
    SmsModule,
    AuthModule,
    VerificationModule,
    AdminModule,
    ModerationModule,
    AreasModule,
  ],
  providers: [
    { provide: APP_PIPE, useFactory: createValidationPipe },
    // Global guards run in this order: rate limit, then access token, then account status.
    // Routes opt out of the last two with @Public().
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ActiveAccountGuard },
  ],
})
export class AppModule {}
