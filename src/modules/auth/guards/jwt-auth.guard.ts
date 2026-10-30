import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthRequest } from '../../../common/auth-request.js';
import { IS_PUBLIC } from '../../../common/decorators/public.decorator.js';
import { TokenService } from '../token.service.js';

/**
 * Global: every app route needs a valid app-user access token unless marked @Public().
 * 401 ACCESS_TOKEN_EXPIRED tells the app to refresh; any other failure is UNAUTHENTICATED.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (isPublic(this.reflector, context)) return true;

    const request = context.switchToHttp().getRequest<AuthRequest>();
    const [scheme, token, ...rest] = (
      request.headers.authorization ?? ''
    ).split(' ');
    if (scheme !== 'Bearer' || !token || rest.length > 0)
      throw unauthenticated();

    const result = await this.tokens.verifyAccessToken(token);
    if (result === 'expired') {
      throw new UnauthorizedException({ code: 'ACCESS_TOKEN_EXPIRED' });
    }
    if (!result) throw unauthenticated();

    request.authUserId = result.userId;
    return true;
  }
}

export function isPublic(
  reflector: Reflector,
  context: ExecutionContext,
): boolean {
  return (
    reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]) === true
  );
}

const unauthenticated = () =>
  new UnauthorizedException({ code: 'UNAUTHENTICATED' });
