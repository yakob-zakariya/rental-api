import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import { IdentityKind } from './verification.enums.js';

export type IdentityIdentifier =
  | { kind: IdentityKind.FaydaFin | IdentityKind.FaydaFan; number: string }
  | { kind: IdentityKind.Passport; number: string; country: string };

/** Bad input to hashIdentity. The message never contains the ID number (hard rule 1). */
export class IdentityHashInputError extends Error {
  readonly name = 'IdentityHashInputError';
}

// Whitespace (\s covers non-breaking spaces) and every Unicode dash (\p{Pd}).
const SEPARATORS = /[\s\p{Pd}]/gu;
const ALPHA_3 = /^[A-Z]{3}$/;

/**
 * Spec V10: NFKC, then uppercase, then remove whitespace and dash punctuation.
 * NEVER change this once real users are verified: like ID_HASH_PEPPER, any change produces new
 * hashes and silently breaks ban (V5) and duplicate (V6) checks for everyone verified before.
 */
export function normaliseIdNumber(raw: string): string {
  return raw.normalize('NFKC').toUpperCase().replace(SEPARATORS, '');
}

/**
 * HMAC-SHA256 (hex) of an identifier, per hard rule 2 / spec V10:
 * - Fayda:    HMAC(pepper, "<kind>:" + normalise(number)), e.g. "fayda_fin:123456789012"
 * - Passport: HMAC(pepper, "passport:" + country + ":" + normalise(number)),
 *             e.g. "passport:ETH:EP1234567" (country: ISO 3166-1 alpha-3)
 * Throws IdentityHashInputError for an empty number or a malformed country.
 */
export function hashIdentity(
  pepper: string,
  identifier: IdentityIdentifier,
): string {
  const number = normaliseIdNumber(identifier.number);
  if (number === '') throw new IdentityHashInputError('ID number is empty');

  let input: string;
  if (identifier.kind === IdentityKind.Passport) {
    const country = identifier.country.normalize('NFKC').trim().toUpperCase();
    if (!ALPHA_3.test(country)) {
      throw new IdentityHashInputError(
        'Passport issuing country must be ISO 3166-1 alpha-3',
      );
    }
    input = `${IdentityKind.Passport}:${country}:${number}`;
  } else {
    input = `${identifier.kind}:${number}`;
  }
  return createHmac('sha256', pepper).update(input, 'utf8').digest('hex');
}

/** hashIdentity with ID_HASH_PEPPER, for decision processing (T2.6) and staff entry (T3.3). */
@Injectable()
export class IdentityHasher {
  private readonly pepper: string;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    this.pepper = config.get('ID_HASH_PEPPER', { infer: true });
  }

  hash(identifier: IdentityIdentifier): string {
    return hashIdentity(this.pepper, identifier);
  }
}
