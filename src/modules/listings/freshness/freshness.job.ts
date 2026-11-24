import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { EnvironmentVariables } from '../../../config/env.validation.js';
import { FreshnessService } from './freshness.service.js';

/** Every 15 minutes (F6). Does nothing when JOBS_ENABLED=false (tests call runOnce directly). */
@Injectable()
export class FreshnessJob {
  private readonly logger = new Logger('Freshness');
  private readonly enabled: boolean;

  constructor(
    private readonly freshness: FreshnessService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.enabled = config.get('JOBS_ENABLED', { infer: true });
  }

  @Cron('0 */15 * * * *', { name: 'listing-freshness' })
  async tick(): Promise<void> {
    if (!this.enabled) return;
    try {
      const s = await this.freshness.runOnce();
      if (s.stale + s.expired + s.checks + s.staleNotices + s.errors > 0)
        this.logger.log(
          `Pass: ${s.checks} checks, ${s.stale} stale, ${s.staleNotices} stale notices, ${s.expired} expired, ${s.errors} errors${s.quiet ? ' (quiet hours)' : ''}`,
        );
    } catch (error) {
      // Never an unhandled rejection; the next pass tries again.
      this.logger.error(`Freshness pass failed: ${(error as Error).message}`);
    }
  }
}
