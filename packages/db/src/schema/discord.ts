// Discord notify ledger (T-104, migration 0015). Mirrors the SQL by hand; the SQL file is the source
// of truth (CHECKs, column-level privileges).
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { ticket } from './ticketing.js';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * One post of one event to one destination slot. `state` is `pending`, `sent` (Discord accepted
 * it), `mock` (the in-memory transport recorded it; nothing was delivered), `skipped` (no webhook
 * for the slot) or `failed`. Ids and codes only: no ticket text, no webhook URL.
 */
export const discordNotification = pgTable(
  'discord_notification',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** `<event>:<ticket id>:<slot>`. */
    dedupeKey: text('dedupe_key').notNull(),
    event: text('event').notNull(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => ticket.id, { onDelete: 'restrict' }),
    /** A destination name from the channel map, never a URL. */
    slot: text('slot').notNull(),
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    errorCode: text('error_code'),
    outcomeUnknown: boolean('outcome_unknown').notNull().default(false),
    providerMessageId: text('provider_message_id'),
    sentAt: timestamptz('sent_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('discord_notification_dedupe_key').on(table.dedupeKey),
    index('discord_notification_ticket_idx').on(table.ticketId, table.createdAt),
    index('discord_notification_open_idx')
      .on(table.createdAt)
      .where(sql`${table.state} IN ('pending', 'failed')`),
  ],
);

export type DiscordNotificationRow = typeof discordNotification.$inferSelect;
