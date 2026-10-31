import { z } from 'zod';

/**
 * LINE message quota accounting (R-2.10, ADR-010 section 6). Pure functions over a small snapshot;
 * where the counter is stored (`channel_quota_usage`) is the caller's business.
 *
 * What counts (https://developers.line.biz/en/docs/messaging-api/pricing/, read 2026-10-31):
 * push, multicast, broadcast and narrowcast messages count, one per recipient (a push to a
 * five-person room is 5; the number of message objects in the request does not matter); reply
 * messages do not count; a message to a user who blocked the account is not counted.
 */

/** Warn the agent at this share of the quota (PRD R-2.10). A product rule, not a LINE value. */
export const DEFAULT_QUOTA_WARN_PERCENT = 80;

/**
 * Free-plan monthly messages when LINE reports no explicit target limit. 300 is the Thai free plan
 * (https://lineforbusiness.com/th/service/line-oa-features/broadcast-message, read 2026-10-31);
 * po #5 default. A conservative fallback only: `GET /v2/bot/message/quota` is authoritative.
 */
export const FALLBACK_QUOTA_LIMIT = 300;

export const quotaSnapshotSchema = z.object({
  /** Messages counted this period (reservations included). */
  used: z.number().int().nonnegative(),
  /** Monthly cap, or null when unknown (nothing is blocked, nothing can be proven). */
  limit: z.number().int().nonnegative().nullable(),
});

export type QuotaSnapshot = z.infer<typeof quotaSnapshotSchema>;

export type QuotaLevel = 'ok' | 'warn' | 'exhausted' | 'unknown';

export interface QuotaView {
  readonly used: number;
  readonly limit: number | null;
  readonly remaining: number | null;
  /** 0-100, or null when the limit is unknown. */
  readonly percentUsed: number | null;
  readonly level: QuotaLevel;
}

export function evaluateQuota(
  snapshot: QuotaSnapshot,
  warnPercent: number = DEFAULT_QUOTA_WARN_PERCENT,
): QuotaView {
  const { used, limit } = snapshot;
  if (limit === null) {
    return { used, limit, remaining: null, percentUsed: null, level: 'unknown' };
  }
  const remaining = Math.max(0, limit - used);
  const percentUsed = limit === 0 ? 100 : Math.min(100, (used / limit) * 100);
  const level: QuotaLevel =
    remaining === 0 ? 'exhausted' : percentUsed >= warnPercent ? 'warn' : 'ok';
  return { used, limit, remaining, percentUsed, level };
}

/** True when `recipients` more counted messages fit. An unknown limit never blocks. */
export function canSpend(snapshot: QuotaSnapshot, recipients = 1): boolean {
  if (snapshot.limit === null) return true;
  return snapshot.used + recipients <= snapshot.limit;
}

/** Reserves quota at claim time (ADR-010). Returns null when it does not fit. */
export function reserveQuota(snapshot: QuotaSnapshot, recipients = 1): QuotaSnapshot | null {
  if (!canSpend(snapshot, recipients)) return null;
  return { used: snapshot.used + recipients, limit: snapshot.limit };
}

/** Gives a reservation back after a send that provably did not happen. Never below zero. */
export function releaseQuota(snapshot: QuotaSnapshot, recipients = 1): QuotaSnapshot {
  return { used: Math.max(0, snapshot.used - recipients), limit: snapshot.limit };
}

/** `GET /v2/bot/message/quota`: `type` is `none` (no target limit set) or `limited` with `value`. */
export const lineQuotaResponseSchema = z.object({
  type: z.enum(['none', 'limited']),
  value: z.number().int().nonnegative().optional(),
});

/** `GET /v2/bot/message/quota/consumption`. The count is approximate per LINE. */
export const lineConsumptionResponseSchema = z.object({
  totalUsage: z.number().int().nonnegative(),
});

export type LineQuotaResponse = z.infer<typeof lineQuotaResponseSchema>;
export type LineConsumptionResponse = z.infer<typeof lineConsumptionResponseSchema>;

/**
 * `limited` -> its value. `none` means no target limit is set, not "unlimited free messages", so
 * the caller's fallback (the plan's free allowance) applies.
 */
export function resolveQuotaLimit(
  remote: LineQuotaResponse,
  fallbackLimit: number | null = FALLBACK_QUOTA_LIMIT,
): number | null {
  return remote.type === 'limited' && remote.value !== undefined ? remote.value : fallbackLimit;
}

/**
 * Hourly reconciliation (ADR-010): LINE's consumption includes messages sent from LINE Official
 * Account Manager and is authoritative, but approximate. Our local count can be ahead of it while
 * a send is in flight, so keep the larger of the two for `used`.
 */
export function reconcileQuota(
  local: QuotaSnapshot,
  remote: { readonly totalUsage: number; readonly limit: number | null },
): QuotaSnapshot {
  return { used: Math.max(local.used, remote.totalUsage), limit: remote.limit };
}

/**
 * Billing period key `YYYY-MM` for a counter row. LINE says "this month" without naming a time
 * zone `[VERIFY]`, so the zone is a parameter; the default is the instance's business zone.
 */
export function quotaPeriod(date: Date, timeZone = 'Asia/Bangkok'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (year === undefined || month === undefined) throw new Error('cannot format quota period');
  return `${year}-${month}`;
}
