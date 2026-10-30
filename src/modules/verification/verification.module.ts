import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiditModule } from './didit/didit.module.js';
import { BannedIdentity } from './entities/banned-identity.entity.js';
import { IdentityHash } from './entities/identity-hash.entity.js';
import { IdentityVerification } from './entities/identity-verification.entity.js';
import { VerificationWebhookEvent } from './entities/verification-webhook-event.entity.js';
import { IdentityHasher } from './identity-hasher.js';
import { VerificationController } from './verification.controller.js';
import { VerificationService } from './verification.service.js';
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
  controllers: [VerificationController],
  providers: [IdentityHasher, VerificationStatusService, VerificationService],
  exports: [TypeOrmModule, IdentityHasher, VerificationStatusService],
})
export class VerificationModule {}
