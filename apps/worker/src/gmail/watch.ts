import { ChannelError } from '@watchtower/channels';
import { schema, type Database } from '@watchtower/db';
import { recordAuditInTx, type Domain } from '@watchtower/domain';
import { AUDIT_ACTIONS } from '@watchtower/shared';
import { eq, sql } from 'drizzle-orm';

import type { WorkerLogger } from '../logger.js';
import { isInvalidGrant } from './not-connected.js';
import type { GmailRuntime } from './runtime.js';
import { watchRequestFor } from './sync.js';

/**
 * `users.watch` for the mailboxes, once a day (PRD R-2.1). A watch lasts 7 days at most and fails
 * silently when it lapses, so it is renewed daily rather than when it is about to expire
 * (https://developers.google.com/workspace/gmail/api/guides/push, read 2026-10-31 `[CONFIRMED]`).
 * A failed renewal marks the mailbox unhealthy and is audited; the job then fails so BullMQ retries
 * it with backoff, and the heartbeat (R-2.8) keeps an eye on the result.
 */

const SYSTEM_ACTOR = { type: 'system', id: null } as const;

export interface RenewResult {
  readonly status: 'renewed' | 'skipped' | 'no_topic' | 'no_transport';
  readonly expiresAt?: Date;
}

export interface GmailWatch {
  renewAccount(accountId: string): Promise<RenewResult>;
  /** Every enabled mailbox. Throws after trying all of them when any failed (the job is retried). */
  renewAll(): Promise<{ readonly renewed: number; readonly skipped: number }>;
}

export interface GmailWatchDeps {
  readonly database: Database;
  readonly domain: Domain;
  readonly runtime: GmailRuntime;
  /** `projects/<project>/topics/<topic>`; absent in mock mode (no Pub/Sub): nothing to renew. */
  readonly topicName: string | undefined;
  readonly logger: WorkerLogger;
  readonly now?: () => Date;
}

export function createGmailWatch(deps: GmailWatchDeps): GmailWatch {
  const now = deps.now ?? ((): Date => new Date());
  const { database, logger } = deps;

  async function markFailed(accountId: string, error: unknown): Promise<void> {
    // The refresh token was refused: the token provider already marked the mailbox not connected
    // (health, code, one audit entry). A watch failure on top would only bury that reason.
    if (isInvalidGrant(error)) return;
    const code = error instanceof ChannelError ? `channel_${error.kind}` : 'watch_error';
    const ctx = deps.domain.context({ actor: SYSTEM_ACTOR });
    await database.db.transaction(async (tx) => {
      await tx
        .update(schema.gmailAccountState)
        .set({ lastErrorCode: 'watch_failed', updatedAt: now() })
        .where(eq(schema.gmailAccountState.channelAccountId, accountId));
      await tx
        .update(schema.channelAccount)
        .set({ health: 'unhealthy', updatedAt: now() })
        .where(eq(schema.channelAccount.id, accountId));
      await recordAuditInTx(
        tx,
        ctx,
        { audited: false },
        {
          action: AUDIT_ACTIONS.gmailWatchFailed,
          outcome: 'failure',
          targetType: 'channel_account',
          targetId: accountId,
          metadata: { code },
        },
      );
    });
  }

  async function renewAccount(accountId: string): Promise<RenewResult> {
    if (deps.topicName === undefined) return { status: 'no_topic' };
    const [state] = await database.db
      .select({ enabled: schema.gmailAccountState.enabled })
      .from(schema.gmailAccountState)
      .where(eq(schema.gmailAccountState.channelAccountId, accountId))
      .limit(1);
    if (state === undefined || !state.enabled) return { status: 'skipped' };
    const transport = await deps.runtime.transportFor({ id: accountId });
    if (transport === undefined) return { status: 'no_transport' };
    try {
      const watched = await transport.watch(watchRequestFor(deps.topicName));
      const expiresAt = new Date(Number(watched.expiration));
      await database.db
        .update(schema.gmailAccountState)
        .set({
          watchExpiresAt: expiresAt,
          watchRenewedAt: now(),
          // A watch that works clears the error it was blamed for; a sync error clears on the next sync.
          lastErrorCode: sql`CASE WHEN ${schema.gmailAccountState.lastErrorCode} = 'watch_failed' THEN NULL ELSE ${schema.gmailAccountState.lastErrorCode} END`,
          updatedAt: now(),
        })
        .where(eq(schema.gmailAccountState.channelAccountId, accountId));
      return { status: 'renewed', expiresAt };
    } catch (error) {
      logger.warn({ err: error, accountId }, 'gmail watch renewal failed');
      await markFailed(accountId, error);
      throw error;
    }
  }

  return {
    renewAccount,
    async renewAll() {
      const rows = await database.db
        .select({ id: schema.gmailAccountState.channelAccountId })
        .from(schema.gmailAccountState)
        .where(eq(schema.gmailAccountState.enabled, true));
      let renewed = 0;
      let skipped = 0;
      let failure: Error | undefined;
      for (const row of rows) {
        try {
          const result = await renewAccount(row.id);
          if (result.status === 'renewed') renewed += 1;
          else skipped += 1;
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error('watch renewal failed');
        }
      }
      if (failure !== undefined) throw failure;
      return { renewed, skipped };
    },
  };
}
