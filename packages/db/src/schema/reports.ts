// Reports (T-305b, migration 0099). The SQL file is the source of truth for the CHECKs.
import {
  boolean,
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

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
