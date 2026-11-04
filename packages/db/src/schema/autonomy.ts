// Autonomy history, the global AI switches (T-112a, migration 0007, ADR-011) and the stage 3 tables
// (T-304b, migration 0096, ADR-025). The SQL files are the source of truth (CHECKs, triggers, privileges
// and set_intent_autonomy() / request_stage_promotion() live there).
// `intent.autonomyStage` / `autonomyPinned` / `autosend*` are columns of the `intent` table in `./ticketing.ts`.
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { procedureVersion } from './procedure.js';
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
    /** `stage`, `pin`, `unpin`, `promotion`, `auto_rollback` or `autosend` (0096). */
    change: text('change').notNull(),
    fromStage: smallint('from_stage').notNull(),
    toStage: smallint('to_stage').notNull(),
    /** The pin state after this change. */
    pinned: boolean('pinned').notNull(),
    reason: text('reason').notNull(),
    /** Null only for `auto_rollback`: nobody pressed a button. */
    changedBy: uuid('changed_by'),
    changedAt: timestamptz('changed_at').notNull().defaultNow(),
    /** The promotion that moved the intent to stage 3 (FK in SQL). */
    promotionId: uuid('promotion_id'),
    evidence: jsonb('evidence').$type<Record<string, unknown>>(),
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

/**
 * Where the demo / year / e2e rows came from (0096, ADR-025 section 10). Written by the schema owner
 * only; `ticket.seedBatchId` and `organization.seedBatchId` point here. Reports count `seedBatchId IS NULL`.
 */
export const seedBatch = pgTable('seed_batch', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** `demo`, `year` or `e2e`. */
  kind: text('kind').notNull(),
  loadedAt: timestamptz('loaded_at').notNull().defaultNow(),
  loadedBy: text('loaded_by').notNull(),
  note: text('note').notNull().default(''),
});

/** One report per intent and window; append-only. The report is an input to people, not the decider. */
export const autonomyGateReport = pgTable(
  'autonomy_gate_report',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => intent.id, { onDelete: 'restrict' }),
    /** `green`, `red` or `insufficient_data`. */
    status: text('status').notNull(),
    /** `weekly` or `on_demand`. */
    triggerKind: text('trigger_kind').notNull(),
    windowStart: timestamptz('window_start').notNull(),
    windowEnd: timestamptz('window_end').notNull(),
    metrics: jsonb('metrics')
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    criteria: jsonb('criteria')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<{ key: string; pass: boolean | null; value: unknown; threshold: unknown }[]>(),
    seedExcluded: boolean('seed_excluded').notNull().default(true),
    generatedAt: timestamptz('generated_at').notNull().defaultNow(),
    generatedBy: uuid('generated_by'),
  },
  (table) => [
    index('autonomy_gate_report_intent_idx').on(table.intentId, table.generatedAt.desc()),
  ],
);

/** Rows come only from request_/decide_/apply_stage_promotion(); the application role can read. */
export const intentAutonomyPromotion = pgTable(
  'intent_autonomy_promotion',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => intent.id, { onDelete: 'restrict' }),
    gateReportId: uuid('gate_report_id')
      .notNull()
      .references(() => autonomyGateReport.id, { onDelete: 'restrict' }),
    /** `requested`, `approved`, `rejected`, `applied`, `expired` or `cancelled`. */
    status: text('status').notNull().default('requested'),
    requestedBy: uuid('requested_by').notNull(),
    requestedAt: timestamptz('requested_at').notNull().defaultNow(),
    requestReason: text('request_reason').notNull(),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamptz('decided_at'),
    decisionReason: text('decision_reason'),
    selfApproved: boolean('self_approved').notNull().default(false),
    reauthAt: timestamptz('reauth_at'),
    confirmedKey: text('confirmed_key'),
    appliedAt: timestamptz('applied_at'),
    historyId: uuid('history_id'),
  },
  (table) => [
    uniqueIndex('intent_autonomy_promotion_open_key')
      .on(table.intentId)
      .where(sql`${table.status} IN ('requested', 'approved')`),
    index('intent_autonomy_promotion_intent_idx').on(table.intentId, table.requestedAt.desc()),
  ],
);

