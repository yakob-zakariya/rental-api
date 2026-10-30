import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import type { AuthRequest } from '../../../common/auth-request.js';
import { VerificationStatus } from '../../users/user.enums.js';

/** Per route (`@UseGuards(VerifiedGuard)`): requires an approved identity verification. */
@Injectable()
export class VerifiedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<AuthRequest>().currentUser;
    if (!user) {
      throw new InternalServerErrorException(
        'VerifiedGuard used without ActiveAccountGuard',
      );
    }
    if (user.verificationStatus !== VerificationStatus.Approved) {
      throw new ForbiddenException({ code: 'VERIFICATION_REQUIRED' });
    }
    return true;
  }
}
