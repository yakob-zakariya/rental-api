import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthRequest } from '../auth-request.js';

/**
 * On a @Public() route: the signed-in app user's id if the request carried a valid token,
 * otherwise undefined (anonymous). See JwtAuthGuard. Not a promise that the account is active.
 */
export const ViewerId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    context.switchToHttp().getRequest<AuthRequest>().authUserId,
);