/**
 * A grade of one exact text, made before it is sent (`pre_send`) or on a sample (`sampled`). The hash is
 * computed by a trigger from `gradedText`. `independent` is generated: grader model <> drafter model.
 * `score` is numeric(4,3), so the driver returns a string.
 */
export const aiGrade = pgTable(
  'ai_grade',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    aiDraftId: uuid('ai_draft_id').notNull(),
    ticketId: uuid('ticket_id').notNull(),
    phase: text('phase').notNull(),
    gradedText: text('graded_text').notNull(),
    contentHash: text('content_hash').notNull().default(''),
    graderAiRunId: uuid('grader_ai_run_id'),
    graderProvider: text('grader_provider').notNull(),
    graderModel: text('grader_model').notNull(),
    drafterProvider: text('drafter_provider').notNull(),
    drafterModel: text('drafter_model').notNull(),
    independent: boolean('independent').generatedAlwaysAs(sql`grader_model <> drafter_model`),
    score: numeric('score', { precision: 4, scale: 3 }).notNull(),
    passed: boolean('passed').notNull(),
    violations: jsonb('violations')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<unknown[]>(),
    violationCount: integer('violation_count').notNull().default(0),
    promptVersion: integer('prompt_version').notNull(),
    mock: boolean('mock').notNull().default(false),
    gradedAt: timestamptz('graded_at').notNull().defaultNow(),
  },
  (table) => [
    index('ai_grade_draft_idx').on(table.aiDraftId, table.gradedAt.desc()),
    index('ai_grade_ticket_idx').on(table.ticketId, table.gradedAt.desc()),
    index('ai_grade_phase_idx').on(table.phase, table.gradedAt.desc()),
  ],
);

/** One row each time the auto-send decision is evaluated, in `shadow` or `live` mode. Append-only. */
export const aiAutosendEvaluation = pgTable(
  'ai_autosend_evaluation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    aiDraftId: uuid('ai_draft_id').notNull(),
    ticketId: uuid('ticket_id').notNull(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => intent.id, { onDelete: 'restrict' }),
    mode: text('mode').notNull(),
    wouldAutoSend: boolean('would_auto_send').notNull(),
    failedConditions: text('failed_conditions')
      .array()
      .notNull()
      .default(sql`'{}'`),
    effectiveStage: smallint('effective_stage').notNull(),
    aiGradeId: uuid('ai_grade_id'),
    facts: jsonb('facts')
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    evaluatedAt: timestamptz('evaluated_at').notNull().defaultNow(),
  },
  (table) => [
    index('ai_autosend_evaluation_intent_idx').on(table.intentId, table.evaluatedAt.desc()),
    index('ai_autosend_evaluation_draft_idx').on(table.aiDraftId),
  ],
);

/**
 * The outcome of a replay (the eval set or a procedure simulation) for one set of drafter model, grader model,
 * prompt versions and procedure version (0109, T-306e). Append-only; rows come only from record_replay_result().
 * The gate reads the latest row of the set in force: no row, or a failed one, suspends auto-send.
 */
export const aiReplayResult = pgTable(
  'ai_replay_result',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => intent.id, { onDelete: 'restrict' }),
    /** 'eval' or 'simulation'. */
    source: text('source').notNull(),
    drafterModel: text('drafter_model').notNull(),
    graderModel: text('grader_model').notNull(),
    drafterPromptVersion: integer('drafter_prompt_version').notNull(),
    graderPromptVersion: integer('grader_prompt_version').notNull(),
    procedureVersionId: uuid('procedure_version_id').references(() => procedureVersion.id, {
      onDelete: 'restrict',
    }),
    caseCount: integer('case_count').notNull(),
    violations: integer('violations').notNull(),
    redactionPassed: boolean('redaction_passed').notNull(),
    mock: boolean('mock').notNull().default(false),
    passed: boolean('passed').notNull(),
    recordedBy: uuid('recorded_by').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('ai_replay_result_set_idx').on(
      table.intentId,
      table.drafterModel,
      table.graderModel,
      table.drafterPromptVersion,
      table.graderPromptVersion,
      table.createdAt.desc(),
    ),
  ],
);
