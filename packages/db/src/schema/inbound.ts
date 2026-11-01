import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { channelAccount, message, ticket } from './ticketing.js';

/**
 * Mirrors migrations/0008_inbound.sql (T-122c, ADR-009). The SQL file is the source of truth (check
 * constraints, partial indexes and column-level privileges live there); keep both in step by hand
 * and let the integration tests catch drift.
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** One provider notification (a Pub/Sub message, one LINE webhook event). Unique per provider id. */
export const inboundEvent = pgTable(
  'inbound_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelAccountId: uuid('channel_account_id')
      .notNull()
      .references(() => channelAccount.id, { onDelete: 'restrict' }),
    providerEventId: text('provider_event_id').notNull(),
    receivedAt: timestamptz('received_at').notNull().defaultNow(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    rawObjectKey: text('raw_object_key'),
    status: text('status').notNull().default('pending'),
    errorCode: text('error_code'),
    processedAt: timestamptz('processed_at'),
  },
  (table) => [
    uniqueIndex('inbound_event_provider_key').on(table.channelAccountId, table.providerEventId),
    index('inbound_event_pending_idx')
      .on(table.receivedAt)
      .where(sql`${table.status} = 'pending'`),
    index('inbound_event_retention_idx')
      .on(table.receivedAt)
      .where(sql`${table.status} <> 'pending'`),
  ],
);

/** One received message and what became of it. The rows that are not ticket-bound are "Other mail". */
export const inboundMessage = pgTable(
  'inbound_message',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelAccountId: uuid('channel_account_id')
      .notNull()
      .references(() => channelAccount.id, { onDelete: 'restrict' }),
    inboundEventId: uuid('inbound_event_id').references(() => inboundEvent.id, {
      onDelete: 'set null',
    }),
    providerMessageId: text('provider_message_id').notNull(),
    rfc822MessageId: text('rfc822_message_id'),
    threadKey: text('thread_key'),
    threadCandidates: jsonb('thread_candidates')
      .notNull()
      .default(sql`'[]'::jsonb`),
    fromAddress: text('from_address'),
    fromName: text('from_name'),
    lineUserId: text('line_user_id'),
    subject: text('subject').notNull().default(''),
    bodyText: text('body_text').notNull().default(''),
    bodyHtml: text('body_html'),
    attachments: jsonb('attachments')
      .notNull()
      .default(sql`'[]'::jsonb`),
    receivedAt: timestamptz('received_at').notNull(),
    rawObjectKey: text('raw_object_key'),
    automated: jsonb('automated')
      .notNull()
      .default(sql`'{}'::jsonb`),
    classification: jsonb('classification')
      .notNull()
      .default(sql`'{}'::jsonb`),
    disposition: text('disposition').notNull().default('pending'),
    ticketId: uuid('ticket_id').references(() => ticket.id, { onDelete: 'restrict' }),
    messageId: uuid('message_id').references(() => message.id, { onDelete: 'restrict' }),
    dispositionBy: text('disposition_by'),
    dispositionAt: timestamptz('disposition_at'),
    convertedFrom: text('converted_from'),
    /** LINE reply token, sealed (T-122d, migration 0010); cleared when the dispatcher spends it. */
    replyTokenSealed: text('reply_token_sealed'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('inbound_message_provider_key').on(table.channelAccountId, table.providerMessageId),
    index('inbound_message_other_idx')
      .on(table.disposition, table.receivedAt.desc())
      .where(sql`${table.disposition} IN ('noise', 'auto_reply', 'internal')`),
    index('inbound_message_rfc822_idx')
      .on(table.channelAccountId, table.rfc822MessageId)
      .where(sql`${table.rfc822MessageId} IS NOT NULL`),
    index('inbound_message_event_idx')
      .on(table.inboundEventId)
      .where(sql`${table.inboundEventId} IS NOT NULL`),
    index('inbound_message_ticket_idx')
      .on(table.ticketId)
      .where(sql`${table.ticketId} IS NOT NULL`),
    index('inbound_message_message_idx')
      .on(table.messageId)
      .where(sql`${table.messageId} IS NOT NULL`),
    index('inbound_message_pending_idx')
      .on(table.createdAt)
      .where(sql`${table.disposition} = 'pending'`),
  ],
);

export type InboundEventRow = typeof inboundEvent.$inferSelect;
export type InboundMessageRow = typeof inboundMessage.$inferSelect;
