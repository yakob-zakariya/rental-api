import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BannedIdentity } from './entities/banned-identity.entity.js';
import { IdentityHash } from './entities/identity-hash.entity.js';
import { IdentityVerification } from './entities/identity-verification.entity.js';
import { VerificationWebhookEvent } from './entities/verification-webhook-event.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      IdentityVerification,
      IdentityHash,
      VerificationWebhookEvent,
      BannedIdentity,
    ]),
  ],
  exports: [TypeOrmModule],
})
export class VerificationModule {}
