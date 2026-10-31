import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IS_PUBLIC } from '../../../common/decorators/public.decorator.js';
import { AdminAuthService } from '../admin-auth.service.js';
import type { AdminRequest } from '../admin-request.js';
import { AdminUser } from '../admin-user.entity.js';

/**
 * On every admin route (via @AdminController): a staff access token, and an admin that is still
 * active — loaded on every request, so deactivation or a role change applies at once.
 * App-user tokens never pass (different secret and audience).
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AdminAuthService,
    @InjectRepository(AdminUser) private readonly admins: Repository<AdminUser>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AdminRequest>();
    const [scheme, token, ...rest] = (
      request.headers.authorization ?? ''
    ).split(' ');
    if (scheme !== 'Bearer' || !token || rest.length > 0)
      throw unauthenticated();

    const result = await this.auth.verifyAccessToken(token);
    if (result === 'expired') {
      throw new UnauthorizedException({ code: 'ACCESS_TOKEN_EXPIRED' });
    }
    if (!result) throw unauthenticated();

    const admin = await this.admins.findOneBy({ id: result.adminId });
    if (!admin?.isActive) throw unauthenticated();
    request.currentAdmin = admin;
    return true;
  }
}

const unauthenticated = () =>
  new UnauthorizedException({ code: 'UNAUTHENTICATED' });
