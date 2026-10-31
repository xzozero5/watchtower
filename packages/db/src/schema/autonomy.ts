// Autonomy history and the global AI switches (T-112a, migration 0007, ADR-011). The SQL file is
// the source of truth (CHECKs, triggers, privileges and set_intent_autonomy() live there).
// `intent.autonomyStage` / `autonomyPinned` are columns of the `intent` table in `./ticketing.ts`.
import { boolean, index, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { intent } from './ticketing.js';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Append-only (trigger + no INSERT/UPDATE/DELETE for the application role). */
export const intentAutonomyHistory = pgTable(
  'intent_autonomy_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => intent.id, { onDelete: 'restrict' }),
    /** `stage`, `pin` or `unpin`. */
    change: text('change').notNull(),
    fromStage: smallint('from_stage').notNull(),
    toStage: smallint('to_stage').notNull(),
    /** The pin state after this change. */
    pinned: boolean('pinned').notNull(),
    reason: text('reason').notNull(),
    changedBy: uuid('changed_by').notNull(),
    changedAt: timestamptz('changed_at').notNull().defaultNow(),
  },
  (table) => [index('intent_autonomy_history_intent_idx').on(table.intentId, table.changedAt)],
);

/** Two rows, seeded by the migration: `ai_stage_cap_pinned` and `ai_kill_switch`. */
export const aiSwitch = pgTable('ai_switch', {
  key: text('key').primaryKey(),
  isOn: boolean('is_on').notNull().default(false),
  reason: text('reason').notNull().default(''),
  changedBy: uuid('changed_by'),
  changedAt: timestamptz('changed_at').notNull().defaultNow(),
});
