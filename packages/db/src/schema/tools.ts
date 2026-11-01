// Investigation tools (T-203): the shared rate budget (migration 0050). Mirrors the SQL by hand; the SQL
// file is the source of truth (CHECKs, partitioning).
import { integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

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
