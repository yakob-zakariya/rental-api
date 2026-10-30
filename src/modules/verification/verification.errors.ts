import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';

/** An error whose response should also carry a Retry-After header (set by the controller). */
export class HttpExceptionWithRetryAfter extends HttpException {
  constructor(
    body: Record<string, unknown>,
    status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(body, status);
  }
}

/** V1. */
export const alreadyVerified = () =>
  new ConflictException({ code: 'ALREADY_VERIFIED' });

/** V13: waiting for staff. */
export const verificationInReview = () =>
  new ConflictException({ code: 'VERIFICATION_IN_REVIEW' });

/** V13: blocked. Neutral on purpose (hard rule 10). */
export const verificationUnavailable = () =>
  new ForbiddenException({ code: 'VERIFICATION_UNAVAILABLE' });

/** V3. */
export const verificationRetryLimit = (
  manualReviewAvailable: boolean,
  retryAfterSeconds: number,
) =>
  new HttpExceptionWithRetryAfter(
    {
      code: 'VERIFICATION_RETRY_LIMIT',
      manualReviewAvailable,
      retryAfterSeconds,
    },
    HttpStatus.TOO_MANY_REQUESTS,
    retryAfterSeconds,
  );

/** Didit failed, or returned a session we can't use. */
export const verificationProviderUnavailable = (retryAfterSeconds?: number) =>
  retryAfterSeconds === undefined
    ? new ServiceUnavailableException({
        code: 'VERIFICATION_PROVIDER_UNAVAILABLE',
      })
    : new HttpExceptionWithRetryAfter(
        { code: 'VERIFICATION_PROVIDER_UNAVAILABLE', retryAfterSeconds },
        HttpStatus.SERVICE_UNAVAILABLE,
        retryAfterSeconds,
      );
