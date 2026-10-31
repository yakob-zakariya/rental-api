import { hash, verify } from '@node-rs/argon2';

export const MIN_PASSWORD_LENGTH = 12;

// Argon2id (2 in @node-rs/argon2's const enum, which isolatedModules can't import). The library's
// default parameters (m=19 MiB, t=2, p=1) match OWASP's recommended minimum.
const OPTIONS = { algorithm: 2 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

/** False (never throws) for a wrong password or a malformed hash. */
export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;
/**
 * A hash to verify against when the email is unknown, so a login takes about as long whether
 * or not the account exists (no account enumeration by timing).
 */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword('dummy-password-for-timing-only');
  return dummyHash;
}
