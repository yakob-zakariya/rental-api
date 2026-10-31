import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from '../../../common/decorators/public.decorator.js';
import { type AdminRole, hasRole, requiredRole } from '../admin.enums.js';
import type { AdminRequest } from '../admin-request.js';
import { MIN_ROLE } from '../roles.decorator.js';

/** After AdminAuthGuard: the admin's role must meet the route's minimum (fail closed). */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets)
    )
      return true;

    const request = context.switchToHttp().getRequest<AdminRequest>();
    const admin = request.currentAdmin;
    if (!admin)
      throw new InternalServerErrorException(
        'RolesGuard ran without AdminAuthGuard',
      );

    const declared = this.reflector.getAllAndOverride<AdminRole | undefined>(
      MIN_ROLE,
      targets,
    );
    if (!hasRole(admin.role, requiredRole(request.method, declared))) {
      throw new ForbiddenException({ code: 'INSUFFICIENT_ROLE' });
    }
    return true;
  }
}
