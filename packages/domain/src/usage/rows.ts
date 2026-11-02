import {
  USAGE_BUCKET_SECONDS,
  USAGE_DIM_VALUE_MAX,
  USAGE_ORG_DIM,
  USAGE_REDACTED_DIM,
  type UsageRunErrorCode,
} from '@watchtower/shared';

import { dimsHash } from './dims.js';

/**
 * What the data port gives back for a metric template. Narrow on purpose: a column list, rows, and
 * whether the row cap cut the answer short. The real client (T-203) adapts to this shape; the guardrails
 * (read-only transaction, timeout, row cap, personal-data allow-list) live there and are not repeated here.
 */
export interface UsageDataResult {
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly truncated: boolean;
}

export interface ParsedPoint {
  readonly ts: Date;
  /** The organization dimension, when the metric declares one. */
  readonly orgId: string | null;
  /** The other declared dimensions, redacted and cut. */
  readonly dims: Readonly<Record<string, string>>;
  readonly dimsHash: string;
  readonly value: number;
}

export type ParseOutcome =
  | { readonly ok: true; readonly points: ParsedPoint[] }
  | { readonly ok: false; readonly code: UsageRunErrorCode };

/** The longest dimension value that is scanned for personal data at all; more is dropped as a whole. */
const USAGE_DIM_VALUE_SCAN_MAX = 2000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A number from the driver: a JS number, or the text of a numeric. Never NaN or infinite. */
function asFiniteNumber(value: unknown): number | null {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : typeof value === 'bigint'
          ? Number(value)
          : Number.NaN;
  return Number.isFinite(number) && Math.abs(number) < 1e300 ? number : null;
}

function asDate(value: unknown): Date | null {
  const date =
    value instanceof Date
      ? value
      : typeof value === 'string'
        ? new Date(value)
        : new Date(Number.NaN);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A dimension value as stored: text, cut, and `[redacted]` whole if the redactor changed it. */
/** Text of a plain value; null for an object, an array or anything else that has no honest text. */
function plainText(value: unknown): string | null {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

export function cleanDimValue(raw: unknown, sanitize: (value: string) => string): string {
  // An object has no text to keep: it is stored as the fixed marker, not as `[object Object]`.
  const plain = plainText(raw);
  if (plain === null) return USAGE_REDACTED_DIM;
  const text = plain.trim();
  if (text === '') return '';
  // Redact the WHOLE value first, then cut: cutting first can leave half an email or a phone number that
  // the redactor no longer recognizes. A value too long to have been written by hand is not kept at all.
  if (text.length > USAGE_DIM_VALUE_SCAN_MAX) return USAGE_REDACTED_DIM;
  // Deterministic: a value with personal data in it is one fixed marker, never a numbered token whose
  // number depends on the order of the rows (that would make a repeated run write different series).
  if (sanitize(text) !== text) return USAGE_REDACTED_DIM;
  return text.slice(0, USAGE_DIM_VALUE_MAX);
}

/**
 * Checks a result against the metric and turns it into points, or refuses the whole thing (a run writes
 * everything or nothing). The rules, in the order they bite:
 *  - an answer cut by the row cap, or longer than `maxPoints`, is refused;
 *  - the columns are `ts`, `value` and exactly the declared dimensions: an extra column is refused (so
 *    a template cannot smuggle a field into storage by selecting it), a missing one is refused too;
 *  - `ts` is an hour boundary inside the window; `value` is finite; the organization dimension is a uuid;
 *  - two rows of one series and hour are refused (the template must group).
 */
export function parseUsageRows(
  result: UsageDataResult,
  metric: { readonly dims: readonly string[] },
  window: { readonly from: Date; readonly to: Date },
  sanitize: (value: string) => string,
  maxPoints: number,
): ParseOutcome {
  if (result.truncated) return { ok: false, code: 'truncated' };
  if (result.rows.length > maxPoints) return { ok: false, code: 'too_many_rows' };
  const allowed = new Set<string>(['ts', 'value', ...metric.dims]);
  for (const column of result.columns) {
    if (!allowed.has(column)) return { ok: false, code: 'extra_column' };
  }
  for (const needed of allowed) {
    if (!result.columns.includes(needed)) return { ok: false, code: 'missing_column' };
  }
  const seen = new Set<string>();
  const points: ParsedPoint[] = [];
  for (const row of result.rows) {
    for (const key of Object.keys(row)) {
      if (!allowed.has(key)) return { ok: false, code: 'extra_column' };
    }
    const ts = asDate(row.ts);
    if (ts === null) return { ok: false, code: 'bad_row' };
    if (
      ts.getTime() % (USAGE_BUCKET_SECONDS * 1000) !== 0 ||
      ts.getTime() < window.from.getTime() ||
      ts.getTime() > window.to.getTime()
    ) {
      return { ok: false, code: 'bad_bucket' };
    }
    const value = asFiniteNumber(row.value);
    if (value === null) return { ok: false, code: 'bad_row' };

    let orgId: string | null = null;
    const dims: Record<string, string> = {};
    for (const name of metric.dims) {
      if (name === USAGE_ORG_DIM) {
        const text = (plainText(row[name]) ?? '').toLowerCase();
        if (!UUID.test(text)) return { ok: false, code: 'bad_row' };
        orgId = text;
      } else {
        dims[name] = cleanDimValue(row[name], sanitize);
      }
    }
    const hash = dimsHash(orgId === null ? dims : { ...dims, [USAGE_ORG_DIM]: orgId });
    const key = `${String(ts.getTime())}:${hash}`;
    if (seen.has(key)) return { ok: false, code: 'bad_row' };
    seen.add(key);
    points.push({ ts, orgId, dims, dimsHash: hash, value });
  }
  return { ok: true, points };
}
