/**
 * Procedures per intent (T-303b, ADR-026): the steps a lead or a head wrote as natural language and the AI
 * compiled, the HTTP contract of `/v1/intents/:id/procedure/versions`, and `evaluateCondition()`.
 *
 * A procedure can only narrow or re-order what the investigation already does (ADR-026 section 1): there is no
 * field for a query, for free text inside a tool input, for loosening a disclosure rule or for raising an
 * autonomy stage. Every object is strict, so a model that invents a field fails validation instead of
 * being half obeyed. Pure: no I/O, no dependency on the database or the AI package.
 */
import { z } from 'zod';

import { ticketPrioritySchema } from './sla.js';

// --- vocabulary ----------------------------------------------------------------------------------

/**
 * The read-only tools of the investigator (`TOOL_NAMES` in `@watchtower/ai`; a test in that package keeps the
 * two lists equal). N2: a procedure can only name tools that read.
 */
export const PROCEDURE_TOOL_NAMES = [
  'kb_search',
  'similar_tickets',
  'org_context',
  'gcp_logs',
  'bigquery_query',
  'repo_changes',
] as const;
export type ProcedureToolName = (typeof PROCEDURE_TOOL_NAMES)[number];

/** Tools every ticket gets whatever its intent (`GENERIC_INVESTIGATOR_TOOLS`); the others need `intent.allowed_tools`. */
export const PROCEDURE_GENERIC_TOOLS = [
  'kb_search',
  'similar_tickets',
  'org_context',
] as const satisfies readonly ProcedureToolName[];

/** Which kind of saved template a tool runs (ADR-016). Tools not listed take no template. */
export const PROCEDURE_TOOL_TEMPLATE_KIND: Readonly<
  Partial<Record<ProcedureToolName, 'logs' | 'data'>>
> = { gcp_logs: 'logs', bigquery_query: 'data' };

export const PROCEDURE_LIMITS = {
  maxSteps: 20,
  maxToolSteps: 8,
  /** Bytes of all free text of the steps together. */
  maxTextBytes: 8192,
  maxSourceBytes: 8192,
} as const;

export const PROCEDURE_SCHEMA_VERSION = 1;
export const PROCEDURE_AUTOSEND = ['allowed', 'never'] as const;
export const PROCEDURE_VERSION_STATUSES = [
  'draft',
  'confirmed',
  'simulated',
  'published',
  'retired',
] as const;
export type ProcedureVersionStatus = (typeof PROCEDURE_VERSION_STATUSES)[number];

// --- conditions (ADR-026 section 2) -------------------------------------------------------------

type FieldKind = 'number' | 'integer' | 'boolean' | 'priority' | 'slug';

/** What each field of a clause is, and which operators make sense for it. */
export const CONDITION_FIELDS = {
  'classifier.confidence': { kind: 'number', ops: ['eq', 'neq', 'gte', 'lte'] },
  'ticket.priority': { kind: 'priority', ops: ['eq', 'neq', 'in'] },
  'ticket.channel': { kind: 'slug', ops: ['eq', 'neq', 'in'] },
  'org.tier': { kind: 'slug', ops: ['eq', 'neq', 'in'] },
  'contact.verified': { kind: 'boolean', ops: ['eq', 'neq'] },
  'evidence.count': { kind: 'integer', ops: ['eq', 'neq', 'gte', 'lte'] },
  'investigation.hasLikelyCause': { kind: 'boolean', ops: ['eq', 'neq'] },
  'ticket.reopenCount': { kind: 'integer', ops: ['eq', 'neq', 'gte', 'lte'] },
} as const satisfies Record<
  string,
  { kind: FieldKind; ops: readonly ('eq' | 'neq' | 'gte' | 'lte' | 'in')[] }
>;
export type ConditionField = keyof typeof CONDITION_FIELDS;
export const CONDITION_FIELD_NAMES = Object.keys(CONDITION_FIELDS) as [
  ConditionField,
  ...ConditionField[],
];
export const CONDITION_OPS = ['eq', 'neq', 'gte', 'lte', 'in'] as const;

const SLUG = /^[a-z0-9][a-z0-9_.-]{0,59}$/;
const PRIORITIES = new Set<string>(['P1', 'P2', 'P3', 'P4']);

function scalarFits(kind: FieldKind, value: unknown): boolean {
  switch (kind) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1000;
    case 'boolean':
      return typeof value === 'boolean';
    case 'priority':
      return typeof value === 'string' && PRIORITIES.has(value);
    case 'slug':
      return typeof value === 'string' && SLUG.test(value);
  }
}

