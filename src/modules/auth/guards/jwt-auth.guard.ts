import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthRequest } from '../../../common/auth-request.js';
import { isAdminRoute } from '../../../common/decorators/admin-route.decorator.js';
import { IS_PUBLIC } from '../../../common/decorators/public.decorator.js';
import { TokenService } from '../token.service.js';

/**
 * Global: every app route needs a valid app-user access token unless marked @Public().
 * 401 ACCESS_TOKEN_EXPIRED tells the app to refresh; any other failure is UNAUTHENTICATED.
 *
 * On a @Public() route the sign-in is optional (T5.2): a valid app token sets `authUserId`, so the
 * route can tell who is looking (a lister previewing their own listing; Phase 3's contact
 * request state). A missing, invalid or expired token just leaves the request anonymous: a public
 * route never answers 401. The account's status isn't checked there (ActiveAccountGuard skips
 * public routes), so a route that relies on the viewer checks what it needs itself.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Staff routes use the admin guards instead (S3).
    if (isAdminRoute(this.reflector, context)) return true;

    const request = context.switchToHttp().getRequest<AuthRequest>();
    if (isPublic(this.reflector, context)) {
      await this.identifyIfSignedIn(request);
      return true;
    }

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
    request.authSessionId = result.sessionId ?? undefined;
    return true;
  }

  /** Optional sign-in on a public route: sets authUserId for a valid token, never throws. */
  private async identifyIfSignedIn(request: AuthRequest): Promise<void> {
    const [scheme, token, ...rest] = (
      request.headers.authorization ?? ''
    ).split(' ');
    if (scheme !== 'Bearer' || !token || rest.length > 0) return;
    const result = await this.tokens.verifyAccessToken(token);
    if (result && result !== 'expired') {
      request.authUserId = result.userId;
      request.authSessionId = result.sessionId ?? undefined;
    }
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
