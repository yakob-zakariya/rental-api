import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminAuthController } from './admin-auth.controller.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminLoginLimiter } from './admin-login-limiter.js';
import { AdminUser } from './admin-user.entity.js';
import { AdminAction } from './audit/admin-action.entity.js';
import { AdminActionsController } from './audit/admin-actions.controller.js';
import { AdminActionsService } from './audit/admin-actions.service.js';
import { AuditService } from './audit/audit.service.js';
import { AdminAuthGuard } from './guards/admin-auth.guard.js';
import { RolesGuard } from './guards/roles.guard.js';

@Module({
  // No module-wide secret: AdminAuthService passes ADMIN_JWT_SECRET on every call.
  imports: [
    TypeOrmModule.forFeature([AdminUser, AdminAction]),
    JwtModule.register({}),
  ],
  controllers: [AdminAuthController, AdminActionsController],
  providers: [
    AdminAuthService,
    AdminLoginLimiter,
    AdminAuthGuard,
    RolesGuard,
    AuditService,
    AdminActionsService,
  ],
  // Guards and the auth service, for admin controllers in other modules (T3.2–T3.4).
  exports: [
    TypeOrmModule,
    AdminAuthService,
    AdminAuthGuard,
    RolesGuard,
    AuditService,
  ],
})
export class AdminModule {}
