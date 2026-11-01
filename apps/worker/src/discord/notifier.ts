import { ChannelError, discord, type FetchLike } from '@watchtower/channels';
import { schema, type CredentialStore, type Database } from '@watchtower/db';
import {
  DISCORD_CLAIM_LEASE_MS,
  DISCORD_RETRY_MAX_AGE_MS,
  DISCORD_SLOT_CREDENTIAL_FIELDS,
  DISCORD_WEBHOOK_SLOTS,
  channelTypeSchema,
  discordNotifyEventSchema,
  formatTicketKey,
  matchDiscordRoutes,
  ticketPrioritySchema,
  type DiscordChannelMap,
  type DiscordNotifyJob,
  type DiscordWebhookSlot,
} from '@watchtower/shared';
import { and, asc, eq, lt, lte, sql } from 'drizzle-orm';

import type { WorkerLogger } from '../logger.js';

/**
 * Posts domain events to Discord webhooks (T-104c). One event can go to several channels (the
 * channel map); each (event, ticket, slot) has one ledger row (`discord_notification`) that says
 * what really happened.
 *
 * Two rules matter most here.
 *
 * 1. **A row says `sent` only when a live transport reported `delivered: true`.** With no webhook
 *    configured the notifier runs the in-memory transport on purpose, says so in the log on every
 *    post (a warning in production), and records `mock`; a mock row has no delivery time (the table
 *    refuses one).
 * 2. **The row is claimed (`sending`) before the post is made.** A post has no idempotency key at
 *    Discord, so the claim is what lets us say honestly what we do not know. If the worker dies after
 *    the claim, the post may or may not have happened: the sweep marks the row `outcome_unknown`.
 *
 * Delivery, stated plainly:
 * - a refusal that means "not processed" (429) is retried without limit until the row is older than
 *   `DISCORD_RETRY_MAX_AGE_MS`, then it is `failed` (`expired`);
 * - an answer that leaves the outcome unknown (timeout, network, 5xx, a dead worker) is retried
 *   **once**. So one slot gets at most two posts, and the row keeps `outcome_unknown = true`; a second
 *   unknown outcome ends as `failed` (`outcome_unknown`) and is not posted again;
 * - a refusal that will not change (deleted webhook, bad request) is `failed` at once.
 * `sent`, `mock`, `skipped` and `failed` rows are never posted again.
 */

export type DiscordMode = 'live' | 'mock';

export type SlotOutcome =
  | { readonly slot: DiscordWebhookSlot; readonly state: 'sent' | 'mock' | 'skipped' | 'failed' }
  | { readonly slot: DiscordWebhookSlot; readonly state: 'pending'; readonly retryAt: Date }
  | { readonly slot: DiscordWebhookSlot; readonly state: 'already'; readonly was: string };

export interface NotifyResult {
  readonly status: 'processed' | 'ticket_missing' | 'no_route';
  readonly mode: DiscordMode;
  readonly slots: readonly SlotOutcome[];
}

export interface SweepResult {
  /** Abandoned claims turned back into a retry (or a failure when the outcome was already unknown). */
  readonly recovered: number;
  /** Owed posts older than the retry age, given up. */
  readonly expired: number;
  /** Tickets whose due posts were re-driven. */
  readonly redriven: number;
}

export interface DiscordOverrides {
  /** Replaces the credential store: the webhook URL of each slot. Tests use it. */
  readonly webhookUrls?: () => Promise<Partial<Record<DiscordWebhookSlot, string>>>;
  /** The `fetch` the live transport uses. Tests pass a scripted one so nothing touches the network. */
  readonly fetch?: FetchLike;
  /** Replaces the live transport itself (for example a `FakeDiscordTransport` to see what would be posted). */
  readonly liveTransport?: discord.DiscordTransport;
  readonly now?: () => Date;
  readonly retryMaxAgeMs?: number;
  readonly claimLeaseMs?: number;
}

export interface DiscordNotifierDeps {
  readonly database: Pick<Database, 'db'>;
  readonly logger: WorkerLogger;
  readonly channelMap: DiscordChannelMap;
  readonly ticketKeyPrefix: string;
  /** Public address of this instance (`APP_URL`), for the link in the notice. */
  readonly appUrl: string;
  readonly isProduction: boolean;
  /** Where the webhook URLs come from; production: the credential store (env first, then the encrypted DB). */
  readonly credentials: Pick<CredentialStore, 'resolve'> | undefined;
  readonly overrides?: DiscordOverrides;
}

