import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller.js';
import { HealthIndicators } from './health.indicators.js';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [HealthIndicators],
})
export class HealthModule {}