const clauseValueSchema = z.union([
  z.number(),
  z.string().max(60),
  z.boolean(),
  z.array(z.string().max(60)).min(1).max(20),
]);

export const conditionClauseSchema = z
  .strictObject({
    field: z.enum(CONDITION_FIELD_NAMES),
    op: z.enum(CONDITION_OPS),
    value: clauseValueSchema,
  })
  .superRefine((clause, ctx) => {
    const spec = CONDITION_FIELDS[clause.field];
    if (!(spec.ops as readonly string[]).includes(clause.op)) {
      ctx.addIssue({
        code: 'custom',
        path: ['op'],
        message: `${clause.field} does not take the operator ${clause.op}`,
      });
      return;
    }
    const ok =
      clause.op === 'in'
        ? Array.isArray(clause.value) && clause.value.every((item) => scalarFits(spec.kind, item))
        : scalarFits(spec.kind, clause.value);
    if (!ok)
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `Not a valid value for ${clause.field}`,
      });
  });
export type ConditionClause = z.infer<typeof conditionClauseSchema>;

/** `all` and `any` together mean both must hold. Never an expression string (ADR-026 option C). */
export const conditionSchema = z
  .strictObject({
    all: z.array(conditionClauseSchema).min(1).max(8).optional(),
    any: z.array(conditionClauseSchema).min(1).max(8).optional(),
  })
  .refine((condition) => condition.all !== undefined || condition.any !== undefined, {
    message: 'A condition needs "all" or "any"',
  });
export type Condition = z.infer<typeof conditionSchema>;

export type ConditionFactValue = number | string | boolean | null | undefined;
/** What the host knows about a ticket right now. A missing key is "not known yet". */
export type ConditionFacts = Partial<Record<ConditionField, ConditionFactValue>>;

function clauseHolds(
  clause: ConditionClause,
  facts: ConditionFacts,
  whenUnknown: boolean,
): boolean {
  const fact = facts[clause.field];
  if (fact === undefined || fact === null) return whenUnknown;
  const value = clause.value;
  switch (clause.op) {
    case 'eq':
      return fact === value;
    case 'neq':
      return fact !== value;
    case 'in':
      return Array.isArray(value) && typeof fact === 'string' && value.includes(fact);
    case 'gte':
      return typeof fact === 'number' && typeof value === 'number' && fact >= value;
    case 'lte':
      return typeof fact === 'number' && typeof value === 'number' && fact <= value;
  }
}

/**
 * Evaluates a condition over the facts of a ticket. Pure and total: no condition means true; a clause
 * whose fact is not known (`undefined` or `null`) takes the value of `options.unknown`, `false` unless the
 * caller says otherwise. The caller picks the safe side for its use: a `when` that lets an AI step run
 * wants false, one that forces a person to look wants true.
 */
export function evaluateCondition(
  condition: Condition | undefined,
  facts: ConditionFacts,
  options: { readonly unknown?: boolean } = {},
): boolean {
  if (condition === undefined) return true;
  const whenUnknown = options.unknown ?? false;
  const all = condition.all?.every((clause) => clauseHolds(clause, facts, whenUnknown)) ?? true;
  const any = condition.any?.some((clause) => clauseHolds(clause, facts, whenUnknown)) ?? true;
  return all && any;
}

// --- steps (ADR-026 section 2) -------------------------------------------------------------------

export const stepIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, 'A step id is a short snake_case slug');

/** The stages (0 observe .. 4) a step applies to. Absent: every stage that has a procedure. */
const stagesSchema = z
  .array(z.number().int().min(0).max(4))
  .min(1)
  .max(5)
  .refine((stages) => new Set(stages).size === stages.length, { message: 'Stages repeat' })
  .optional();

const text = (max: number) => z.string().trim().min(1).max(max);

export const toolParamsSchema = z.strictObject({
  limit: z.number().int().min(1).max(20).optional(),
  windowMinutes: z.number().int().min(5).max(1440).optional(),
  windowHours: z.number().int().min(1).max(72).optional(),
});
export type ToolParams = z.infer<typeof toolParamsSchema>;

const toolStepSchema = z.strictObject({
  kind: z.literal('tool'),
  id: stepIdSchema,
  tool: z.enum(PROCEDURE_TOOL_NAMES),
  /** Name of a saved `tool_template` of the intent (logs for `gcp_logs`, data for `bigquery_query`). Never a query. */
  template: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{1,60}$/)
    .optional(),
  params: toolParamsSchema.optional(),
  when: conditionSchema.optional(),
  stages: stagesSchema,
});

