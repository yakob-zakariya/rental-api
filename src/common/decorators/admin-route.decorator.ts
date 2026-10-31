import { ExecutionContext, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const IS_ADMIN_ROUTE = Symbol('isAdminRoute');

/**
 * Marks a staff (admin) controller. The global app guards (JwtAuthGuard, ActiveAccountGuard)
 * skip it, and the admin guards take over (spec S3, hard rule 8). Applied by @AdminController.
 */
export const AdminRoute = () => SetMetadata(IS_ADMIN_ROUTE, true);

export function isAdminRoute(
  reflector: Reflector,
  context: ExecutionContext,
): boolean {
  return (
    reflector.getAllAndOverride<boolean | undefined>(IS_ADMIN_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]) === true
  );
}
