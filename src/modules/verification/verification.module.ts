import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DecisionProcessor } from './decision/decision.processor.js';
import { DecisionService } from './decision/decision.service.js';
import { DiditEventProcessor } from './didit/didit-event-processor.js';
import { DiditModule } from './didit/didit.module.js';
import { BannedIdentity } from './entities/banned-identity.entity.js';
import { IdentityHash } from './entities/identity-hash.entity.js';
import { IdentityVerification } from './entities/identity-verification.entity.js';
import { VerificationWebhookEvent } from './entities/verification-webhook-event.entity.js';
import { IdentityHasher } from './identity-hasher.js';
import { VerificationController } from './verification.controller.js';
import { VerificationPollingJob } from './verification-polling.job.js';
import { VerificationPollingService } from './verification-polling.service.js';
import { VerificationService } from './verification.service.js';
import { WebhookController } from './webhook.controller.js';
import { WebhookService } from './webhook.service.js';
import { VerificationStatusService } from './verification-status.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      IdentityVerification,
      IdentityHash,
      VerificationWebhookEvent,
      BannedIdentity,
    ]),
    DiditModule,
  ],
  controllers: [VerificationController, WebhookController],
  providers: [
    IdentityHasher,
    VerificationStatusService,
    VerificationService,
    WebhookService,
    DecisionService,
    VerificationPollingService,
    VerificationPollingJob,
    { provide: DiditEventProcessor, useClass: DecisionProcessor },
  ],
  exports: [
    TypeOrmModule,
    IdentityHasher,
    VerificationStatusService,
    DecisionService,
  ],
})
export class VerificationModule {}
