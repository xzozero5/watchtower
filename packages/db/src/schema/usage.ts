// Product usage metrics, anomalies and the Client Health Score (T-205, migrations 0061 to 0063). Mirrors the
// SQL by hand; the SQL file is the source of truth (CHECKs, the monthly partitions of the points).
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { alert } from './alerting.js';
import { users } from './auth.js';
import { organization, ticket } from './ticketing.js';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** A metric: a read-only SQL template and the dimensions it may return. Only a head edits it. */
export const usageMetricDef = pgTable(
  'usage_metric_def',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    sqlTemplate: text('sql_template').notNull(),
    templateVersion: integer('template_version').notNull().default(1),
    /** Declared dimension columns; `org` carries an organization id. */
    dims: text('dims').array().notNull().default([]),
    unit: text('unit').notNull().default('count'),
    refreshIntervalSeconds: integer('refresh_interval_seconds').notNull().default(3600),
    /** `up` (a rise is the problem) or `down`. */
    direction: text('direction').notNull().default('up'),
    anomalyRatio: numeric('anomaly_ratio', { precision: 6, scale: 2 }).notNull().default('3'),
    anomalyMinAbs: numeric('anomaly_min_abs', { precision: 14, scale: 2 }).notNull().default('10'),
    active: boolean('active').notNull().default(true),
    lastRunAt: timestamptz('last_run_at'),
    /** `ok` or `failed`. */
    lastRunState: text('last_run_state'),
    /** A stable code, never the text of a database error. */
    lastRunError: text('last_run_error'),
    lastRunPoints: integer('last_run_points'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('usage_metric_def_key_key').on(table.key)],
);

/** One hourly value of one series, partitioned by month on `ts`. Upserted: a repeated run replaces it. */
export const usageMetricPoint = pgTable(
  'usage_metric_point',
  {
    metricId: uuid('metric_id')
      .notNull()
      .references(() => usageMetricDef.id, { onDelete: 'cascade' }),
    ts: timestamptz('ts').notNull(),
    dimsHash: text('dims_hash').notNull(),
    orgId: uuid('org_id').references(() => organization.id, { onDelete: 'cascade' }),
    dims: jsonb('dims').notNull().default({}),
    value: doublePrecision('value').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.metricId, table.ts, table.dimsHash] }),
    index('usage_metric_point_org_idx').on(table.orgId, table.metricId, table.ts.desc()),
  ],
);

/** An anomaly the rule found; `dedupe_key` makes it one alert and one ticket per series per day. */
export const usageAnomaly = pgTable(
  'usage_anomaly',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    metricId: uuid('metric_id')
      .notNull()
      .references(() => usageMetricDef.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').references(() => organization.id, { onDelete: 'cascade' }),
    dimsHash: text('dims_hash').notNull(),
    dims: jsonb('dims').notNull().default({}),
    bucketTs: timestamptz('bucket_ts').notNull(),
    observed: doublePrecision('observed').notNull(),
    baseline: doublePrecision('baseline').notNull(),
    baselineSamples: smallint('baseline_samples').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    alertId: uuid('alert_id').references(() => alert.id, { onDelete: 'set null' }),
    ticketId: uuid('ticket_id').references(() => ticket.id, { onDelete: 'set null' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('usage_anomaly_dedupe_key').on(table.dedupeKey),
    index('usage_anomaly_list_idx').on(table.createdAt.desc(), table.id.desc()),
  ],
);

/** The score of one organization on one UTC day under one formula version. `score` is null when not enough data. */
export const orgHealthSnapshot = pgTable(
  'org_health_snapshot',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    formulaVersion: integer('formula_version').notNull(),
    /** `scored` or `insufficient_data`. */
    status: text('status').notNull(),
    score: smallint('score'),
    components: jsonb('components').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.day, table.formulaVersion] }),
    index('org_health_snapshot_latest_idx').on(table.orgId, table.day.desc()),
  ],
);
