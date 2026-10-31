import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { UserModerationController } from './user-moderation.controller.js';
import { UserModerationService } from './user-moderation.service.js';

/**
 * Staff moderation of app users (spec S5). Its own module because it needs the token service
 * (Auth), status recompute (Verification) and the admin guards/audit (Admin); putting it in
 * AdminModule would make Admin ↔ Verification import each other.
 */
@Module({
  imports: [AdminModule, AuthModule, VerificationModule],
  controllers: [UserModerationController],
  providers: [UserModerationService],
})
export class ModerationModule {}
