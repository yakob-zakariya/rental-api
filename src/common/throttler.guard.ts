import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/** ThrottlerGuard with our error shape: 429 `{ code: 'RATE_LIMITED' }` (Retry-After is still set). */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected throwThrottlingException(): Promise<void> {
    throw new HttpException(
      { code: 'RATE_LIMITED' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
