import { ChannelError, discord, type FetchLike } from '@watchtower/channels';
import { schema, type CredentialStore, type Database } from '@watchtower/db';
import {
  DISCORD_SLOT_CREDENTIAL_FIELDS,
  DISCORD_WEBHOOK_SLOTS,
  channelTypeSchema,
  formatTicketKey,
  matchDiscordRoutes,
  ticketPrioritySchema,
  type DiscordChannelMap,
  type DiscordNotifyJob,
  type DiscordWebhookSlot,
} from '@watchtower/shared';
import { and, eq } from 'drizzle-orm';

import type { WorkerLogger } from '../logger.js';

/**
 * Posts domain events to Discord webhooks (T-104c). One event can go to several channels (the
 * channel map); each (event, ticket, slot) has one ledger row (`discord_notification`) that says
 * what really happened.
 *
 * The rule that matters most here: **a ledger row says `sent` only when a live transport reported
 * `delivered: true`.** With no webhook configured the notifier runs the in-memory transport on
 * purpose, says so in the log, and records `mock`; a mock row has no delivery time (the table
 * refuses one). A deployment that forgot its webhook therefore never looks like it is notifying.
 *
 * Delivery guarantees, stated plainly: at least once. A post has no idempotency key at Discord, so
 * an unknown outcome (timeout, 5xx) that is retried may produce a second message in the channel. For
 * an internal notice that is the better failure than a lost one `[ASSUMED]`; the row records
 * `outcome_unknown`. A `sent`, `mock`, `skipped` or `failed` row is never posted again.
 */

export type DiscordMode = 'live' | 'mock';

export type SlotOutcome =
  | { readonly slot: DiscordWebhookSlot; readonly state: 'sent' | 'mock' | 'skipped' | 'failed' }
  | { readonly slot: DiscordWebhookSlot; readonly state: 'pending'; readonly retryAfterMs: number }
  | { readonly slot: DiscordWebhookSlot; readonly state: 'already'; readonly was: string };

export interface NotifyResult {
  readonly status: 'processed' | 'ticket_missing' | 'no_route';
  readonly mode: DiscordMode;
  readonly slots: readonly SlotOutcome[];
}

/** Thrown after the loop when a slot still needs another attempt, so the queue retries with backoff. */
export class DiscordRetryError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super('A Discord post needs another attempt');
    this.name = 'DiscordRetryError';
    this.retryAfterMs = retryAfterMs;
  }
}

