import { trimIdVerifications } from '../modules/verification/didit/decision-parser.js';
import {
  DECISION_TIME_ZONE,
  isIsoDate,
  todayIn,
} from '../modules/verification/decision/age.js';
import { extractIdentity } from '../modules/verification/decision/identifiers.js';

/**
 * `npm run didit:inspect` (T2.9): describes the SHAPE of a raw Didit decision so the open
 * questions about real documents can be answered without anyone seeing personal data.
 *
 * Allow-list, never block-list: only the fields named here are described, and personal values
 * only as masks (digits → 9, letters → A). Names, ID numbers, dates of birth, addresses, image /
 * video URLs, IP addresses and warning descriptions are never printed (hard rule 1). Unknown
 * fields are listed by name only.
 */

type Json = Record<string, unknown>;

const MAX_MASK = 32;

/** e.g. "EP1234567" → "AA9999999 (9 chars)". Letters → A (L if non-Latin), digits → 9. */
export function mask(value: unknown): string {
  if (value === null || value === undefined) return 'absent';
  if (typeof value !== 'string') return `(${typeof value})`;
  if (value === '') return 'empty';
  // Code points, so a non-Latin letter counts once (L) and lengths match what a person reads.
  const chars = Array.from(value);
  const masked = chars
    .slice(0, MAX_MASK)
    .map((c) => {
      if (/\p{Nd}/u.test(c)) return '9';
      if (/[A-Za-z]/.test(c)) return 'A';
      if (/\p{L}/u.test(c)) return 'L';
      if (/\s/.test(c)) return ' ';
      if (/[-/.,:]/.test(c)) return c;
      return '?';
    })
    .join('');
  const more = chars.length > MAX_MASK ? `…(+${chars.length - MAX_MASK})` : '';
  return `"${masked}${more}" (${chars.length} chars)`;
}

/** Whole years between a YYYY-MM-DD date and `today`, read as Gregorian. */
export function ageOn(dateOfBirth: string, today: string): number | null {
  if (!isIsoDate(dateOfBirth) || !isIsoDate(today)) return null;
  const [by, bm, bd] = dateOfBirth.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  return ty - by - (tm > bm || (tm === bm && td >= bd) ? 0 : 1);
}

function describeDate(value: unknown, today: string): string {
  if (typeof value !== 'string' || value === '') return mask(value);
  if (!isIsoDate(value)) return `not YYYY-MM-DD: ${mask(value)}`;
  return value < today
    ? 'YYYY-MM-DD, in the past'
    : 'YYYY-MM-DD, today or later';
}

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const items = (value: unknown): Json[] =>
  Array.isArray(value) ? value.filter(isObject) : [];

/** Safe-to-print enum-like strings (statuses, codes, ISO countries); anything else is masked. */
function code(value: unknown): string {
  if (value === null || value === undefined) return 'absent';
  if (typeof value === 'string' && /^[A-Za-z0-9_ .-]{1,40}$/.test(value)) {
    return value;
  }
  return mask(value);
}

function flag(value: unknown): string {
  return typeof value === 'boolean' ? String(value) : code(value);
}

function num(value: unknown): string {
  return typeof value === 'number' ? String(value) : code(value);
}

/** Keys (recursively) with values masked; numbers and booleans by type only. */
function describeTree(value: unknown, indent: string, out: string[]): void {
  if (!isObject(value)) return;
  for (const [key, inner] of Object.entries(value).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (isObject(inner)) {
      out.push(`${indent}${key}:`);
      describeTree(inner, `${indent}  `, out);
    } else if (Array.isArray(inner)) {
      out.push(`${indent}${key}: array of ${inner.length}`);
    } else if (typeof inner === 'string' || inner === null) {
      out.push(`${indent}${key}: ${mask(inner)}`);
    } else {
      out.push(`${indent}${key}: (${typeof inner})`);
    }
  }
}

function warnings(item: Json, indent: string, out: string[]): void {
  const list = items(item.warnings);
  if (list.length === 0) {
    out.push(`${indent}warnings: none`);
    return;
  }
  out.push(`${indent}warnings:`);
  for (const w of list) {
    // Descriptions and additional_data can quote document data: codes only.
    out.push(
      `${indent}  - ${code(w.risk)} (feature ${code(w.feature)}, ${code(w.log_type)})`,
    );
  }
}

