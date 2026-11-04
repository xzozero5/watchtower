// Reports (T-305b migration 0099, T-305c migration 0101). The SQL file is the source of truth for the CHECKs.
import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './auth.js';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * A data point of a pluggable CEO tile: a number the system does not compute (uptime from monitoring,
 * revenue, churn), recorded through the API or a CSV import.
 */
export const ceoExternalPoint = pgTable(
  'ceo_external_point',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    metricKey: text('metric_key').notNull(),
    label: text('label').notNull(),
    unit: text('unit').notNull().default(''),
    higherIsBetter: boolean('higher_is_better').notNull().default(true),
    value: doublePrecision('value').notNull(),
    observedAt: timestamptz('observed_at').notNull(),
    source: text('source').notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('ceo_external_point_key_time_key').on(table.metricKey, table.observedAt),
    index('ceo_external_point_latest_idx').on(table.metricKey, table.observedAt.desc()),
  ],
);

export type CeoExternalPointRow = typeof ceoExternalPoint.$inferSelect;

/**
 * The AI-drafted weekly brief of the CEO view (T-305c, migration 0101). One row per weekly slot. `aiContent` is
 * what the model wrote and never changes; `content` is what the head edits; a published row is final (a trigger
 * refuses any change). The SQL file is the source of truth for the CHECKs and the trigger.
 */
export const weeklyBrief = pgTable(
  'weekly_brief',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slotDate: date('slot_date', { mode: 'string' }).notNull(),
    periodFrom: timestamptz('period_from').notNull(),
    periodTo: timestamptz('period_to').notNull(),
    /** `draft` or `published`. */
    status: text('status').notNull().default('draft'),
    /** `th` or `en`. */
    locale: text('locale').notNull().default('en'),
    /** `ai` or `data_only` (the figures only: the AI was off, over budget or gave nothing usable). */
    source: text('source').notNull(),
    reasonCode: text('reason_code'),
    figures: jsonb('figures').notNull(),
    content: jsonb('content').notNull(),
    aiContent: jsonb('ai_content').notNull(),
    aiRunId: uuid('ai_run_id'),
    promptVersion: integer('prompt_version'),
    mock: boolean('mock').notNull().default(false),
    editedBy: uuid('edited_by').references(() => users.id, { onDelete: 'set null' }),
    editedAt: timestamptz('edited_at'),
    recipients: text('recipients')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    publishedBy: uuid('published_by').references(() => users.id, { onDelete: 'set null' }),
    publishedAt: timestamptz('published_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('weekly_brief_slot_key').on(table.slotDate),
    index('weekly_brief_status_idx').on(table.status, table.slotDate.desc()),
  ],
);

export type WeeklyBriefRow = typeof weeklyBrief.$inferSelect;
