import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import { PublicPhotoReconciliation } from './public-photo-reconciliation.service.js';

/** Every hour (T4.4). Does nothing when JOBS_ENABLED=false (tests). */
@Injectable()
export class PublicPhotoReconciliationJob {
  private readonly logger = new Logger('PublicPhotoReconciliation');
  private readonly enabled: boolean;

  constructor(
    private readonly reconciliation: PublicPhotoReconciliation,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.enabled = config.get('JOBS_ENABLED', { infer: true });
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'public-photo-reconciliation' })
  async tick(): Promise<void> {
    if (!this.enabled) return;
    try {
      const s = await this.reconciliation.runOnce();
      if (!s.skipped && s.removed + s.errors > 0)
        this.logger.log(
          `Pass: ${s.checked} checked, ${s.kept} kept, ${s.removed} removed, ${s.recent} too recent, ${s.errors} errors`,
        );
    } catch (error) {
      // Never let a failed pass become an unhandled rejection; the next hour tries again.
      this.logger.error(
        `Reconciliation pass failed: ${(error as Error).message}`,
      );
    }
  }
}
