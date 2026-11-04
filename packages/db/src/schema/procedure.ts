// Procedures per intent (T-303b, migration 0097, ADR-026). The SQL file is the source of truth (the version
// number and steps_hash are computed by a trigger, CHECKs and privileges and the publish/retire functions live
// there); keep both in step by hand and let the integration tests catch drift.
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { intent } from './ticketing.js';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** One per intent. Never deleted. */
export const procedure = pgTable('procedure', {
  id: uuid('id').primaryKey().defaultRandom(),
  intentId: uuid('intent_id')
    .notNull()
    .unique('procedure_intent_key')
    .references(() => intent.id, { onDelete: 'restrict' }),
  createdBy: uuid('created_by'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  archivedAt: timestamptz('archived_at'),
});

/**
 * `draft -> confirmed -> simulated -> published -> retired`. `version` and `stepsHash` are set by the database
 * (what is passed on insert is ignored). Only a draft can change `sourceMd` / `steps`.
 */
export const procedureVersion = pgTable(
  'procedure_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    procedureId: uuid('procedure_id')
      .notNull()
      .references(() => procedure.id, { onDelete: 'restrict' }),
    version: integer('version').notNull().default(0),
    status: text('status').notNull().default('draft'),
    sourceMd: text('source_md').notNull().default(''),
    steps: jsonb('steps').notNull(),
    schemaVersion: smallint('schema_version').notNull().default(1),
    stepsHash: text('steps_hash')
      .notNull()
      .default(sql`repeat('0', 64)`),
    compiledByAiRunId: uuid('compiled_by_ai_run_id'),
    authoredBy: uuid('authored_by'),
    confirmedBy: uuid('confirmed_by'),
    confirmedAt: timestamptz('confirmed_at'),
    simulationId: uuid('simulation_id'),
    publishedBy: uuid('published_by'),
    publishedAt: timestamptz('published_at'),
    retiredBy: uuid('retired_by'),
    retiredAt: timestamptz('retired_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('procedure_version_number_key').on(table.procedureId, table.version),
    uniqueIndex('procedure_version_one_published')
      .on(table.procedureId)
      .where(sql`${table.status} = 'published'`),
  ],
);

/** Append-only. `stepsHash` is copied from the version by a trigger. Written by the simulation runner (T-303d). */
export const procedureSimulation = pgTable(
  'procedure_simulation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    procedureVersionId: uuid('procedure_version_id')
      .notNull()
      .references(() => procedureVersion.id, { onDelete: 'restrict' }),
    stepsHash: text('steps_hash')
      .notNull()
      .default(sql`repeat('0', 64)`),
    passed: boolean('passed').notNull(),
    seedOnly: boolean('seed_only').notNull().default(false),
    caseCount: integer('case_count').notNull().default(0),
    metrics: jsonb('metrics')
      .notNull()
      .default(sql`'{}'::jsonb`),
    ranBy: uuid('ran_by'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('procedure_simulation_version_idx').on(table.procedureVersionId, table.createdAt),
  ],
);
