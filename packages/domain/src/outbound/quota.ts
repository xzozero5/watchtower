import { schema } from '@watchtower/db';
import { and, eq, sql } from 'drizzle-orm';

import type { DbTransaction } from '../types.js';

/**
 * The LINE push counter (ADR-010 section 6, R-2.10). The router (`packages/channels`) decides from a
 * snapshot; this file reads and moves the stored numbers, inside the dispatcher's transaction.
 */

export interface QuotaSnapshot {
  readonly used: number;
  readonly limit: number | null;
}

/**
 * Locks the counter of one account and month and returns it. A month's first push creates the row
 * with `defaultLimit` (the plan's free allowance until the hourly reconcile learns the real one).
 */
export async function lockQuota(
  tx: DbTransaction,
  accountId: string,
  period: string,
  defaultLimit: number | null,
): Promise<QuotaSnapshot> {
  await tx
    .insert(schema.channelQuotaUsage)
    .values({ channelAccountId: accountId, period, quotaLimit: defaultLimit })
    .onConflictDoNothing();
  const [row] = await tx
    .select({ used: schema.channelQuotaUsage.used, limit: schema.channelQuotaUsage.quotaLimit })
    .from(schema.channelQuotaUsage)
    .where(
      and(
        eq(schema.channelQuotaUsage.channelAccountId, accountId),
        eq(schema.channelQuotaUsage.period, period),
      ),
    )
    .for('update');
  if (row === undefined) throw new Error('channel_quota_usage row is missing after insert');
  return row;
}

/** Adds `delta` (negative to give a reservation back) to the counter; never below zero. */
export async function moveQuota(
  tx: DbTransaction,
  accountId: string,
  period: string,
  delta: number,
  now: Date,
): Promise<void> {
  await tx
    .update(schema.channelQuotaUsage)
    .set({
      used: sql`GREATEST(${schema.channelQuotaUsage.used} + ${delta}, 0)`,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.channelQuotaUsage.channelAccountId, accountId),
        eq(schema.channelQuotaUsage.period, period),
      ),
    );
}

/**
 * Billing month `YYYY-MM` of a counter row in the instance's business zone (Bangkok, `[VERIFY]` whether
 * LINE counts in it). The worker passes `line.quotaPeriod` from `packages/channels`, which this package
 * does not import; this default keeps the domain usable alone.
 */
export function billingPeriod(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (year === undefined || month === undefined) throw new Error('cannot format quota period');
  return `${year}-${month}`;
}
