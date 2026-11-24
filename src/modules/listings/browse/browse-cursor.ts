import { BadRequestException } from '@nestjs/common';

export const BROWSE_SORTS = [
  'newest',
  'rent_asc',
  'rent_desc',
  'distance',
] as const;
export type BrowseSort = (typeof BROWSE_SORTS)[number];

/**
 * Where a browse page ended (G5, T5.1): the sort it belongs to, the last row's sort value and its
 * id (the tie-break). Opaque to clients: base64url of JSON. The value is a timestamp (newest,
 * with microseconds, as Postgres stores it), a rent in birr, or a distance in metres (already
 * rounded to 100 m, G4).
 */
export interface BrowseCursor {
  sort: BrowseSort;
  value: string | number;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function encodeBrowseCursor(cursor: BrowseCursor): string {
  return Buffer.from(
    JSON.stringify([cursor.sort, cursor.value, cursor.id]),
  ).toString('base64url');
}

/** 400 INVALID_CURSOR for anything malformed, or a cursor made for another sort. */
export function decodeBrowseCursor(
  raw: string,
  sort: BrowseSort,
): BrowseCursor {
  const invalid = () => new BadRequestException({ code: 'INVALID_CURSOR' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw invalid();
  const [cursorSort, value, id] = parsed as unknown[];
  if (cursorSort !== sort || typeof id !== 'string' || !UUID.test(id))
    throw invalid();
  const valid =
    sort === 'newest'
      ? typeof value === 'string' && TIMESTAMP.test(value)
      : Number.isSafeInteger(value) && (value as number) >= 0;
  if (!valid) throw invalid();
  return { sort, value: value as string | number, id };
}
