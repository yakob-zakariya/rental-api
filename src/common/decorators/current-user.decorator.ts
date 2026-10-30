import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import type { AuthRequest } from '../auth-request.js';

/** The signed-in, active user (loaded by ActiveAccountGuard). Not available on @Public() routes. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const user = context.switchToHttp().getRequest<AuthRequest>().currentUser;
    // A programming error (e.g. used on a @Public() route), not a client error.
    if (!user)
      throw new InternalServerErrorException(
        'CurrentUser used without ActiveAccountGuard',
      );
    return user;
  },
);
