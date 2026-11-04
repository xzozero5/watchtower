// AI runs and the latest AI result per ticket (T-106d, migration 0010). Drafts and tool executions
// arrive with T-108. The SQL file is the source of truth (partitioning, triggers, privileges and
// CHECKs live there); keep both in step by hand and let the integration tests catch drift.
import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './auth.js';
import { intent, message, ticket } from './ticketing.js';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * One row per model call. Parent of the monthly partitions (PARTITION BY RANGE (created_at)).
 * Append-only: no UPDATE, DELETE or TRUNCATE for the application role, and a trigger rejects them
 * for everyone. Holds the redacted answer only; the input is kept as a keyed hash.
 */
export const aiRun = pgTable(
  'ai_run',
  {
    id: uuid('id').notNull().defaultRandom(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    startedAt: timestamptz('started_at').notNull(),
    agent: text('agent').notNull(),
    ticketId: uuid('ticket_id').references(() => ticket.id, { onDelete: 'restrict' }),
    intent: text('intent'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    tier: text('tier').notNull(),
    promptId: text('prompt_id').notNull(),
    promptVersion: integer('prompt_version').notNull(),
    promptHash: text('prompt_hash').notNull(),
    tools: text('tools')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    inputHmac: text('input_hmac').notNull(),
    output: text('output'),
    confidence: real('confidence'),
    redaction: jsonb('redaction')
      .notNull()
      .$type<{ total: number; byKind: Record<string, number> }>(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 14, scale: 8 }),
    latencyMs: integer('latency_ms').notNull().default(0),
    status: text('status').notNull(),
    errorCode: text('error_code'),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.createdAt] }),
    index('ai_run_created_idx').on(table.createdAt.desc(), table.id.desc()),
    index('ai_run_agent_idx').on(table.agent, table.createdAt.desc()),
  ],
);

/** The latest AI result per ticket, replaced by an upsert. The history is `ai_run`. */
export const aiTicketInsight = pgTable(
  'ai_ticket_insight',
  {
    ticketId: uuid('ticket_id')
      .primaryKey()
      .references(() => ticket.id, { onDelete: 'restrict' }),
    state: text('state').notNull(),
    reasonCode: text('reason_code'),
    summary: text('summary'),
    intentKey: text('intent_key'),
    intentConfidence: real('intent_confidence'),
    intentReason: text('intent_reason'),
    nextStepKind: text('next_step_kind'),
    nextStepLabel: text('next_step_label'),
    evidence: jsonb('evidence')
      .notNull()
      .default(sql`'[]'::jsonb`),
    draftId: uuid('draft_id'),
    stage: smallint('stage').notNull().default(0),
    classifierRunId: uuid('classifier_run_id'),
    summarizerRunId: uuid('summarizer_run_id'),
    generatedAt: timestamptz('generated_at').notNull(),
    // T-108 (migration 0034).
    /** The investigation report: findings with the evidence they rest on, open questions. */
    report: jsonb('report'),
    /** Progress of the job while it runs: phase and step. */
    progress: jsonb('progress'),
    /** The person who asked for it (a draft on request); null when the system did. */
    requestedBy: uuid('requested_by'),
    investigatedAt: timestamptz('investigated_at'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [index('ai_ticket_insight_state_idx').on(table.state, table.updatedAt.desc())],
);

/**
 * One row per tool call of an AI run (T-108a, migration 0034): the budget ledger and the audit of what a
 * tool was asked. Holds a keyed hash of the input and a count of the result, never either.
 */
export const toolExecution = pgTable(
  'tool_execution',
  {
    id: uuid('id').notNull().defaultRandom(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    finishedAt: timestamptz('finished_at'),
    ticketId: uuid('ticket_id').references(() => ticket.id, { onDelete: 'restrict' }),
    runKey: text('run_key').notNull(),
    agent: text('agent').notNull(),
    tool: text('tool').notNull(),
    intent: text('intent'),
    stage: smallint('stage'),
    inputHash: text('input_hash').notNull(),
    /** `running`, `ok`, `error` or `denied`. */
    status: text('status').notNull(),
    errorCode: text('error_code'),
    latencyMs: integer('latency_ms'),
    resultCount: integer('result_count'),
    mock: boolean('mock').notNull().default(false),
  },
  (table) => [
    // Partitioned by month (migration 0064): the primary key holds the partition key.
    primaryKey({ columns: [table.id, table.createdAt] }),
    index('tool_execution_ticket_idx').on(table.ticketId, table.createdAt.desc()),
    index('tool_execution_tool_idx').on(table.tool, table.createdAt.desc()),
    index('tool_execution_run_idx').on(table.runKey),
  ],
);

/** First time per UTC day a daily cap reached its alert level (`alert`) or its limit (`stop`). */
export const aiBudgetEvent = pgTable(
  'ai_budget_event',
  {
    day: date('day', { mode: 'string' }).notNull(),
    level: text('level').notNull(),
    dimension: text('dimension').notNull(),
    spent: numeric('spent').notNull(),
    cap: numeric('cap').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.day, table.level, table.dimension] })],
);