const checkStepSchema = z.strictObject({
  kind: z.literal('check'),
  id: stepIdSchema,
  question: text(300),
  evidenceFrom: z.array(stepIdSchema).min(1).max(8),
  stages: stagesSchema,
});

const replyGuidelineStepSchema = z.strictObject({
  kind: z.literal('reply_guideline'),
  id: stepIdSchema,
  text: text(1000),
  lang: z.enum(['th', 'en']).optional(),
  stages: stagesSchema,
});

export const DISCLOSURE_RULES = ['never_mention', 'verified_only'] as const;
const disclosureStepSchema = z.strictObject({
  kind: z.literal('disclosure'),
  id: stepIdSchema,
  rule: z.enum(DISCLOSURE_RULES),
  topic: text(200),
  stages: stagesSchema,
});

export const escalateTargetSchema = z.union([
  z.strictObject({ queueKey: z.string().trim().min(1).max(60) }),
  z.strictObject({ role: z.enum(['lead', 'head']) }),
]);

const escalateStepSchema = z.strictObject({
  kind: z.literal('escalate'),
  id: stepIdSchema,
  when: conditionSchema,
  to: escalateTargetSchema,
  priority: ticketPrioritySchema.optional(),
  note: text(300),
  stages: stagesSchema,
});

const requireHumanStepSchema = z.strictObject({
  kind: z.literal('require_human'),
  id: stepIdSchema,
  when: conditionSchema,
  reason: text(200),
  stages: stagesSchema,
});

export const procedureStepSchema = z.discriminatedUnion('kind', [
  toolStepSchema,
  checkStepSchema,
  replyGuidelineStepSchema,
  disclosureStepSchema,
  escalateStepSchema,
  requireHumanStepSchema,
]);
export type ProcedureStep = z.infer<typeof procedureStepSchema>;
export type ProcedureToolStep = Extract<ProcedureStep, { kind: 'tool' }>;

const encoder = new TextEncoder();

/** The free text a person or a model wrote inside the steps (what `maxTextBytes` counts). */
export function procedureStepTexts(step: ProcedureStep): string[] {
  switch (step.kind) {
    case 'tool':
      return step.template === undefined ? [] : [step.template];
    case 'check':
      return [step.question];
    case 'reply_guideline':
      return [step.text];
    case 'disclosure':
      return [step.topic];
    case 'escalate':
      return [step.note, ...('queueKey' in step.to ? [step.to.queueKey] : [])];
    case 'require_human':
      return [step.reason];
  }
}

export function procedureTextBytes(steps: readonly ProcedureStep[]): number {
  return steps.reduce(
    (sum, step) =>
      sum +
      procedureStepTexts(step).reduce((inner, value) => inner + encoder.encode(value).length, 0),
    0,
  );
}

export const procedureStepsSchema = z
  .strictObject({
    schemaVersion: z.literal(PROCEDURE_SCHEMA_VERSION),
    /** `never` unless a person says otherwise: a procedure cannot make a draft go out by itself (ADR-026 section 5). */
    autosend: z.enum(PROCEDURE_AUTOSEND).default('never'),
    steps: z.array(procedureStepSchema).max(PROCEDURE_LIMITS.maxSteps),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.steps.forEach((step, index) => {
      if (seen.has(step.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', index, 'id'],
          message: `Step id ${step.id} is used twice`,
        });
      }
      seen.add(step.id);
    });
    const tools = value.steps.filter((step) => step.kind === 'tool').length;
    if (tools > PROCEDURE_LIMITS.maxToolSteps) {
      ctx.addIssue({
        code: 'custom',
        path: ['steps'],
        message: `At most ${String(PROCEDURE_LIMITS.maxToolSteps)} tool steps`,
      });
    }
    if (procedureTextBytes(value.steps) > PROCEDURE_LIMITS.maxTextBytes) {
      ctx.addIssue({
        code: 'custom',
        path: ['steps'],
        message: `The text of the steps is over ${String(PROCEDURE_LIMITS.maxTextBytes)} bytes`,
      });
    }
  });
export type ProcedureSteps = z.infer<typeof procedureStepsSchema>;
export type ProcedureStepsInput = z.input<typeof procedureStepsSchema>;