const ID_DESCRIBED = new Set([
  'status',
  'document_type',
  'document_subtype',
  'issuing_state',
  'document_number',
  'personal_number',
  'date_of_birth',
  'age',
  'expiration_date',
  'date_of_issue',
  'verification_method',
  'extra_fields',
  'extracted_data',
  'warnings',
  'node_id',
]);

export function inspectDecision(
  decision: Json,
  today: string = todayIn(DECISION_TIME_ZONE),
): string[] {
  const out: string[] = [];
  out.push(`session status: ${code(decision.status)}`);
  const arrays = Object.entries(decision)
    .filter(([, v]) => Array.isArray(v) && v.length > 0)
    .map(([k, v]) => `${k} (${(v as unknown[]).length})`)
    .sort();
  out.push(`features present: ${arrays.join(', ') || 'none'}`);

  const ids = items(decision.id_verifications);
  ids.forEach((d, i) => {
    out.push('', `id_verifications[${i}]:`);
    out.push(`  status: ${code(d.status)}`);
    out.push(`  document_type: ${code(d.document_type)}`);
    out.push(`  document_subtype: ${code(d.document_subtype)}`);
    out.push(`  issuing_state: ${code(d.issuing_state)}`);
    out.push(`  verification_method: ${code(d.verification_method)}`);
    out.push(`  document_number: ${mask(d.document_number)}`);
    out.push(`  personal_number: ${mask(d.personal_number)}`);
    const dob = d.date_of_birth;
    const implied =
      typeof dob === 'string' && isIsoDate(dob) ? ageOn(dob, today) : null;
    out.push(
      `  date_of_birth: ${describeDate(dob, today).replace(', in the past', '')}` +
        (implied === null ? '' : `; age if Gregorian: ${implied}`),
    );
    out.push(`  age (Didit's): ${num(d.age)}`);
    out.push(`  expiration_date: ${describeDate(d.expiration_date, today)}`);
    out.push(`  date_of_issue: ${describeDate(d.date_of_issue, today)}`);
    // Where else a Fayda FIN/FAN might come back: keys and masked values only.
    for (const key of ['extra_fields', 'extracted_data'] as const) {
      if (isObject(d[key]) && Object.keys(d[key]).length > 0) {
        out.push(`  ${key}:`);
        describeTree(d[key], '    ', out);
      } else {
        out.push(`  ${key}: none`);
      }
    }
    warnings(d, '  ', out);
    const other = Object.keys(d)
      .filter((k) => !ID_DESCRIBED.has(k))
      .sort();
    out.push(`  other fields (names only): ${other.join(', ') || 'none'}`);
  });

  for (const l of items(decision.liveness_checks)) {
    out.push('', 'liveness_checks:');
    out.push(
      `  status: ${code(l.status)}, method: ${code(l.method)}, score: ${num(l.score)}`,
    );
    warnings(l, '  ', out);
  }
  for (const f of items(decision.face_matches)) {
    out.push('', 'face_matches:');
    out.push(`  status: ${code(f.status)}, score: ${num(f.score)}`);
    warnings(f, '  ', out);
  }
  for (const ip of items(decision.ip_analyses)) {
    out.push('', 'ip_analyses:');
    out.push(
      `  status: ${code(ip.status)}, country: ${code(ip.ip_country_code)}, ` +
        `vpn/tor: ${flag(ip.is_vpn_or_tor)}, data centre: ${flag(ip.is_data_center)}`,
    );
    warnings(ip, '  ', out);
  }

  // What our own decision code (T2.6) would read from it: kinds and problems, never numbers.
  const identity = extractIdentity(trimIdVerifications(ids));
  out.push('', 'our reading (extractIdentity):');
  out.push(
    `  identifiers: ${identity.identifiers.map((x) => x.kind).join(', ') || 'none'}`,
  );
  out.push(
    `  check-only identifiers: ${identity.checkOnlyIdentifiers.map((x) => x.kind).join(', ') || 'none'}`,
  );
  out.push(`  document type: ${code(identity.documentType)}`);
  out.push(`  name present: ${identity.fullName !== null}`);
  const age = identity.dateOfBirth ? ageOn(identity.dateOfBirth, today) : null;
  out.push(
    `  date of birth present: ${identity.dateOfBirth !== null}` +
      (age === null
        ? ''
        : `; V4 (Gregorian) says ${age >= 18 ? '18+' : 'UNDER 18'}`),
  );
  out.push(`  problems: ${identity.problems.join(', ') || 'none'}`);
  return out;
}
