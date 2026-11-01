import { schema, enqueueOutbox, type Database } from '@watchtower/db';
import { recordAuditInTx, type Domain } from '@watchtower/domain';
import {
  AUDIT_ACTIONS,
  GMAIL_JOBS,
  GMAIL_QUEUES,
  GMAIL_SYNC_OUTBOX_JOB_OPTIONS,
  slaMinutesBetween,
  type GmailSyncJob,
} from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import type { WorkerLogger } from '../logger.js';
import type { GmailWatch } from './watch.js';

/**
 * Heartbeat of the push channel (PRD R-2.8): "if no inbound mail is observed for a configurable
 * window during business hours, raise an internal alert (Gmail watch may have expired)".
 *
 * For every enabled mailbox: the time since the last verified push, counted in BUSINESS minutes of
 * the instance's default calendar (so a silent night or weekend is not a symptom), against
 * `GMAIL_HEARTBEAT_STALE_MINUTES` `[ASSUMED]`; also a watch whose expiry has passed. When stale:
 *   - `channel_account.health` becomes `unhealthy` and ONE `gmail.heartbeat_stale` audit entry is
 *     written when it changes (the alert; delivery to Discord / notifications arrives with T-104 /
 *     T-105 and reads this state), plus a warning in the log;
 *   - a `sync` job is queued anyway (the mail may be there even though the push was lost) and an
 *     expired watch is renewed right away.
 * A push brings the mailbox back (the receiver sets `healthy`); so does a quiet heartbeat once the
 * mailbox has no recorded error.
 */

const SYSTEM_ACTOR = { type: 'system', id: null } as const;
const SYNC_BUCKET_MS = 10 * 60 * 1000;

export interface HeartbeatResult {
  readonly checked: number;
  readonly stale: readonly string[];
  readonly recovered: readonly string[];
}

export interface GmailHeartbeat {
  run(): Promise<HeartbeatResult>;
}

export interface GmailHeartbeatDeps {
  readonly database: Database;
  readonly domain: Domain;
  readonly watch: GmailWatch;
  /** Business minutes without a push before a mailbox is stale. */
  readonly staleMinutes: number;
  readonly logger: WorkerLogger;
  readonly now?: () => Date;
}

export function createGmailHeartbeat(deps: GmailHeartbeatDeps): GmailHeartbeat {
  const now = deps.now ?? ((): Date => new Date());
  const { database, logger } = deps;

  return {
    async run() {
      const at = now();
      const calendar = await deps.domain.sla.calendarFor(database.db, null);
      const rows = await database.db
        .select({
          state: schema.gmailAccountState,
          health: schema.channelAccount.health,
        })
        .from(schema.gmailAccountState)
        .innerJoin(
          schema.channelAccount,
          eq(schema.channelAccount.id, schema.gmailAccountState.channelAccountId),
        )
        .where(eq(schema.gmailAccountState.enabled, true));

      const stale: string[] = [];
      const recovered: string[] = [];
      for (const { state, health } of rows) {
        const accountId = state.channelAccountId;
        const since = state.lastPushAt ?? state.createdAt;
        const quietMinutes = slaMinutesBetween(since, at, 'business', calendar);
        const watchLapsed = state.watchExpiresAt !== null && state.watchExpiresAt <= at;
        const isStale = quietMinutes >= deps.staleMinutes || watchLapsed;

        if (isStale) {
          stale.push(accountId);
          const ctx = deps.domain.context({ actor: SYSTEM_ACTOR });
          const syncJob: GmailSyncJob = { channelAccountId: accountId, reason: 'heartbeat' };
          await database.db.transaction(async (tx) => {
            if (health !== 'unhealthy') {
              await tx
                .update(schema.channelAccount)
                .set({ health: 'unhealthy', updatedAt: at })
                .where(eq(schema.channelAccount.id, accountId));
              await recordAuditInTx(
                tx,
                ctx,
                { audited: false },
                {
                  action: AUDIT_ACTIONS.gmailHeartbeatStale,
                  outcome: 'failure',
                  targetType: 'channel_account',
                  targetId: accountId,
                  metadata: {
                    quietBusinessMinutes: Math.floor(quietMinutes),
                    thresholdMinutes: deps.staleMinutes,
                    neverPushed: state.lastPushAt === null,
                    watchLapsed,
                  },
                },
              );
            }
            // One catch-up sync per mailbox per 10 minutes, however often the heartbeat runs.
            await enqueueOutbox(tx, {
              queue: GMAIL_QUEUES.gmail,
              jobName: GMAIL_JOBS.sync,
              jobId: `heartbeat-${accountId}-${String(Math.floor(at.getTime() / SYNC_BUCKET_MS))}`,
              payload: syncJob,
              options: { ...GMAIL_SYNC_OUTBOX_JOB_OPTIONS },
            });
          });
          if (health !== 'unhealthy') {
            logger.warn(
              { accountId, quietBusinessMinutes: Math.floor(quietMinutes), watchLapsed },
              'gmail push is quiet: the watch may have expired',
            );
          }
          if (watchLapsed) {
            await deps.watch.renewAccount(accountId).catch((error: unknown) => {
              logger.warn({ err: error, accountId }, 'gmail watch renewal from heartbeat failed');
            });
          }
        } else if (health === 'unhealthy' && state.lastErrorCode === null) {
          recovered.push(accountId);
          await database.db
            .update(schema.channelAccount)
            .set({ health: 'healthy', updatedAt: at })
            .where(eq(schema.channelAccount.id, accountId));
        }
      }
      return { checked: rows.length, stale, recovered };
    },
  };
}
