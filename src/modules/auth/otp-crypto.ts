import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export const OTP_LENGTH = 6;
const OTP_FORMAT = /^\d{6}$/;
const HASH_FORMAT = /^[0-9a-f]{64}$/;

/** Rule A1: a uniformly random 6-digit code, leading zeros kept. */
export function generateOtpCode(): string {
  return randomInt(0, 10 ** OTP_LENGTH)
    .toString()
    .padStart(OTP_LENGTH, '0');
}

/** Rule A9: HMAC_SHA256(OTP_HASH_SECRET, phone + ":" + code), hex. */
export function hashOtpCode(
  secret: string,
  phone: string,
  code: string,
): string {
  return createHmac('sha256', secret).update(`${phone}:${code}`).digest('hex');
}

/** Rule A9: constant-time comparison against the stored hash. False for malformed input. */
export function otpCodeMatches(
  secret: string,
  phone: string,
  code: string,
  storedHash: string,
): boolean {
  if (!OTP_FORMAT.test(code) || !HASH_FORMAT.test(storedHash)) return false;
  return timingSafeEqual(
    Buffer.from(hashOtpCode(secret, phone, code), 'hex'),
    Buffer.from(storedHash, 'hex'),
  );
}
