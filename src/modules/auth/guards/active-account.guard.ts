import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AuthRequest } from '../../../common/auth-request.js';
import { User } from '../../users/user.entity.js';
import { UserStatus } from '../../users/user.enums.js';
import { accountUnavailable } from '../token.service.js';
import { isPublic } from './jwt-auth.guard.js';

/**
 * Global, after JwtAuthGuard: loads the user on every request, so a suspension or ban applies
 * at once even while their access token is valid. Neutral 403 ACCOUNT_UNAVAILABLE (as rule A6).
 */
@Injectable()
export class ActiveAccountGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (isPublic(this.reflector, context)) return true;

    const request = context.switchToHttp().getRequest<AuthRequest>();
    // JwtAuthGuard runs first; without it there is no signed-in user to check.
    if (!request.authUserId)
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED' });

    const user = await this.users.findOneBy({ id: request.authUserId });
    if (!user || user.status !== UserStatus.Active) throw accountUnavailable();

    request.currentUser = user;
    return true;
  }
}
