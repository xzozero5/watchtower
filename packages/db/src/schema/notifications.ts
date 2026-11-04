// Notifications and preferences (T-105, migration 0032). Mirrors the SQL by hand; the SQL file is
// the source of truth (CHECKs, column-level privileges).
import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './auth.js';
import { ticket } from './ticketing.js';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * One alert for one person. Ids and counts only (no subject, no name, no message text); the center
 * joins the ticket at read time. `orgId`, `queueId` and `channel` are facets copied from the ticket
 * so a filter can count without it. The application may change only `readAt`.
 */
export const notification = pgTable(
  'notification',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    /** The same alert for the same person is made once. */
    dedupeKey: text('dedupe_key').notNull(),
    ticketId: uuid('ticket_id').references(() => ticket.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id'),
    queueId: uuid('queue_id'),
    channel: text('channel'),
    data: jsonb('data')
      .$type<Record<string, string | number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    readAt: timestamptz('read_at'),
  },
  (table) => [
    uniqueIndex('notification_user_dedupe').on(table.userId, table.dedupeKey),
    index('notification_user_created_idx').on(
      table.userId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index('notification_user_unread_idx')
      .on(table.userId, table.createdAt.desc())
      .where(sql`${table.readAt} IS NULL`),
    index('notification_created_idx').on(table.createdAt),
  ],
);

/** A person's choice per kind. No row means the default (on). */
export const notificationPreference = pgTable(
  'notification_preference',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    inApp: boolean('in_app').notNull().default(true),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.kind] })],
);

/**
 * One browser's Web Push subscription (migration 0105). `endpoint` is a capability URL: the API never
 * returns it and nothing logs it. `failureCount` is permanent failures in a row.
 */
export const webPushSubscription = pgTable(
  'web_push_subscription',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    lastSuccessAt: timestamptz('last_success_at'),
    failureCount: integer('failure_count').notNull().default(0),
  },
  (table) => [
    uniqueIndex('web_push_subscription_endpoint_unique').on(table.endpoint),
    index('web_push_subscription_user_idx').on(table.userId),
  ],
);
