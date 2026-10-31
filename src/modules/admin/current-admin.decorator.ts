import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import type { AdminRequest } from './admin-request.js';

/** The signed-in, active admin (loaded by AdminAuthGuard). */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const admin = context
      .switchToHttp()
      .getRequest<AdminRequest>().currentAdmin;
    if (!admin)
      throw new InternalServerErrorException(
        'CurrentAdmin used without AdminAuthGuard',
      );
    return admin;
  },
);
