import { SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import type { EnvironmentVariables } from '../config/env.validation.js';

const OTP_REQUEST_LIMITED = Symbol('otp-request-limited');
const ADMIN_LOGIN_LIMITED = Symbol('admin-login-limited');
const reflector = new Reflector();

/** Rule A8: applies the per-IP OTP request limit (OTP_REQUEST_IP_LIMIT_PER_HOUR) to a route. */
export const OtpRequestIpLimit = () => SetMetadata(OTP_REQUEST_LIMITED, true);

/** Staff login brute-force limit (ADMIN_LOGIN_IP_LIMIT_PER_15_MIN per IP). */
export const AdminLoginIpLimit = () => SetMetadata(ADMIN_LOGIN_LIMITED, true);

/** A named throttler that only applies to routes carrying `marker`. */
const onlyMarked = (marker: symbol) => ({
  skipIf: (
    context: Parameters<NonNullable<ThrottlerOptionsLike['skipIf']>>[0],
  ) => !reflector.get<boolean | undefined>(marker, context.getHandler()),
});
type ThrottlerOptionsLike = Extract<ThrottlerModuleOptions, unknown[]>[number];

/**
 * Per-IP limits, in memory per process (see the deployment checklist in product-overview.md).
 * `default` applies to every route; the others only to routes marked with their decorator.
 */
export function throttlerOptions(
  env: Pick<
    EnvironmentVariables,
    'OTP_REQUEST_IP_LIMIT_PER_HOUR' | 'ADMIN_LOGIN_IP_LIMIT_PER_15_MIN'
  >,
): ThrottlerModuleOptions {
  return [
    { name: 'default', ttl: 60_000, limit: 100 },
    {
      name: 'otp-request',
      ttl: 60 * 60_000,
      limit: env.OTP_REQUEST_IP_LIMIT_PER_HOUR,
      ...onlyMarked(OTP_REQUEST_LIMITED),
    },
    {
      name: 'admin-login',
      ttl: 15 * 60_000,
      limit: env.ADMIN_LOGIN_IP_LIMIT_PER_15_MIN,
      ...onlyMarked(ADMIN_LOGIN_LIMITED),
    },
  ];
}
