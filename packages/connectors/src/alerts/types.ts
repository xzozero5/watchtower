import { sanitizeAlertUrl, type AlertSeverity, type NormalizedAlert } from '@watchtower/shared';

/** Why a delivery could not be turned into an alert. Never carries the payload. */
export type RejectReason =
  'not_json' | 'unsupported_version' | 'invalid_shape' | 'unknown_state' | 'missing_name';

export type NormalizeResult =
  | { readonly ok: true; readonly alert: NormalizedAlert }
  | { readonly ok: false; readonly reason: RejectReason };

export const rejected = (reason: RejectReason): NormalizeResult => ({ ok: false, reason });

/** An ISO timestamp for unix seconds, or null when the number is not a plausible time. */
export function isoFromUnixSeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 946_684_800 || value > 4_102_444_800) return null; // 2000-01-01 .. 2100-01-01
  return new Date(value * 1000).toISOString();
}

/** An ISO timestamp for an RFC 3339 string, or null (also for Alertmanager's "0001-01-01T00:00:00Z" placeholder). */
export function isoFromRfc3339(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  if (time < Date.UTC(2000, 0, 1) || time > Date.UTC(2100, 0, 1)) return null;
  return new Date(time).toISOString();
}

/**
 * `https://…` or `http://…` only, with no user name or password, no fragment and no credential-looking
 * query parameter (see `sanitizeAlertUrl`); anything else is dropped (no `javascript:` into a link).
 */
export function safeHttpUrl(
  value: unknown,
  options: { readonly keepQuery?: boolean } = {},
): string | null {
  return sanitizeAlertUrl(value, options);
}

/** A severity word looked up in a fixed table: own keys only, so `constructor` is just an unknown word. */
export function severityFrom(
  table: Readonly<Record<string, AlertSeverity>>,
  value: unknown,
): AlertSeverity {
  if (typeof value !== 'string') return 'unknown';
  const word = value.trim().toLowerCase();
  return Object.hasOwn(table, word) ? (table[word] ?? 'unknown') : 'unknown';
}
