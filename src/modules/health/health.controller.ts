import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator.js';
import { HealthIndicators } from './health.indicators.js';

@ApiTags('health')
// Monitors poll this; it must not eat into (or be blocked by) the per-IP rate limit.
@SkipThrottle()
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicators,
  ) {}

  /** 200 when the database and Redis both answer; 503 otherwise. */
  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.indicators.database(),
      () => this.indicators.redisPing(),
    ]);
  }
}