export interface DiscordOverrides {
  /** Replaces the credential store: the webhook URL of each slot. Tests use it. */
  readonly webhookUrls?: () => Promise<Partial<Record<DiscordWebhookSlot, string>>>;
  /** The `fetch` the live transport uses. Tests pass a scripted one so nothing touches the network. */
  readonly fetch?: FetchLike;
  /** Replaces the live transport itself (for example a `FakeDiscordTransport` to see what would be posted). */
  readonly liveTransport?: discord.DiscordTransport;
  readonly now?: () => Date;
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

export function createDiscordNotifier(deps: DiscordNotifierDeps) {
  const { logger } = deps;
  const now = deps.overrides?.now ?? ((): Date => new Date());
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
    } else if (deps.isProduction) {
      logger.warn(
        { mode },
        'discord notifications: MOCK in production, no webhook is configured; nothing is delivered (rows are recorded as mock)',
      );
    } else {
      logger.info({ mode }, 'discord notifications: MOCK (no webhook configured), nothing is sent');
    }
  }

  /** Inserts the ledger row once and returns it. */
  async function ledgerRow(job: DiscordNotifyJob, slot: DiscordWebhookSlot) {
    const dedupeKey = `${job.event}:${job.ticketId}:${slot}`;
    await deps.database.db
      .insert(schema.discordNotification)
      .values({ dedupeKey, event: job.event, ticketId: job.ticketId, slot })
      .onConflictDoNothing({ target: schema.discordNotification.dedupeKey });
    const [row] = await deps.database.db
      .select()
      .from(schema.discordNotification)
      .where(eq(schema.discordNotification.dedupeKey, dedupeKey))
      .limit(1);
    if (row === undefined) throw new Error('discord_notification row is missing after insert');
    return row;
  }

  type Patch = Partial<
    Pick<
      typeof schema.discordNotification.$inferInsert,
      'state' | 'errorCode' | 'outcomeUnknown' | 'providerMessageId' | 'sentAt'
    >
  >;

  /** Compare-and-set on `pending`: a row someone else already settled is left alone. */
  async function settle(id: string, attempts: number, patch: Patch): Promise<void> {
    await deps.database.db
      .update(schema.discordNotification)
      .set({ ...patch, attempts, updatedAt: now() })
      .where(
        and(eq(schema.discordNotification.id, id), eq(schema.discordNotification.state, 'pending')),
      );
  }

  async function notify(
    job: DiscordNotifyJob,
    attempt: { readonly final: boolean },
  ): Promise<NotifyResult> {
    const [ticket] = await deps.database.db
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
      const attempts = row.attempts + 1;
      const log = {
        ticketId: ticket.id,
        event: job.event,
        slot,
        routes: match.routes,
        mode,
        attempts,
      };

      let transport: discord.DiscordTransport;
      let webhook: discord.DiscordWebhook;
      if (mode === 'mock') {
        transport = mockTransport;
        webhook = mockWebhook();
      } else {
        const url = urls[slot];
        if (url === undefined) {
          await settle(row.id, attempts, { state: 'skipped', errorCode: 'slot_not_configured' });
          logger.warn(
            { ...log, code: 'slot_not_configured' },
            'discord notice skipped: no webhook for this slot',
          );
          slots.push({ slot, state: 'skipped' });
          continue;
        }
        const parsed = discord.DiscordWebhook.tryParse(url);
        if (parsed === undefined) {
          // Stable code only; the URL (a secret) and the parse reason text are not logged.
          await settle(row.id, attempts, { state: 'failed', errorCode: 'invalid_webhook_url' });
          logger.error(
            { ...log, code: 'invalid_webhook_url' },
            'discord notice failed: the configured webhook URL is not a discord.com webhook',
          );
          slots.push({ slot, state: 'failed' });
          continue;
        }
        transport = live();
        webhook = parsed;
      }

      try {
        const result = await transport.execute(webhook, message);
        if (result.delivered) {
          await settle(row.id, attempts, {
            state: 'sent',
            errorCode: null,
            sentAt: now(),
            providerMessageId: result.messageId,
          });
          logger.info({ ...log, state: 'sent' }, 'discord notice sent');
          slots.push({ slot, state: 'sent' });
        } else {
          // Recorded in memory, delivered nowhere: never `sent`.
          await settle(row.id, attempts, { state: 'mock', errorCode: null });
          logger.info(
            { ...log, state: 'mock' },
            'discord notice recorded by the mock transport, NOT delivered',
          );
          slots.push({ slot, state: 'mock' });
        }
      } catch (error) {
        const channelError = error instanceof ChannelError ? error : undefined;
        const code = channelError?.code ?? channelError?.kind ?? 'internal_error';
        const retryable = channelError === undefined ? true : channelError.retryable;
        if (retryable && !attempt.final) {
          await settle(row.id, attempts, {
            state: 'pending',
            errorCode: code,
            outcomeUnknown: channelError?.outcomeUnknown ?? false,
          });
          logger.warn(
            { ...log, code, retryAfterMs: channelError?.retryAfterMs },
            'discord notice not delivered yet, will retry',
          );
          slots.push({ slot, state: 'pending', retryAfterMs: channelError?.retryAfterMs ?? 0 });
        } else {
          await settle(row.id, attempts, {
            state: 'failed',
            errorCode: code,
            outcomeUnknown: channelError?.outcomeUnknown ?? false,
          });
          logger.error({ ...log, code }, 'discord notice failed');
          slots.push({ slot, state: 'failed' });
        }
      }
    }
    return { status: 'processed', mode, slots };
  }

  return { notify, mockTransport };
}

export type DiscordNotifier = ReturnType<typeof createDiscordNotifier>;
