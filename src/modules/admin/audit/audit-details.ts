import { BadRequestException } from '@nestjs/common';

/**
 * What an audit row may say about an action — a closed set, so a raw ID number or a personal
 * document can't be stored under some other key (hard rules 1 and 11). `enteredFields` holds the
 * NAMES of fields staff typed in (e.g. "idNumber"), never their values.
 */
export interface AuditDetails {
  reason?: string;
  note?: string;
  reasonCode?: string;
  enteredFields?: string[];
  previousOutcome?: string;
  newOutcome?: string;
}

const TEXT_KEYS = [
  'reason',
  'note',
  'reasonCode',
  'previousOutcome',
  'newOutcome',
] as const;
const ALLOWED_KEYS = new Set<string>([...TEXT_KEYS, 'enteredFields']);
export const MAX_DETAIL_LENGTH = 1000;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

// Whitespace and Unicode dashes, removed so "0911 234-567" counts as one run of digits.
const SEPARATORS = /[\s\p{Pd}]/gu;
const LONG_DIGIT_RUN = /\d{9,}/;
// For the passport-like check, separators are dropped between digits ("123-4567") and after a
// capital letter ("EP 1234567", as printed) — but not after a lowercase word, so "on 2026-10-31"
// stays two words.
const SEPARATOR_BETWEEN_DIGITS = /(?<=\d)[\s\p{Pd}]+(?=\d)/gu;
const SEPARATOR_AFTER_CAPITAL = /(?<=[A-Z])[\s\p{Pd}]+(?=\d)/gu;
// 1–2 letters (not part of a longer word) then 6+ digits: passport-like, e.g. EP1234567.
const PASSPORT_LIKE = /(?<![A-Za-z])[A-Za-z]{1,2}\d{6,}/;

/**
 * True if free text looks like it contains an ID number: after NFKC (so full-width digits count,
 * as in the ID hasher), 9+ consecutive digits once spaces and dashes are removed, or a
 * passport-like 1–2 letters followed by 6+ digits (e.g. EP1234567, EP 123-4567).
 */
export function containsIdNumber(text: string): boolean {
  const normalised = text.normalize('NFKC');
  if (LONG_DIGIT_RUN.test(normalised.replace(SEPARATORS, ''))) return true;
  return PASSPORT_LIKE.test(
    normalised
      .replace(SEPARATOR_BETWEEN_DIGITS, '')
      .replace(SEPARATOR_AFTER_CAPITAL, ''),
  );
}

export const noteContainsIdNumber = () =>
  new BadRequestException({ code: 'NOTE_CONTAINS_ID_NUMBER' });

/**
 * Checks details before they're stored: known keys only, bounded strings, field names only in
 * enteredFields, and no ID-number-like text anywhere. Throws 400 NOTE_CONTAINS_ID_NUMBER for the
 * latter; any other violation is a programming error.
 */
export function assertSafeDetails(details: AuditDetails): void {
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue;
    if (!ALLOWED_KEYS.has(key))
      throw new Error(`Audit details may not contain "${key}"`);

    if (key === 'enteredFields') {
      if (
        !Array.isArray(value) ||
        !value.every((v) => typeof v === 'string' && FIELD_NAME.test(v))
      ) {
        throw new Error('Audit enteredFields must be a list of field names');
      }
      continue;
    }
    if (typeof value !== 'string' || value.length > MAX_DETAIL_LENGTH) {
      throw new Error(
        `Audit detail "${key}" must be a string of at most ${MAX_DETAIL_LENGTH} characters`,
      );
    }
    if (containsIdNumber(value)) throw noteContainsIdNumber();
  }
}
