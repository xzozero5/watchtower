// Investigation tools (T-203): the shared rate budget (migration 0050), saved templates and evidence cards
// (migration 0051). Mirrors the SQL by hand; the SQL file is the source of truth (CHECKs, partitioning).
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './auth.js';
import { incident } from './incident.js';
import { intent, ticket } from './ticketing.js';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * A sliding minute in one-second slots per resource (`logging:<project>`). `total` is every caller,
 * `ai` the AI's share of it. Written only by `acquireRateBudget` in `packages/domain`, with the
 * database clock, under an advisory lock per resource.
 */
export const rateBudgetWindow = pgTable(
  'rate_budget_window',
  {
    resource: text('resource').notNull(),
    slot: timestamptz('slot').notNull(),
    total: integer('total').notNull().default(0),
    ai: integer('ai').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.resource, table.slot] })],
);

/** A Cloud Logging filter (`logs`) or one SELECT (`data`) with `{{name}}` placeholders, per intent. */
export const toolTemplate = pgTable(
  'tool_template',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    title: text('title').notNull(),
    /** Null: offered on every ticket, never run by the AI. */
    intentId: uuid('intent_id').references(() => intent.id, { onDelete: 'restrict' }),
    body: text('body').notNull(),
    allowedColumns: text('allowed_columns')
      .array()
      .notNull()
      .default([] as string[]),
    runByAi: boolean('run_by_ai').notNull().default(true),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('tool_template_name_key').on(table.kind, table.name),
    index('tool_template_intent_idx').on(table.intentId),
  ],
);

/** What a run found, pinned to a ticket or an incident (exactly one). The excerpt is redacted. */
export const evidenceCard = pgTable(
  'evidence_card',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id').references(() => ticket.id, { onDelete: 'restrict' }),
    incidentId: uuid('incident_id').references(() => incident.id, { onDelete: 'restrict' }),
    /** `logs`, `data`, `repo` or `metrics`. */
    kind: text('kind').notNull(),
    templateId: uuid('template_id').references(() => toolTemplate.id, { onDelete: 'set null' }),
    templateName: text('template_name').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    excerpt: text('excerpt').notNull(),
    resultCount: integer('result_count').notNull(),
    truncated: boolean('truncated').notNull().default(false),
    maskedColumns: text('masked_columns')
      .array()
      .notNull()
      .default([] as string[]),
    windowFrom: timestamptz('window_from'),
    windowTo: timestamptz('window_to'),
    paramsHash: text('params_hash').notNull(),
    resultHash: text('result_hash').notNull(),
    mock: boolean('mock').notNull().default(false),
    runKey: text('run_key').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('evidence_card_ticket_idx').on(table.ticketId, table.createdAt.desc()),
    index('evidence_card_incident_idx').on(table.incidentId, table.createdAt.desc()),
  ],
);

export type ToolTemplateRow = typeof toolTemplate.$inferSelect;
export type EvidenceCardRow = typeof evidenceCard.$inferSelect;