export const EMPTY_PROCEDURE_STEPS: ProcedureSteps = {
  schemaVersion: PROCEDURE_SCHEMA_VERSION,
  autosend: 'never',
  steps: [],
};

// --- semantic validation (computed in `@watchtower/domain`, shown by the api and the web) -------------

export const PROCEDURE_ISSUE_CODES = [
  'tool_not_allowed',
  'template_not_found',
  'template_wrong_tool',
  'template_not_for_tool',
  'queue_not_found',
  'evidence_unknown_step',
  'evidence_not_earlier',
  'evidence_not_tool',
  'dead_step',
  'contradictory_condition',
  'duplicate_tool_step',
] as const;
export const procedureIssueSchema = z.object({
  code: z.enum(PROCEDURE_ISSUE_CODES),
  stepId: z.string().nullable(),
  message: z.string().max(400),
});
export type ProcedureIssue = z.infer<typeof procedureIssueSchema>;

export const procedureValidationSchema = z.object({
  ok: z.boolean(),
  issues: z.array(procedureIssueSchema).max(100),
});
export type ProcedureValidation = z.infer<typeof procedureValidationSchema>;

// --- HTTP contract (`/v1/intents/:id/procedure/versions`) --------------------------------------------

export const intentProcedureParamsSchema = z.object({ id: z.uuid() });
export const procedureVersionParamsSchema = z.object({ id: z.uuid(), versionId: z.uuid() });

export const procedureSimulationSummarySchema = z.object({
  id: z.uuid(),
  passed: z.boolean(),
  seedOnly: z.boolean(),
  caseCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export type ProcedureSimulationSummary = z.infer<typeof procedureSimulationSummarySchema>;

export const procedureVersionSchema = z.object({
  id: z.uuid(),
  procedureId: z.uuid(),
  intentId: z.uuid(),
  version: z.number().int().positive(),
  status: z.enum(PROCEDURE_VERSION_STATUSES),
  sourceMd: z.string(),
  steps: procedureStepsSchema,
  schemaVersion: z.number().int(),
  stepsHash: z.string().regex(/^[0-9a-f]{64}$/),
  compiledByAiRunId: z.uuid().nullable(),
  authoredBy: z.uuid().nullable(),
  confirmedBy: z.uuid().nullable(),
  confirmedAt: z.iso.datetime().nullable(),
  publishedBy: z.uuid().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  retiredBy: z.uuid().nullable(),
  retiredAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /** The latest simulation of this version, if any. Publish needs it to have passed (T-303d writes them). */
  simulation: procedureSimulationSummarySchema.nullable(),
});
export type ProcedureVersion = z.infer<typeof procedureVersionSchema>;

export const procedureVersionListSchema = z.object({
  procedureId: z.uuid().nullable(),
  /** The version the intent runs now (`intent.procedure_version_id`); null: the default runbook. */
  publishedVersionId: z.uuid().nullable(),
  /** Newest first, at most 100. */
  items: z.array(procedureVersionSchema).max(100),
});
export type ProcedureVersionList = z.infer<typeof procedureVersionListSchema>;

export const createProcedureVersionSchema = z.strictObject({
  sourceMd: z.string().max(PROCEDURE_LIMITS.maxSourceBytes).default(''),
  steps: procedureStepsSchema.optional(),
});
export type CreateProcedureVersion = z.infer<typeof createProcedureVersionSchema>;

export const updateProcedureVersionSchema = z
  .strictObject({
    sourceMd: z.string().max(PROCEDURE_LIMITS.maxSourceBytes).optional(),
    steps: procedureStepsSchema.optional(),
  })
  .refine((body) => body.sourceMd !== undefined || body.steps !== undefined, {
    message: 'Send sourceMd, steps or both',
  });
export type UpdateProcedureVersion = z.infer<typeof updateProcedureVersionSchema>;

/** What `compile` and `confirm` answer: the version as it stands and what is wrong with its steps. */
export const procedureVersionResultSchema = z.object({
  version: procedureVersionSchema,
  validation: procedureValidationSchema,
});
export type ProcedureVersionResult = z.infer<typeof procedureVersionResultSchema>;

export const compileProcedureResultSchema = procedureVersionResultSchema.extend({
  /** What the model says it had to guess. A person reads these before confirming. */
  assumptions: z.array(z.string().max(300)).max(8),
  promptVersion: z.number().int().positive(),
});
export type CompileProcedureResult = z.infer<typeof compileProcedureResultSchema>;
