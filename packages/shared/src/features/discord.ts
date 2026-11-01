/**
 * Discord notifications (T-104): this feature's own audit actions, ticket event types and queue names (T-123a).
 *
 * The task that owns this feature adds entries here and nowhere else in `packages/shared`. The
 * global `AUDIT_ACTIONS`, `TICKET_EVENT_TYPES` and `QUEUE_NAMES` are composed from these records
 * (see `./index.ts`), and importing `@watchtower/shared` throws if two features use the same key
 * or the same value. Keys are camelCase; values are lowercase strings (dotted for audit actions and
 * ticket events, the BullMQ queue name for queues). Start a value with the feature name so
 * collisions are unlikely.
 *
 * Discord is a notification and coordination channel, not a system of record (po decision #6).
 * Phase 1 sends one-way webhook posts only; the bot, buttons and `/ack` are T-202.
 */
import { z } from 'zod';

import { channelTypeSchema } from '../channels.js';
import { ticketPrioritySchema, TICKET_PRIORITIES, type TicketPriority } from '../sla.js';

/** Audit `action` strings written by this feature. */
export const DISCORD_AUDIT_ACTIONS = {} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const DISCORD_TICKET_EVENTS = {} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (producer: api and worker, consumer: worker). */
export const DISCORD_QUEUES = {
  discord: 'discord',
} as const satisfies Record<string, string>;

export const DISCORD_JOBS = {
  /** Post one domain event to the Discord channels the channel map selects. `jobId` is per event and ticket. */
  notify: 'notify',
  /** Re-drives owed posts that are due, recovers abandoned claims, gives up on the ones past their age. */
  sweep: 'sweep',
} as const;

/** How long a post is retried before it is given up (`failed`, code `expired`). `[ASSUMED]` one day: an outage should not lose a P1 notice. */
export const DISCORD_RETRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A claim (`sending`) older than this belongs to a worker that died. */
export const DISCORD_CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * BullMQ priority of a notify job (lower runs first). Every job gets one, because BullMQ runs jobs
 * without a priority before all prioritized ones: a P1 notice then goes ahead of a backlog of P3s.
 */
export function discordNotifyPriority(priority: TicketPriority): number {
  return TICKET_PRIORITIES.indexOf(priority) + 1;
}

/**
 * Domain events that can be posted. `[ASSUMED]` Phase 1 posts one: a ticket was created (PRD
 * section 5.1 step C, R-3.17). Alerts and incidents come with Phase 2; add the event name here
 * first, then the trigger in the domain, then a formatter in `packages/channels`.
 */
export const DISCORD_NOTIFY_EVENTS = ['ticket.created'] as const;
export type DiscordNotifyEvent = (typeof DISCORD_NOTIFY_EVENTS)[number];
export const discordNotifyEventSchema = z.enum(DISCORD_NOTIFY_EVENTS);

/** Payload of a `notify` job: ids only. The worker loads the ticket, so no customer text rides the queue. */
export const discordNotifyJobSchema = z.object({
  event: discordNotifyEventSchema,
  ticketId: z.uuid(),
});
export type DiscordNotifyJob = z.infer<typeof discordNotifyJobSchema>;

/** A post to Discord has no idempotency key, so retries are bounded and the ledger row decides. */
export const DISCORD_OUTBOX_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

/** The BullMQ job id of one event on one ticket: the same event is queued once. */
export function discordNotifyJobId(event: DiscordNotifyEvent, ticketId: string): string {
  return `discord-${event.replace('.', '-')}-${ticketId}`;
}

// --- destinations -------------------------------------------------------------------------------

/**
 * A destination is a named slot, never a URL: the channel map (plain configuration) says which
 * events go to which slot, and the slot's webhook URL is a credential (ADR-004, ADR-012). Two slots
 * are enough for Phase 1: everyday traffic and urgent traffic. Add a slot here and a field in the
 * credential catalog together (a test keeps them in step).
 */
export const DISCORD_WEBHOOK_SLOTS = ['default', 'urgent'] as const;
export type DiscordWebhookSlot = (typeof DISCORD_WEBHOOK_SLOTS)[number];
export const discordWebhookSlotSchema = z.enum(DISCORD_WEBHOOK_SLOTS);

/** The credential field (integration `discord`) that holds each slot's webhook URL. */
export const DISCORD_SLOT_CREDENTIAL_FIELDS = {
  default: 'webhookUrl',
  urgent: 'webhookUrlUrgent',
} as const satisfies Record<DiscordWebhookSlot, string>;

