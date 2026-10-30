import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../../../config/env.validation.js';
import { DiditClient } from './didit-client.js';
import { HttpDiditClient } from './http-didit-client.js';

@Module({
  providers: [
    {
      provide: DiditClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) =>
        new HttpDiditClient({
          baseUrl: config.get('DIDIT_BASE_URL', { infer: true }),
          apiKey: config.get('DIDIT_API_KEY', { infer: true }),
          workflowId: config.get('DIDIT_WORKFLOW_ID', { infer: true }),
          callbackUrl: config.get('APP_VERIFICATION_CALLBACK_URL', {
            infer: true,
          }),
        }),
    },
  ],
  exports: [DiditClient],
})
export class DiditModule {}
