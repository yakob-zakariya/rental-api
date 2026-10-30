import { SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import type { EnvironmentVariables } from '../config/env.validation.js';

const OTP_REQUEST_THROTTLER = 'otp-request';
const OTP_REQUEST_LIMITED = Symbol('otp-request-limited');
const reflector = new Reflector();

/** Rule A8: applies the per-IP OTP request limit (OTP_REQUEST_IP_LIMIT_PER_HOUR) to a route. */
export const OtpRequestIpLimit = () => SetMetadata(OTP_REQUEST_LIMITED, true);

/**
 * Per-IP limits, in memory per process (see the deployment checklist in product-overview.md).
 * `default` applies to every route; `otp-request` only to routes marked @OtpRequestIpLimit().
 */
export function throttlerOptions(
  env: Pick<EnvironmentVariables, 'OTP_REQUEST_IP_LIMIT_PER_HOUR'>,
): ThrottlerModuleOptions {
  return [
    { name: 'default', ttl: 60_000, limit: 100 },
    {
      name: OTP_REQUEST_THROTTLER,
      ttl: 60 * 60_000,
      limit: env.OTP_REQUEST_IP_LIMIT_PER_HOUR,
      skipIf: (context) =>
        !reflector.get<boolean | undefined>(
          OTP_REQUEST_LIMITED,
          context.getHandler(),
        ),
    },
  ];
}