// --- channel map --------------------------------------------------------------------------------

export const discordRouteSchema = z.object({
  /** Shown in logs only. */
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  slot: discordWebhookSlotSchema,
  /** Default: every event. */
  events: z.array(discordNotifyEventSchema).min(1).optional(),
  /** This priority or more urgent (P1 is the most urgent). Default: every priority. */
  minPriority: ticketPrioritySchema.optional(),
  /** Only tickets that arrived through one of these channels. Default: every channel. */
  channels: z.array(channelTypeSchema).min(1).optional(),
});
export type DiscordRoute = z.infer<typeof discordRouteSchema>;

export const discordChannelMapSchema = z.object({
  routes: z.array(discordRouteSchema).min(1).max(20),
});
export type DiscordChannelMap = z.infer<typeof discordChannelMapSchema>;

/**
 * What an instance gets when `DISCORD_CHANNEL_MAP` is empty: every new ticket to the default slot.
 * `[ASSUMED]` The urgent slot exists only when an operator writes a map that names it.
 */
export const DEFAULT_DISCORD_CHANNEL_MAP: DiscordChannelMap = {
  routes: [{ name: 'all-tickets', slot: 'default', events: ['ticket.created'] }],
};

/** What a route is matched against. Identifiers and enums only. */
export interface DiscordEventFacts {
  readonly event: DiscordNotifyEvent;
  readonly priority: TicketPriority;
  readonly channel: z.infer<typeof channelTypeSchema>;
}

export interface DiscordRouteMatch {
  readonly slot: DiscordWebhookSlot;
  /** Names of the routes that selected this slot (a slot is posted to once per event). */
  readonly routes: readonly string[];
}

/**
 * Fan-out: every route that matches selects its slot; a slot selected by several routes is posted
 * to once. Order follows the first route that named the slot.
 */
export function matchDiscordRoutes(
  map: DiscordChannelMap,
  facts: DiscordEventFacts,
): DiscordRouteMatch[] {
  const rank = (priority: TicketPriority): number => TICKET_PRIORITIES.indexOf(priority);
  const bySlot = new Map<DiscordWebhookSlot, string[]>();
  for (const route of map.routes) {
    if (route.events !== undefined && !route.events.includes(facts.event)) continue;
    if (route.minPriority !== undefined && rank(facts.priority) > rank(route.minPriority)) continue;
    if (route.channels !== undefined && !route.channels.includes(facts.channel)) continue;
    const names = bySlot.get(route.slot);
    if (names === undefined) bySlot.set(route.slot, [route.name]);
    else names.push(route.name);
  }
  return [...bySlot].map(([slot, routes]) => ({ slot, routes }));
}

/** Thrown for an invalid `DISCORD_CHANNEL_MAP`. Never repeats the text it was given. */
export class DiscordChannelMapError extends Error {
  constructor(readonly reason: 'not_json' | 'invalid_shape') {
    super(`DISCORD_CHANNEL_MAP is not valid (${reason})`);
    this.name = 'DiscordChannelMapError';
  }
}

/** Parses the JSON text of `DISCORD_CHANNEL_MAP`. */
export function parseDiscordChannelMap(text: string): DiscordChannelMap {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DiscordChannelMapError('not_json');
  }
  const parsed = discordChannelMapSchema.safeParse(json);
  if (!parsed.success) throw new DiscordChannelMapError('invalid_shape');
  return parsed.data;
}

// --- delivery ledger ----------------------------------------------------------------------------

/**
 * State of one post (`discord_notification.state`):
 * - `pending`: not delivered yet, due at `next_attempt_at`;
 * - `sending`: claimed before the post is made. A claim that is never settled means the worker died
 *   after (or before) the post: the outcome is unknown and the row says so;
 * - `sent`: Discord accepted it (a live transport);
 * - `mock`: the in-memory transport recorded it. NOTHING was delivered. Kept apart from `sent` so a
 *   deployment that forgot to set a webhook never looks healthy;
 * - `skipped`: no webhook for this slot, so nothing was tried;
 * - `failed`: gave up.
 */
export const DISCORD_NOTIFICATION_STATES = [
  'pending',
  'sending',
  'sent',
  'mock',
  'skipped',
  'failed',
] as const;
export type DiscordNotificationState = (typeof DISCORD_NOTIFICATION_STATES)[number];
