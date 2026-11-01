import { ChannelError, line } from '@watchtower/channels';
import type { Database } from '@watchtower/db';
import { schema } from '@watchtower/db';
import { lockQuota } from '@watchtower/domain';
import { AUDIT_ACTIONS } from '@watchtower/shared';
import { and, eq } from 'drizzle-orm';

import type { WorkerLogger } from '../logger.js';
import type { LineTransportFor } from './transports.js';

/**
 * The hourly reconcile of the LINE push counter (ADR-010 section 6, R-2.10). The local counter is
 * exact for what Watchtower sent and blind to what was sent from LINE Official Account Manager;
 * LINE's consumption number is the other way round and approximate. `used` becomes the larger of the
 * two, so the warning at 80% is never late, and the limit becomes whatever LINE reports (a plan with
 * no target limit keeps the allowance the counter was created with).
 *
 * Read-only toward LINE (`GET /v2/bot/message/quota` and `.../quota/consumption`). With no transport
 * for an account nothing is done for it.
 */

export interface ReconcileDeps {
  readonly database: Database;
  readonly transportFor: LineTransportFor | undefined;
  readonly logger: WorkerLogger;
  readonly now?: () => Date;
}

export interface ReconcileResult {
  readonly accounts: number;
  readonly reconciled: number;
  readonly skipped: number;
  readonly failed: number;
}

export function createQuotaReconciler(deps: ReconcileDeps) {
  const now = deps.now ?? ((): Date => new Date());

  async function reconcileAccount(account: { id: string; type: string }): Promise<boolean> {
    const transport = deps.transportFor?.(account);
    if (transport === undefined) return false;
    const [quota, consumption] = [await transport.getQuota(), await transport.getConsumption()];
    const at = now();
    const period = line.quotaPeriod(at);
    await deps.database.db.transaction(async (tx) => {
      const local = await lockQuota(tx, account.id, period, line.FALLBACK_QUOTA_LIMIT);
      const next = line.reconcileQuota(local, {
        totalUsage: consumption.totalUsage,
        limit: line.resolveQuotaLimit(quota, local.limit),
      });
      await tx
        .update(schema.channelQuotaUsage)
        .set({ used: next.used, quotaLimit: next.limit, reconciledAt: at, updatedAt: at })
        .where(
          and(
            eq(schema.channelQuotaUsage.channelAccountId, account.id),
            eq(schema.channelQuotaUsage.period, period),
          ),
        );
      await tx.insert(schema.auditLog).values({
        actorType: 'system',
        actorId: null,
        action: AUDIT_ACTIONS.lineQuotaReconciled,
        outcome: 'success',
        targetType: 'channel_account',
        targetId: account.id,
        // Numbers only: no recipient, no message.
        metadata: {
          period,
          localUsed: local.used,
          remoteUsed: consumption.totalUsage,
          used: next.used,
          limit: next.limit,
        },
      });
    });
    return true;
  }

  return async function reconcile(): Promise<ReconcileResult> {
    const accounts = await deps.database.db
      .select({ id: schema.channelAccount.id, type: schema.channelAccount.type })
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.type, 'line'));
    let reconciled = 0;
    let skipped = 0;
    let failed = 0;
    for (const account of accounts) {
      try {
        if (await reconcileAccount(account)) reconciled += 1;
        else skipped += 1;
      } catch (error) {
        // One account's outage must not stop the others; the next hour tries again.
        failed += 1;
        deps.logger.warn(
          {
            channelAccountId: account.id,
            kind: error instanceof ChannelError ? error.kind : 'error',
          },
          'LINE quota reconcile failed',
        );
      }
    }
    return { accounts: accounts.length, reconciled, skipped, failed };
  };
}
