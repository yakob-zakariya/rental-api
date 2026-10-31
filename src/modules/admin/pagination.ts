import { BadRequestException } from '@nestjs/common';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** SQL that renders a timestamptz with microseconds, for encodeCursor. */
export const cursorTimestampSql = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * A composite (created_at, id) cursor, opaque to clients: base64url of "<timestamp>|<id>".
 * Rows with the same timestamp still page correctly, ties broken by id.
 */
export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string): {
  createdAt: string;
  id: string;
} {
  const [createdAt, id, ...rest] = Buffer.from(cursor, 'base64url')
    .toString('utf8')
    .split('|');
  if (
    rest.length > 0 ||
    !TIMESTAMP.test(createdAt ?? '') ||
    !UUID.test(id ?? '')
  ) {
    throw new BadRequestException({ code: 'INVALID_CURSOR' });
  }
  return { createdAt, id };
}
