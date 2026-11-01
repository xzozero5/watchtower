import type { NormalizedAlert } from '@watchtower/shared';

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

/** `https://…` or `http://…` only, bounded; anything else is dropped (no `javascript:` into a link). */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1000) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}
