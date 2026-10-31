import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

import { badRequest } from '../auth/http-errors.js';

/**
 * Keyset ("seek") pagination. A cursor is the sort value and the id of the last row of the page;
 * the next page is "rows after that pair". Unlike OFFSET it never skips or repeats a row when
 * rows are added meanwhile, and it stays cheap on deep pages.
 *
 * The sort value travels as text with microsecond precision (a JavaScript Date keeps milliseconds
 * only, which would make rows created within the same millisecond skip or repeat). `infinity` is
 * the sort value of a row without a due date.
 */

export interface KeysetCursor {
  /** Sort value: `2026-11-02T03:00:00.123456Z` or `infinity`. */
  readonly v: string;
  readonly id: string;
}

const VALUE = /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z|infinity)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

/** Decodes a cursor from a client; a malformed one is the client's mistake (400), not a crash. */
export function decodeCursor(value: string): KeysetCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'v' in parsed &&
      'id' in parsed &&
      typeof parsed.v === 'string' &&
      typeof parsed.id === 'string' &&
      VALUE.test(parsed.v) &&
      UUID.test(parsed.id)
    ) {
      return { v: parsed.v, id: parsed.id };
    }
  } catch {
    // fall through
  }
  throw badRequest('Invalid cursor');
}

/** A timestamp column as text with microseconds, for building the next cursor. */
export function preciseTimestamp(column: PgColumn | SQL): SQL<string> {
  return sql<string>`CASE WHEN ${column} IN ('infinity'::timestamptz, '-infinity'::timestamptz) THEN ${column}::text ELSE to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END`;
}

/** `(key, id)` after the cursor in descending order. */
export function beforeCursor(key: PgColumn | SQL, id: PgColumn, cursor: KeysetCursor): SQL {
  return sql`(${key}, ${id}) < (${cursor.v}::timestamptz, ${cursor.id}::uuid)`;
}

/** `(key, id)` after the cursor in ascending order. */
export function afterCursor(key: PgColumn | SQL, id: PgColumn, cursor: KeysetCursor): SQL {
  return sql`(${key}, ${id}) > (${cursor.v}::timestamptz, ${cursor.id}::uuid)`;
}

/** Cuts `limit + 1` fetched rows down to a page and the cursor of its last row. */
export function toPage<Row extends { readonly id: string; readonly sortKey: string }>(
  rows: readonly Row[],
  limit: number,
): { readonly rows: Row[]; readonly nextCursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor: rows.length > limit && last ? encodeCursor({ v: last.sortKey, id: last.id }) : null,
  };
}

/** Escapes `%`, `_` and `\` so user text is matched literally by LIKE and ILIKE. */
export function likeContains(text: string): string {
  return `%${text.normalize('NFC').replace(/[\\%_]/g, '\\$&')}%`;
}
