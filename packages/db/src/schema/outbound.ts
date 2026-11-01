// Outbound delivery (T-122d, migration 0010, ADR-010). Mirrors the SQL by hand; the SQL file is the
// source of truth (CHECKs, partial indexes, column-level privileges and the generated hash live there).
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { channelAccount, message, ticket } from './ticketing.js';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * An AI-written draft and the approval of exactly that text. `contentHash` is computed by the
 * database from `bodyText` (sha256, hex; a trigger), so the approval cannot drift from the text
 * (ADR-011 A-2).
 * Named `ai_draft` for T-106/T-108, which fill it; this task only reads and approves.
 */
export const aiDraft = pgTable(
  'ai_draft',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => ticket.id, { onDelete: 'restrict' }),
    bodyText: text('body_text').notNull(),
    // Set by a trigger on INSERT (sha256 of the UTF-8 body, hex); whatever an insert says is overwritten.
    contentHash: text('content_hash').notNull().default(''),
    /** `draft`, `approved`, `sent` or `rejected`. */
    status: text('status').notNull().default('draft'),
    aiRunId: uuid('ai_run_id'),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamptz('approved_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [index('ai_draft_ticket_idx').on(table.ticketId, table.createdAt)],
);

/** The source of truth of a message on its way to a customer; the outbox only triggers it. */
export const outboundDelivery = pgTable(
  'outbound_delivery',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => ticket.id, { onDelete: 'restrict' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'restrict' }),
    channelAccountId: uuid('channel_account_id')
      .notNull()
      .references(() => channelAccount.id, { onDelete: 'restrict' }),
    channel: text('channel').notNull(),
    route: text('route'),
    origin: text('origin').notNull(),
    templateKey: text('template_key'),
    /** Inputs the acknowledgment was rendered from; the dispatcher renders again and compares (review O-4). */
    renderInputs: jsonb('render_inputs'),
    aiDraftId: uuid('ai_draft_id').references(() => aiDraft.id, { onDelete: 'restrict' }),
    contentHash: text('content_hash').notNull(),
    approvedBy: uuid('approved_by'),
    state: text('state').notNull().default('scheduled'),
    holdSeconds: integer('hold_seconds').notNull(),
    nextAttemptAt: timestamptz('next_attempt_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    leaseUntil: timestamptz('lease_until'),
    /** Claim fencing: a fresh uuid per claim, required by every write after it (review O-1). */
    claimToken: uuid('claim_token'),
    dispatchedAt: timestamptz('dispatched_at'),
    providerMessageId: text('provider_message_id'),
    rfc822MessageId: text('rfc822_message_id'),
    providerThreadId: text('provider_thread_id'),
    errorCode: text('error_code'),
    outcomeUnknown: boolean('outcome_unknown').notNull().default(false),
    createdBy: uuid('created_by'),
    cancelledBy: uuid('cancelled_by'),
    cancelledAt: timestamptz('cancelled_at'),
    sentAt: timestamptz('sent_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('outbound_delivery_message_active_key')
      .on(table.messageId)
      .where(sql`${table.state} NOT IN ('failed', 'cancelled')`),
    uniqueIndex('outbound_delivery_draft_active_key')
      .on(table.aiDraftId)
      .where(sql`${table.aiDraftId} IS NOT NULL AND ${table.state} NOT IN ('failed', 'cancelled')`),
    index('outbound_delivery_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.state} = 'scheduled'`),
    index('outbound_delivery_lease_idx')
      .on(table.leaseUntil)
      .where(sql`${table.state} = 'sending'`),
    index('outbound_delivery_ticket_idx').on(table.ticketId, table.createdAt),
    index('outbound_delivery_account_idx').on(table.channelAccountId, table.updatedAt.desc()),
    index('outbound_delivery_rfc822_idx')
      .on(table.channelAccountId, table.rfc822MessageId)
      .where(sql`${table.rfc822MessageId} IS NOT NULL`),
  ],
);

/** LINE push messages counted per account and month (R-2.10). */
export const channelQuotaUsage = pgTable(
  'channel_quota_usage',
  {
    channelAccountId: uuid('channel_account_id')
      .notNull()
      .references(() => channelAccount.id, { onDelete: 'restrict' }),
    period: text('period').notNull(),
    used: integer('used').notNull().default(0),
    quotaLimit: integer('quota_limit'),
    reconciledAt: timestamptz('reconciled_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.channelAccountId, table.period] })],
);

/** Instance-wide settings. Rows are created by migrations; the application only changes `value`. */
export const instanceSetting = pgTable('instance_setting', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export type AiDraftRow = typeof aiDraft.$inferSelect;
export type OutboundDeliveryRow = typeof outboundDelivery.$inferSelect;
export type ChannelQuotaUsageRow = typeof channelQuotaUsage.$inferSelect;

/** Keys of the automatic acknowledgments the database lets through (review O-3); read-only for the application. */
export const outboundTemplateAllowlist = pgTable('outbound_template_allowlist', {
  key: text('key').primaryKey(),
});
