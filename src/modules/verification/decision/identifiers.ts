import type { DiditIdVerification } from '../didit/didit.types.js';
import {
  type IdentityIdentifier,
  normaliseIdNumber,
} from '../identity-hasher.js';
import { IdentityKind } from '../verification.enums.js';
import { isIsoDate } from './age.js';
import { normaliseName } from './name.js';

/** Why an approved decision can't be approved automatically. */
export enum IdentityProblem {
  /** V8: no number that maps to a known kind. */
  NoIdentifier = 'NO_IDENTIFIER',
  /** V8: no (valid) date of birth. */
  NoDateOfBirth = 'NO_DATE_OF_BIRTH',
  /** V8: a passport without a usable ISO alpha-3 issuing country. */
  PassportWithoutCountry = 'PASSPORT_WITHOUT_COUNTRY',
  /** V17: documents in one decision disagree on date of birth or (normalised) name. */
  DocumentMismatch = 'DOCUMENT_MISMATCH',
  /** V18: a document's own status isn't Approved, although Didit approved the session. */
  DocumentDeclined = 'DOCUMENT_DECLINED',
}

export interface ExtractedIdentity {
  /** From documents Didit approved: hashed, stored and (if all checks pass) approved. */
  identifiers: IdentityIdentifier[];
  /**
   * V18: from documents Didit did NOT approve. Only for the V5/V6 checks (they can only make us
   * more cautious): never stored and never approved, since it could be someone else's number on
   * a fake document.
   */
  checkOnlyIdentifiers: IdentityIdentifier[];
  /** As Didit returned it (from the first approved document that has a name). */
  fullName: string | null;
  dateOfBirth: string | null;
  /** Didit's document_type of the first approved document that produced an identifier. */
  documentType: string | null;
  problems: IdentityProblem[];
}

// Starting rule for Fayda numbers (confirm in T2.9): 12 digits = FIN, 16 digits = FAN.
// Anything else is ignored, never guessed (it leads to V8 if nothing else is usable).
const FAYDA_BY_LENGTH: Record<
  number,
  IdentityKind.FaydaFin | IdentityKind.FaydaFan
> = {
  12: IdentityKind.FaydaFin,
  16: IdentityKind.FaydaFan,
};
const DIGITS = /^\d+$/;
const ALPHA_3 = /^[A-Z]{3}$/;
/** Didit's per-document (feature-level) status of an approved document. */
const APPROVED = 'Approved';

/**
 * Reads identifiers, name and date of birth from every document in a Didit decision (spec V8,
 * V10, V17, V18). Pure: hashing and all decisions happen in the caller. Raw numbers only live in
 * the returned identifiers, which the caller hashes immediately (hard rule 1).
 *
 * A document whose own status isn't "Approved" (V18) only contributes check-only identifiers:
 * its name and date of birth are ignored, and the attempt can't be approved automatically.
 */
export function extractIdentity(
  documents: readonly DiditIdVerification[],
): ExtractedIdentity {
  const identifiers = new Map<string, IdentityIdentifier>();
  const checkOnly = new Map<string, IdentityIdentifier>();
  const problems = new Set<IdentityProblem>();
  let documentType: string | null = null;

  for (const document of documents) {
    const trusted = document.status === APPROVED;
    if (!trusted) problems.add(IdentityProblem.DocumentDeclined);
    // A declined document's own problems (e.g. no passport country) don't matter: it's ignored.
    const found = identifiersOf(document, trusted ? problems : new Set());
    for (const identifier of found) {
      (trusted ? identifiers : checkOnly).set(keyOf(identifier), identifier);
    }
    if (trusted && found.length > 0) documentType ??= document.documentType;
  }
  // An identifier that also appears on an approved document is a normal one.
  for (const key of identifiers.keys()) checkOnly.delete(key);

  const approved = documents.filter((d) => d.status === APPROVED);
  const dates = approved
    .map((d) => d.dateOfBirth)
    .filter((dob): dob is string => dob !== null && isIsoDate(dob));
  const names = approved
    .map(nameOf)
    .filter(
      (name): name is string => name !== null && normaliseName(name) !== '',
    );

  if (new Set(dates).size > 1 || new Set(names.map(normaliseName)).size > 1) {
    problems.add(IdentityProblem.DocumentMismatch);
  }
  if (identifiers.size === 0) problems.add(IdentityProblem.NoIdentifier);
  if (dates.length === 0) problems.add(IdentityProblem.NoDateOfBirth);

  return {
    identifiers: [...identifiers.values()],
    checkOnlyIdentifiers: [...checkOnly.values()],
    fullName: names[0] ?? null,
    dateOfBirth: dates[0] ?? null,
    documentType,
    problems: [...problems],
  };
}

function identifiersOf(
  document: DiditIdVerification,
  problems: Set<IdentityProblem>,
): IdentityIdentifier[] {
  const country = document.issuingState?.trim().toUpperCase() ?? null;

  if (document.documentType === 'Passport') {
    const number =
      document.documentNumber && normaliseIdNumber(document.documentNumber);
    if (!number) return [];
    if (!country || !ALPHA_3.test(country)) {
      problems.add(IdentityProblem.PassportWithoutCountry);
      return [];
    }
    return [{ kind: IdentityKind.Passport, number, country }];
  }

  if (document.documentType === 'Identity Card' && country === 'ETH') {
    return [document.documentNumber, document.personalNumber].flatMap((raw) => {
      if (!raw) return [];
      const number = normaliseIdNumber(raw);
      const kind = DIGITS.test(number)
        ? FAYDA_BY_LENGTH[number.length]
        : undefined;
      return kind ? [{ kind, number }] : [];
    });
  }

  // Any other document type (or a non-Ethiopian ID card) yields no identifier.
  return [];
}

function nameOf(document: DiditIdVerification): string | null {
  if (document.fullName) return document.fullName;
  const parts = [document.firstName, document.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

function keyOf(identifier: IdentityIdentifier): string {
  return identifier.kind === IdentityKind.Passport
    ? `${identifier.kind}:${identifier.country}:${identifier.number}`
    : `${identifier.kind}:${identifier.number}`;
}