export type AiRunRow = typeof aiRun.$inferSelect;
export type NewAiRunRow = typeof aiRun.$inferInsert;
export type ToolExecutionRow = typeof toolExecution.$inferSelect;
export type AiTicketInsightRow = typeof aiTicketInsight.$inferSelect;
export type NewAiTicketInsightRow = typeof aiTicketInsight.$inferInsert;

/**
 * The grader's verdict on one resolution of a ticket (T-301, migration 0094). The SQL file is the
 * source of truth for the CHECKs. A measurement only: nothing here changes a stage or reaches a customer.
 */
export const aiResolutionGrade = pgTable(
  'ai_resolution_grade',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => ticket.id, { onDelete: 'restrict' }),
    cycle: integer('cycle').notNull().default(0),
    intentKey: text('intent_key'),
    /** `verified`, `contained` or `assumed`, after the code capped what the model said. */
    resolutionClass: text('resolution_class').notNull(),
    modelClass: text('model_class'),
    draftId: uuid('draft_id'),
    /** `matches`, `partial`, `differs` or `no_draft`. */
    draftVerdict: text('draft_verdict').notNull().default('no_draft'),
    draftQuality: real('draft_quality'),
    policyViolations: jsonb('policy_violations')
      .notNull()
      .default(sql`'[]'::jsonb`),
    violationCount: integer('violation_count').notNull().default(0),
    kbGap: boolean('kb_gap').notNull().default(false),
    reasoning: jsonb('reasoning')
      .notNull()
      .default(sql`'[]'::jsonb`),
    csatScore: smallint('csat_score'),
    csatResolved: boolean('csat_resolved'),
    aiRunId: uuid('ai_run_id'),
    promptVersion: integer('prompt_version').notNull(),
    mock: boolean('mock').notNull().default(false),
    gradedAt: timestamptz('graded_at').notNull().defaultNow(),
    /** 1 for the first grade; 2 once it was re-made after the CSAT answer arrived (T-301e, migration 0096). */
    version: integer('version').notNull().default(1),
    regradedAt: timestamptz('regraded_at'),
  },
  (table) => [
    unique('ai_resolution_grade_ticket_cycle_key').on(table.ticketId, table.cycle),
    index('ai_resolution_grade_intent_idx').on(table.intentKey, table.gradedAt.desc()),
    index('ai_resolution_grade_graded_idx').on(table.gradedAt.desc()),
  ],
);

export type AiResolutionGradeRow = typeof aiResolutionGrade.$inferSelect;
export type NewAiResolutionGradeRow = typeof aiResolutionGrade.$inferInsert;

/**
 * A sent reply that a lead or head marked as a good answer to its intent (T-302a, migration 0098), kept in
 * redacted form only. Append and soft delete: the app role may set `deleted_at` / `deleted_by` and nothing else.
 * The SQL file is the source of truth for the CHECKs and the partial unique index.
 */
export const goldenAnswer = pgTable(
  'golden_answer',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => ticket.id, { onDelete: 'restrict' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'restrict' }),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => intent.id, { onDelete: 'restrict' }),
    bodyRedacted: text('body_redacted').notNull(),
    language: text('language'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    deletedAt: timestamptz('deleted_at'),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'restrict' }),
  },
  (table) => [
    index('golden_answer_intent_idx')
      .on(table.intentId, table.createdAt.desc())
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export type GoldenAnswerRow = typeof goldenAnswer.$inferSelect;
export type NewGoldenAnswerRow = typeof goldenAnswer.$inferInsert;
