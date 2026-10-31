import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import { VerificationPollingService } from './verification-polling.service.js';

/** Every 5 minutes (spec flow step 5). Does nothing when JOBS_ENABLED=false (tests). */
@Injectable()
export class VerificationPollingJob {
  private readonly logger = new Logger('VerificationPolling');
  private readonly enabled: boolean;

  constructor(
    private readonly polling: VerificationPollingService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.enabled = config.get('JOBS_ENABLED', { infer: true });
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'verification-polling' })
  async tick(): Promise<void> {
    if (!this.enabled) return;
    try {
      const s = await this.polling.runOnce();
      if (!s.skipped && s.polled + s.expired + s.notFound + s.errors > 0) {
        this.logger.log(
          `Pass: ${s.polled} polled, ${s.expired} expired, ${s.notFound} not found, ${s.errors} errors`,
        );
      }
    } catch (error) {
      // Never let a failed pass become an unhandled rejection; the next tick tries again.
      this.logger.error(`Polling pass failed: ${(error as Error).message}`);
    }
  }
}
