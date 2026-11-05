// The AI assistant and the claim-shaped AI summaries (T-134/T-135, ADR-023, migration 0090). Mirrors
// the SQL by hand; the SQL file is the source of truth (CHECKs, foreign keys).
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './auth.js';
import { ticket } from './ticketing.js';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** One thread of one person with the assistant. Deleted after the retention period. */
export const assistantConversation = pgTable(
  'assistant_conversation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull().default('en'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('assistant_conversation_user_idx').on(table.userId, table.updatedAt.desc()),
    index('assistant_conversation_created_idx').on(table.createdAt),
  ],
);

/** What was said, redacted (N4), and the meter of the model calls behind an assistant turn. */
export const assistantMessage = pgTable(
  'assistant_message',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => assistantConversation.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().$type<'user' | 'assistant'>(),
    body: text('body').notNull(),
    context: jsonb('context')
      .notNull()
      .default({})
      .$type<{ page?: string; ticket?: string; entity?: { kind: string; ref: string } }>(),
    /** The evidence of an answer as `{kind, id}` only (ADR-029 section 3); label and href are rebuilt on read. */
    evidence: jsonb('evidence')
      .notNull()
      .default([])
      .$type<{ kind: string; id: string; claim?: number }[]>(),
    /** How the turn was answered; null for the turns before migration 0112. */
    path: text('path').$type<'facts_only' | 'llm1' | 'llm2'>(),
    tools: jsonb('tools')
      .notNull()
      .default([])
      .$type<{ name: string; status: 'ok' | 'error' | 'denied'; mock: boolean }[]>(),
    aiRunIds: uuid('ai_run_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 14, scale: 8 }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('assistant_message_conversation_idx').on(table.conversationId, table.createdAt),
    index('assistant_message_user_idx').on(table.userId, table.createdAt.desc()),
  ],
);

/** A write the assistant proposed: used once, by its owner, before it expires. */
export const assistantProposal = pgTable(
  'assistant_proposal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => assistantConversation.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').references(() => assistantMessage.id, { onDelete: 'set null' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('pending'),
    ticketId: uuid('ticket_id').references(() => ticket.id, { onDelete: 'cascade' }),
    params: jsonb('params').notNull().$type<Record<string, unknown>>(),
    card: jsonb('card').notNull().$type<Record<string, unknown>>(),
    baseUpdatedAt: timestamptz('base_updated_at'),
    expiresAt: timestamptz('expires_at').notNull(),
    decidedAt: timestamptz('decided_at'),
    failCode: text('fail_code'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('assistant_proposal_user_idx').on(table.userId, table.createdAt.desc()),
    index('assistant_proposal_conversation_idx').on(table.conversationId),
  ],
);

/** What a person has used of the assistant today. Apart from the conversations: deleting one gives nothing back. */
export const assistantUsage = pgTable(
  'assistant_usage',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    messages: integer('messages').notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 14, scale: 8 }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.day] })],
);

/** The latest AI summary of a screen for one person, and the fingerprint of the facts behind it. */
export const aiSummary = pgTable(
  'ai_summary',
  {
    kind: text('kind').notNull().$type<'brief' | 'handoff' | 'my_work'>(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull().default('en').$type<'th' | 'en'>(),
    fingerprint: text('fingerprint').notNull(),
    claims: jsonb('claims').notNull().$type<unknown[]>(),
    aiRunId: uuid('ai_run_id'),
    mock: boolean('mock').notNull().default(false),
    dataAsOf: timestamptz('data_as_of').notNull(),
    generatedAt: timestamptz('generated_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.kind, table.userId, table.locale] })],
);

/** What a person pinned for the assistant to remember (ADR-029 section 3, migration 0112). Redacted text of the answer only; expires 90 days from `createdAt`. */
export const assistantMemory = pgTable(
  'assistant_memory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    refs: jsonb('refs').notNull().default([]).$type<{ kind: string; id: string }[]>(),
    sourceMessageId: uuid('source_message_id').references(() => assistantMessage.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    lastUsedAt: timestamptz('last_used_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (table) => [
    index('assistant_memory_user_idx').on(table.userId, table.createdAt.desc()),
    index('assistant_memory_expires_idx').on(table.expiresAt),
  ],
);

/** A thumbs-up or -down on an answer of the assistant or on an embedded insight (ADR-029 section 5, migration 0114). No text. */
export const assistantFeedback = pgTable(
  'assistant_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetKind: text('target_kind').notNull().$type<'message' | 'insight'>(),
    /** No foreign key: the target outlives (or is outlived by) the rating on purpose. */
    targetId: uuid('target_id').notNull(),
    element: text('element'),
    rating: text('rating').notNull().$type<'up' | 'down'>(),
    reason: text('reason'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [index('assistant_feedback_updated_idx').on(table.updatedAt)],
);
