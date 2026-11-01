import { ChannelError } from '@watchtower/channels';
import { schema, type Database } from '@watchtower/db';
import {
  ALERT_CHAT_CLAIM_LEASE_SECONDS,
  ALERT_CHAT_RETRY_MAX_SECONDS,
  alertSeveritySchema,
  type AlertChatJob,
  type AlertChatState,
  type EscalationTarget,
} from '@watchtower/shared';
import { and, asc, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';

import type { WorkerLogger } from '../logger.js';
import type { AlertChatMessage, AlertChatPort } from './chat.js';

/**
 * Posts one escalation step to chat (T-201d). The ledger is `alert_escalation.chat_*`.
 *
 * Rules that matter, in the order they bite:
 * 1. **Sent means delivered.** A row says `sent` only when the port reported `delivered: true`. The
 *    in-memory fake records `mock`, and the table refuses a message id or delivery time on it.
 * 2. **Claimed before the post.** `pending` -> `sending` in one conditional update, so two workers
 *    never post the same step. If the worker dies after the claim, the post may or may not have been
 *    made; the sweep then marks it `failed` (`outcome_unknown`). A page is not posted twice on a
 *    guess: the in-app notification was already made in the escalation's own transaction and the next
 *    step of the policy goes to somebody else.
 * 3. **Not acknowledged any more means not posted.** A step whose alert was acknowledged (or resolved)
 *    before the post is `skipped` (`not_open`): a "please ack" for an acknowledged alert is noise.
 * 4. **One clock.** Every time compared here (is the retry due, is the claim stale, is the step too
 *    old) is the database's `clock_timestamp()` inside the statement that decides.
 */

export type ChatMode = 'live' | 'fake';

export type ChatOutcome =
  | { readonly status: 'missing' }
  | { readonly status: 'already'; readonly was: AlertChatState }
  | { readonly status: 'not_due' }
  | { readonly status: 'posted'; readonly state: AlertChatState }
  | { readonly status: 'retry'; readonly code: string };

export interface ChatSweepResult {
  /** Claims a dead worker left, turned into an honest `failed` (`outcome_unknown`). */
  readonly recovered: number;
  /** Posts still owed past `retryMaxSeconds`, given up. */
  readonly expired: number;
  /** Due posts handed to `post` again. */
  readonly redriven: number;
}

export interface AlertChatNotifierDeps {
  readonly database: Pick<Database, 'db'>;
  readonly logger: WorkerLogger;
  readonly chat: AlertChatPort;
  /** `APP_URL`, for the link in the message. */
  readonly appUrl: string;
  readonly isProduction: boolean;
  readonly claimLeaseSeconds?: number;
  readonly retryMaxSeconds?: number;
}

const table = schema.alertEscalation;

/** What a settled post writes. Times are SQL (the database clock), never a value from this process. */
interface Patch {
  readonly chatState: AlertChatState;
  readonly chatErrorCode?: string | null;
  readonly chatSentAt?: SQL;
  readonly chatNextAttemptAt?: SQL;
  readonly chatChannelId?: string | null;
  readonly chatMessageId?: string | null;
}
const dbNow = sql`clock_timestamp()`;

/** 5 s, doubling, at most 5 minutes; a longer `Retry-After` from the chat service wins. */
export function chatBackoffMs(attempts: number): number {
  return Math.min(5 * 60 * 1000, 5000 * 2 ** Math.max(0, attempts - 1));
}

export function createAlertChatNotifier(deps: AlertChatNotifierDeps) {
  const { logger, chat } = deps;
  const db = deps.database.db;
  const claimLeaseSeconds = deps.claimLeaseSeconds ?? ALERT_CHAT_CLAIM_LEASE_SECONDS;
  const retryMaxSeconds = deps.retryMaxSeconds ?? ALERT_CHAT_RETRY_MAX_SECONDS;
  let announced = false;

  function announce(): void {
    if (announced) return;
    announced = true;
    logger.info(
      { mode: chat.kind },
      chat.kind === 'live'
        ? 'alert chat: LIVE'
        : 'alert chat: FAKE (no bot configured), nothing is sent',
    );
  }

  async function settle(id: string, patch: Patch): Promise<void> {
    // A database error must never be turned into "the post failed" (it may well have been made), so
    // try a few times and otherwise leave the claim for the sweep to call an unknown outcome.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await db
          .update(table)
          .set({ ...patch, chatClaimedAt: null })
          .where(and(eq(table.id, id), eq(table.chatState, 'sending')));
        return;
      } catch (error) {
        logger.error({ err: error, escalationId: id, attempt }, 'alert chat ledger write failed');
      }
    }
  }

  async function post(job: AlertChatJob): Promise<ChatOutcome> {
    const [row] = await db
      .select({
        id: table.id,
        state: table.chatState,
        target: table.target,
        fallback: table.fallback,
        recipientIds: table.recipientIds,
        attempts: table.chatAttempts,
        alertState: schema.alert.state,
        severity: schema.alert.severity,
        count: schema.alert.count,
        serviceName: schema.service.name,
      })
      .from(table)
      .innerJoin(schema.alert, eq(schema.alert.id, table.alertId))
      .leftJoin(schema.service, eq(schema.service.id, schema.alert.serviceId))
      .where(and(eq(table.alertId, job.alertId), eq(table.level, job.level)))
      .limit(1);
    if (row === undefined) return { status: 'missing' };
    if (row.state !== 'pending') return { status: 'already', was: row.state as AlertChatState };

    // Claim: one conditional update, due by the database clock.
    const [claimed] = await db
      .update(table)
      .set({
        chatState: 'sending',
        chatClaimedAt: dbNow,
        chatAttempts: sql`${table.chatAttempts} + 1`,
      })
      .where(
        and(
          eq(table.id, row.id),
          eq(table.chatState, 'pending'),
          sql`${table.chatNextAttemptAt} <= clock_timestamp()`,
        ),
      )
      .returning({ attempts: table.chatAttempts });
    if (claimed === undefined) return { status: 'not_due' };

    if (row.alertState !== 'open') {
      await settle(row.id, { chatState: 'skipped', chatErrorCode: 'not_open' });
      return { status: 'posted', state: 'skipped' };
    }

    const mentions =
      row.recipientIds.length === 0
        ? []
        : (
            await db
              .select({ discordUserId: schema.users.discordUserId })
              .from(schema.users)
              .where(
                and(
                  inArray(schema.users.id, row.recipientIds),
                  isNotNull(schema.users.discordUserId),
                ),
              )
          ).flatMap((person) => (person.discordUserId === null ? [] : [person.discordUserId]));
    const message: AlertChatMessage = {
      alertId: job.alertId,
      level: job.level,
      target: row.target as EscalationTarget,
      severity: alertSeveritySchema.catch('unknown').parse(row.severity),
      serviceName: row.serviceName,
      count: row.count,
      fallback: row.fallback !== null,
      mentionUserIds: mentions,
      link: new URL(`/alerts/${job.alertId}`, deps.appUrl).toString(),
    };
    announce();
    const log = {
      alertId: job.alertId,
      level: job.level,
      mode: chat.kind,
      attempts: claimed.attempts,
    };

    try {
      const result = await chat.postEscalation(message);
      if (result.delivered) {
        logger.info({ ...log, state: 'sent' }, 'alert chat: step posted');
        await settle(row.id, {
          chatState: 'sent',
          chatErrorCode: null,
          chatSentAt: dbNow,
          chatChannelId: result.channelId,
          chatMessageId: result.messageId,
        });
        return { status: 'posted', state: 'sent' };
      }
      const text = 'alert chat: step recorded by the fake, NOT delivered (no bot configured)';
      if (deps.isProduction) logger.warn({ ...log, state: 'mock' }, text);
      else logger.info({ ...log, state: 'mock' }, text);
      await settle(row.id, { chatState: 'mock', chatErrorCode: null });
      return { status: 'posted', state: 'mock' };
    } catch (error) {
      const failure = error instanceof ChannelError ? error : undefined;
      const code = failure?.code ?? failure?.kind ?? 'internal_error';
      if (failure?.kind === 'rate_limited') {
        // Nothing was posted: try again when the chat service says, or after the backoff.
        const delayMs = Math.max(failure.retryAfterMs ?? 0, chatBackoffMs(claimed.attempts));
        logger.warn({ ...log, code, delayMs }, 'alert chat: rate limited, will retry');
        await settle(row.id, {
          chatState: 'pending',
          chatErrorCode: code,
          chatNextAttemptAt: sql`clock_timestamp() + make_interval(secs => ${delayMs / 1000})`,
        });
        return { status: 'retry', code };
      }
      // Everything else ends this step's post. An unknown outcome is not retried (rule 2).
      const unknown = failure === undefined || failure.outcomeUnknown;
      logger.error({ ...log, code, unknown }, 'alert chat: step not posted');
      await settle(row.id, {
        chatState: 'failed',
        chatErrorCode: unknown ? 'outcome_unknown' : code,
      });
      return { status: 'posted', state: 'failed' };
    }
  }

  /**
   * Housekeeping (every sweep tick): gives up on posts owed past their age, turns claims a dead
   * worker left into an honest unknown outcome, and re-drives the retries that are due.
   */
  async function sweep(limit = 20): Promise<ChatSweepResult> {
    const expired = await db
      .update(table)
      .set({ chatState: 'failed', chatErrorCode: 'expired', chatClaimedAt: null })
      .where(
        and(
          eq(table.chatState, 'pending'),
          sql`${table.createdAt} < clock_timestamp() - make_interval(secs => ${retryMaxSeconds})`,
        ),
      )
      .returning({ id: table.id });
    const recovered = await db
      .update(table)
      .set({ chatState: 'failed', chatErrorCode: 'outcome_unknown', chatClaimedAt: null })
      .where(
        and(
          eq(table.chatState, 'sending'),
          sql`${table.chatClaimedAt} < clock_timestamp() - make_interval(secs => ${claimLeaseSeconds})`,
        ),
      )
      .returning({ id: table.id });
    const due = await db
      .select({ alertId: table.alertId, level: table.level })
      .from(table)
      .where(
        and(eq(table.chatState, 'pending'), sql`${table.chatNextAttemptAt} <= clock_timestamp()`),
      )
      .orderBy(asc(table.chatNextAttemptAt))
      .limit(limit);
    let redriven = 0;
    for (const item of due) {
      try {
        await post({ alertId: item.alertId, level: item.level });
        redriven += 1;
      } catch (error) {
        logger.error({ err: error, alertId: item.alertId }, 'alert chat sweep could not re-drive');
      }
    }
    return { recovered: recovered.length, expired: expired.length, redriven };
  }

  return { post, sweep };
}

export type AlertChatNotifier = ReturnType<typeof createAlertChatNotifier>;
