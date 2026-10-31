import { applyDecorators, Controller, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AdminRoute } from '../../common/decorators/admin-route.decorator.js';
import { AdminAuthGuard } from './guards/admin-auth.guard.js';
import { RolesGuard } from './guards/roles.guard.js';

/**
 * Every staff controller uses this: `/admin/<path>`, skipped by the app guards, protected by the
 * admin guards (token + active admin, then role). An admin route can't end up unguarded.
 */
export function AdminController(path: string) {
  return applyDecorators(
    Controller(`admin/${path}`),
    AdminRoute(),
    UseGuards(AdminAuthGuard, RolesGuard),
    ApiTags('admin'),
    ApiBearerAuth('admin'),
  );
}