/** The webhook the mock transport is given. Obviously not a real one; built in pieces on purpose. */
function mockWebhook(): discord.DiscordWebhook {
  return discord.DiscordWebhook.parse(
    `https://discord.com/api/webhooks/${'1'.repeat(17)}/${'mock'.repeat(8)}`,
  );
}

/** 5 s, doubling, at most 5 minutes. A longer `Retry-After` from Discord wins. */
export function retryBackoffMs(attempts: number): number {
  return Math.min(5 * 60 * 1000, 5000 * 2 ** Math.max(0, attempts - 1));
}

export function createDiscordNotifier(deps: DiscordNotifierDeps) {
  const { logger } = deps;
  const db = deps.database.db;
  const now = deps.overrides?.now ?? ((): Date => new Date());
  const retryMaxAgeMs = deps.overrides?.retryMaxAgeMs ?? DISCORD_RETRY_MAX_AGE_MS;
  const claimLeaseMs = deps.overrides?.claimLeaseMs ?? DISCORD_CLAIM_LEASE_MS;
  const mockTransport = new discord.FakeDiscordTransport({ now, maxRecorded: 50 });
  let liveTransport: discord.DiscordTransport | undefined = deps.overrides?.liveTransport;
  let lastMode: DiscordMode | undefined;

  const live = (): discord.DiscordTransport => {
    liveTransport ??= new discord.LiveDiscordTransport({
      fetch: deps.overrides?.fetch ?? globalThis.fetch,
    });
    return liveTransport;
  };

  async function webhookUrls(): Promise<Partial<Record<DiscordWebhookSlot, string>>> {
    if (deps.overrides?.webhookUrls !== undefined) return deps.overrides.webhookUrls();
    if (deps.credentials === undefined) return {};
    const fields = await deps.credentials.resolve('discord');
    const urls: Partial<Record<DiscordWebhookSlot, string>> = {};
    for (const slot of DISCORD_WEBHOOK_SLOTS) {
      const value = fields[DISCORD_SLOT_CREDENTIAL_FIELDS[slot]]?.value;
      if (value !== undefined && value.trim() !== '') urls[slot] = value;
    }
    return urls;
  }

  function announceMode(mode: DiscordMode): void {
    if (mode === lastMode) return;
    lastMode = mode;
    if (mode === 'live') {
      logger.info({ mode }, 'discord notifications: LIVE (a webhook is configured)');
    } else {
      logger.info({ mode }, 'discord notifications: MOCK (no webhook configured), nothing is sent');
    }
  }

  type Row = typeof schema.discordNotification.$inferSelect;
  type Patch = Partial<
    Pick<
      typeof schema.discordNotification.$inferInsert,
      'state' | 'errorCode' | 'outcomeUnknown' | 'providerMessageId' | 'sentAt' | 'nextAttemptAt'
    >
  >;
  const table = schema.discordNotification;

  /** Inserts the ledger row once and returns it. */
  async function ledgerRow(job: DiscordNotifyJob, slot: DiscordWebhookSlot): Promise<Row> {
    const dedupeKey = `${job.event}:${job.ticketId}:${slot}`;
    await db
      .insert(table)
      // Times come from this process's clock, the same one the due check uses (not the database's).
      .values({
        dedupeKey,
        event: job.event,
        ticketId: job.ticketId,
        slot,
        createdAt: now(),
        nextAttemptAt: now(),
        updatedAt: now(),
      })
      .onConflictDoNothing({ target: table.dedupeKey });
    const [row] = await db.select().from(table).where(eq(table.dedupeKey, dedupeKey)).limit(1);
    if (row === undefined) throw new Error('discord_notification row is missing after insert');
    return row;
  }

  /** `pending` and due -> `sending`, in one statement: of two workers, one gets the row. */
  async function claim(row: Row): Promise<Row | undefined> {
    const at = now();
    const [claimed] = await db
      .update(table)
      .set({ state: 'sending', claimedAt: at, attempts: row.attempts + 1, updatedAt: at })
      .where(and(eq(table.id, row.id), eq(table.state, 'pending'), lte(table.nextAttemptAt, at)))
      .returning();
    return claimed;
  }

  /**
   * Records the outcome of a claimed row. A database error must never be turned into "the post
   * failed" (the post may well have been made), so this tries a few times and then leaves the row
   * `sending`: the sweep will mark it as an unknown outcome, which is the truth.
   */
  async function settle(row: Row, patch: Patch): Promise<boolean> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await db
          .update(table)
          .set({ ...patch, claimedAt: null, updatedAt: now() })
          .where(and(eq(table.id, row.id), eq(table.state, 'sending')));
        return true;
      } catch (error) {
        logger.error(
          { err: error, ticketId: row.ticketId, slot: row.slot, attempt },
          'discord ledger write failed after the post was attempted',
        );
      }
    }
    return false;
  }

  /** Marks a row that was never claimed (too old) as given up. */
  async function expire(row: Row): Promise<void> {
    await db
      .update(table)
      .set({ state: 'failed', errorCode: 'expired', claimedAt: null, updatedAt: now() })
      .where(and(eq(table.id, row.id), eq(table.state, 'pending')));
  }

  async function notify(job: DiscordNotifyJob): Promise<NotifyResult> {
    const [ticket] = await db
      .select({
        id: schema.ticket.id,
        number: schema.ticket.number,
        priority: schema.ticket.priority,
        channel: schema.ticket.channel,
      })
      .from(schema.ticket)
      .where(eq(schema.ticket.id, job.ticketId))
      .limit(1);
    if (ticket === undefined)
      return { status: 'ticket_missing', mode: lastMode ?? 'mock', slots: [] };

    const priority = ticketPrioritySchema.parse(ticket.priority);
    const channel = channelTypeSchema.parse(ticket.channel);
    const matches = matchDiscordRoutes(deps.channelMap, { event: job.event, priority, channel });
    const urls = await webhookUrls();
    const mode: DiscordMode = DISCORD_WEBHOOK_SLOTS.some((slot) => urls[slot] !== undefined)
      ? 'live'
      : 'mock';
    announceMode(mode);
    if (matches.length === 0) return { status: 'no_route', mode, slots: [] };

    const ticketKey = formatTicketKey(ticket.number, deps.ticketKeyPrefix);
    const message = discord.buildTicketCreatedMessage({
      ticketKey,
      priority,
      channel,
      link: new URL(`/tickets/${ticketKey}`, deps.appUrl).toString(),
      at: now(),
    });

    const slots: SlotOutcome[] = [];
    for (const match of matches) {
      const slot = match.slot;
      const row = await ledgerRow(job, slot);
      if (row.state !== 'pending') {
        slots.push({ slot, state: 'already', was: row.state });
        continue;
      }
      if (now().getTime() - row.createdAt.getTime() > retryMaxAgeMs) {
        await expire(row);
        logger.error(
          { ticketId: ticket.id, slot, code: 'expired' },
          'discord notice given up: too old',
        );
        slots.push({ slot, state: 'failed' });
        continue;
      }
      if (row.nextAttemptAt.getTime() > now().getTime()) {
        slots.push({ slot, state: 'pending', retryAt: row.nextAttemptAt });
        continue;
      }
      const claimed = await claim(row);
      if (claimed === undefined) {
        slots.push({ slot, state: 'already', was: 'sending' });
        continue;
      }
      slots.push(await post(claimed, match.routes, mode, urls[slot], message));
    }
    return { status: 'processed', mode, slots };
  }

  /** Makes the post for a row this worker holds the claim on, and settles the row. */
  async function post(
    row: Row,
    routes: readonly string[],
    mode: DiscordMode,
    url: string | undefined,
    message: discord.DiscordWebhookMessage,
  ): Promise<SlotOutcome> {
    const slot = row.slot as DiscordWebhookSlot;
    const log = {
      ticketId: row.ticketId,
      event: row.event,
      slot,
      routes,
      mode,
      attempts: row.attempts,
    };
    const give = async (patch: Patch, outcome: SlotOutcome): Promise<SlotOutcome> => {
      await settle(row, patch);
      return outcome;
    };

    let transport: discord.DiscordTransport;
    let webhook: discord.DiscordWebhook;
    if (mode === 'mock') {
      transport = mockTransport;
      webhook = mockWebhook();
    } else {
      if (url === undefined) {
        logger.warn(
          { ...log, code: 'slot_not_configured' },
          'discord notice skipped: no webhook for this slot',
        );
        return give(
          { state: 'skipped', errorCode: 'slot_not_configured' },
          { slot, state: 'skipped' },
        );
      }
      const parsed = discord.DiscordWebhook.tryParse(url);
      if (parsed === undefined) {
        // Stable code only; the URL (a secret) and the parse reason text are not logged.
        logger.error(
          { ...log, code: 'invalid_webhook_url' },
          'discord notice failed: the configured webhook URL is not a discord.com webhook',
        );
        return give(
          { state: 'failed', errorCode: 'invalid_webhook_url' },
          { slot, state: 'failed' },
        );
      }
      transport = live();
      webhook = parsed;
    }

    let result: discord.DiscordSendResult;
    try {
      result = await transport.execute(webhook, message);
    } catch (error) {
      const channelError = error instanceof ChannelError ? error : undefined;
      const code = channelError?.code ?? channelError?.kind ?? 'internal_error';
      // Unknown outcome: the post may have been made. A plain Error is treated the same way.
      const unknown = channelError === undefined ? true : channelError.outcomeUnknown;
      const retryable = channelError === undefined ? true : channelError.retryable;
      if (!retryable) {
        logger.error({ ...log, code }, 'discord notice failed');
        return give({ state: 'failed', errorCode: code }, { slot, state: 'failed' });
      }
      if (unknown && row.outcomeUnknown) {
        // Already unknown once: a third post is not worth the chance of a duplicate.
        logger.error(
          { ...log, code },
          'discord notice failed: outcome unknown twice, not posted again',
        );
        return give(
          { state: 'failed', errorCode: 'outcome_unknown', outcomeUnknown: true },
          { slot, state: 'failed' },
        );
      }
      const delay = Math.max(channelError?.retryAfterMs ?? 0, retryBackoffMs(row.attempts));
      const retryAt = new Date(now().getTime() + delay);
      logger.warn({ ...log, code, retryAt }, 'discord notice not delivered yet, will retry');
      return give(
        {
          state: 'pending',
          errorCode: code,
          nextAttemptAt: retryAt,
          // Never cleared: once a post may have been made, the row says so for good.
          ...(unknown ? { outcomeUnknown: true } : {}),
        },
        { slot, state: 'pending', retryAt },
      );
    }

    if (result.delivered) {
      logger.info({ ...log, state: 'sent' }, 'discord notice sent');
      return give(
        { state: 'sent', errorCode: null, sentAt: now(), providerMessageId: result.messageId },
        { slot, state: 'sent' },
      );
    }
    // Recorded in memory, delivered nowhere: never `sent`. Said every time, not once per process.
    const text =
      'discord notice recorded by the mock transport, NOT delivered (no webhook configured)';
    if (deps.isProduction) logger.warn({ ...log, state: 'mock' }, text);
    else logger.info({ ...log, state: 'mock' }, text);
    return give({ state: 'mock', errorCode: null }, { slot, state: 'mock' });
  }

  /**
   * Housekeeping, every minute (`schedules.ts`): gives up on owed posts past their age, turns
   * abandoned claims into an honest "outcome unknown", and re-drives due posts, most urgent ticket
   * first. This is what makes a retry survive a restart or a long outage.
   */
  async function sweep(limit = 50): Promise<SweepResult> {
    const at = now();
    const expired = await db
      .update(table)
      .set({ state: 'failed', errorCode: 'expired', claimedAt: null, updatedAt: at })
      .where(
        and(
          eq(table.state, 'pending'),
          lt(table.createdAt, new Date(at.getTime() - retryMaxAgeMs)),
        ),
      )
      .returning({ id: table.id });

    // A claim nobody settled: the worker died, and the post may or may not have been made.
    const recovered = await db
      .update(table)
      .set({
        state: sql`CASE WHEN ${table.outcomeUnknown} THEN 'failed' ELSE 'pending' END`,
        errorCode: sql`CASE WHEN ${table.outcomeUnknown} THEN 'outcome_unknown' ELSE 'abandoned_claim' END`,
        outcomeUnknown: true,
        claimedAt: null,
        nextAttemptAt: at,
        updatedAt: at,
      })
      .where(
        and(eq(table.state, 'sending'), lt(table.claimedAt, new Date(at.getTime() - claimLeaseMs))),
      )
      .returning({ id: table.id });

    const due = await db
      .selectDistinct({
        event: table.event,
        ticketId: table.ticketId,
        priority: schema.ticket.priority,
        createdAt: table.createdAt,
      })
      .from(table)
      .innerJoin(schema.ticket, eq(schema.ticket.id, table.ticketId))
      .where(
        and(
          eq(table.state, 'pending'),
          lte(table.nextAttemptAt, at),
          eq(table.event, 'ticket.created'),
        ),
      )
      .orderBy(asc(schema.ticket.priority), asc(table.createdAt))
      .limit(limit);
    let redriven = 0;
    for (const item of due) {
      const event = discordNotifyEventSchema.safeParse(item.event);
      if (!event.success) continue;
      try {
        await notify({ event: event.data, ticketId: item.ticketId });
        redriven += 1;
      } catch (error) {
        logger.error(
          { err: error, ticketId: item.ticketId },
          'discord sweep could not re-drive a ticket',
        );
      }
    }
    return { recovered: recovered.length, expired: expired.length, redriven };
  }

  return { notify, sweep, mockTransport };
}

export type DiscordNotifier = ReturnType<typeof createDiscordNotifier>;
