/**
 * Investigation tools, rate budget and ad-hoc runs (T-203): this feature's own audit actions, ticket event types and queue names (T-200).
 *
 * Created empty by T-200 so the Phase 2 tasks that run in parallel never edit the same lines of
 * `./index.ts`, `auth.ts`, `ticketing.ts` or `queues.ts`. The task that owns this feature adds its
 * entries here and nowhere else in `packages/shared` (see `./gmail.ts` for the conventions).
 */
import { z } from 'zod';

import { AI_TOOL_BUDGETS } from './ai.js';

/** Audit `action` strings written by this feature. Metadata holds ids, enumerations and counts, never a query or a result. */
export const TOOLS_AUDIT_ACTIONS = {
  /** A person ran a saved template and pinned the result to a ticket or an incident. */
  toolRun: 'tool.run',
  /** A head or lead ran a statement or a filter of their own (`investigate.adhoc`). */
  toolAdhoc: 'tool.adhoc',
  toolTemplateCreate: 'tool.template.create',
  toolTemplateUpdate: 'tool.template.update',
  toolTemplateDelete: 'tool.template.delete',
  /** An evidence card was unpinned. */
  evidenceDelete: 'evidence.delete',
} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const TOOLS_TICKET_EVENTS = {} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature. */
export const TOOLS_QUEUES = {} as const satisfies Record<string, string>;

// --- The data tool's guardrails (T-203c, R-5.2) ----------------------------------------------------

/**
 * Result columns of a data query that may be shown (the name the statement gives the column, lower
 * case). Any other column is masked: its cells come back null. These are names of things that count,
 * measure, classify or date, never of a person; a saved template may add its own (`allowedColumns`,
 * head only, audited). `[ASSUMED]` list: the owner reviews it against the real product schema.
 */
export const DATA_COLUMN_ALLOW_LIST: readonly string[] = [
  'day',
  'date',
  'hour',
  'week',
  'month',
  'bucket',
  'tenant_id',
  'org_id',
  'service',
  'event_type',
  'kind',
  'status',
  'plan',
  'region',
  'requests',
  'failed',
  'deliveries',
  'jobs',
  'count',
  'total',
  'n',
  'ratio',
  'rate',
  'p50_ms',
  'p95_ms',
  'p99_ms',
  'avg_ms',
  'duration_ms',
  'submitted_at',
  'created_at',
  'value',
];

/** A data query returns at most this many rows to a person (the connector's hard cap is 500). */
export const DATA_RUN_MAX_ROWS = 100;
/** The longest a data query may run for a person. */
export const DATA_RUN_TIMEOUT_MS = 5000;

// --- The shared rate budget (T-203b, ADR-015 section 3) ------------------------------------------

/**
 * `[CONFIRMED]` (PRD R-5.1): Cloud Logging `entries.list` allows 60 reads a minute a project. We use
 * at most 55 so a retry or a person outside Watchtower still fits, and the AI at most 30 of those so
 * a person at a ticket can run the same query while a batch of AI runs is going. The 55 and the 30 are
 * `[ASSUMED]` (the phase-2 breakdown); the 60 is the provider's.
 */
export const LOGGING_RATE_BUDGET = {
  providerQuotaPerMinute: 60,
  totalPerMinute: 55,
  aiPerMinute: AI_TOOL_BUDGETS.perToolPerMinute,
} as const;

/** `[ASSUMED]` budget of every other system a person and the AI both reach (data, repository, metrics). */
export const SHARED_RATE_BUDGET = { totalPerMinute: 60, aiPerMinute: 30 } as const;

/** Who is asking: the AI counts against its own share as well as the total. */
export type RateActor = 'ai' | 'human' | 'system';

export interface RateBudgetSpec {
  /** `logging:<project>`, `data:<project>`, ... : one window per resource. */
  readonly resource: string;
  readonly totalPerMinute: number;
  readonly aiPerMinute: number;
}

/** The tool names the budget knows. Others get a window of their own (`tool:<name>`). */
export const RATE_TOOL_NAMES = {
  logs: 'gcp_logs',
  data: 'bigquery_query',
  repo: 'repo_changes',
  metrics: 'cloud_metrics',
} as const;

export const DEFAULT_BUDGET_PROJECT = 'default';

/**
 * Which window a tool call is counted in. The logs tool, the data tool, the repository tool and the
 * metrics tool each have one window per project that people and the AI share. Any other tool (the
 * knowledge base, similar tickets, ...) is used by the AI alone and has a window of its own whose
 * whole size is `perToolPerMinute`, which is the limit those tools had before the move to windows.
 */
export function rateBudgetFor(
  tool: string,
  options: { readonly project?: string; readonly perToolPerMinute?: number } = {},
): RateBudgetSpec {
  const project = options.project ?? DEFAULT_BUDGET_PROJECT;
  const perTool = options.perToolPerMinute ?? AI_TOOL_BUDGETS.perToolPerMinute;
  switch (tool) {
    case RATE_TOOL_NAMES.logs:
      return {
        resource: `logging:${project}`,
        totalPerMinute: LOGGING_RATE_BUDGET.totalPerMinute,
        aiPerMinute: Math.min(LOGGING_RATE_BUDGET.aiPerMinute, perTool),
      };
    case RATE_TOOL_NAMES.data:
      return { resource: `data:${project}`, ...sharedSpec(perTool) };
    case RATE_TOOL_NAMES.repo:
      return { resource: `repo:${project}`, ...sharedSpec(perTool) };
    case RATE_TOOL_NAMES.metrics:
      return { resource: `monitoring:${project}`, ...sharedSpec(perTool) };
    default:
      return { resource: `tool:${tool}`, totalPerMinute: perTool, aiPerMinute: perTool };
  }
}

function sharedSpec(perTool: number): { totalPerMinute: number; aiPerMinute: number } {
  return {
    totalPerMinute: SHARED_RATE_BUDGET.totalPerMinute,
    aiPerMinute: Math.min(SHARED_RATE_BUDGET.aiPerMinute, perTool),
  };
}

// --- Templates, runs and evidence cards (T-203d): the HTTP schemas ---------------------------------

export const TOOL_KINDS = ['logs', 'data'] as const;
export const toolKindSchema = z.enum(TOOL_KINDS);
export type ToolKind = z.infer<typeof toolKindSchema>;

export const EVIDENCE_KINDS = ['logs', 'data', 'repo', 'metrics'] as const;
export const evidenceKindSchema = z.enum(EVIDENCE_KINDS);

/**
 * Placeholders a template may use that the server fills from the ticket (never from the caller): the
 * organization's id and the ticket's id. Any other placeholder is typed in by the person who presses
 * the button.
 */
export const TOOL_AUTO_PARAMS = ['org_id', 'ticket_id'] as const;

export const toolTemplateNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,60}$/);
const placeholderName = z.string().regex(/^[a-z][a-z0-9_]{0,30}$/);

export const toolTemplateSchema = z.object({
  id: z.uuid(),
  kind: toolKindSchema,
  name: toolTemplateNameSchema,
  title: z.string(),
  /** The intent whose tickets get the button; null = every ticket. */
  intentKey: z.string().nullable(),
  body: z.string(),
  /** Every `{{name}}` in the body. */
  placeholders: z.array(placeholderName),
  /** The placeholders a person must give (those the ticket does not fill). */
  inputParams: z.array(placeholderName),
  allowedColumns: z.array(z.string()),
  runByAi: z.boolean(),
  active: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type ToolTemplate = z.infer<typeof toolTemplateSchema>;
export const toolTemplateListSchema = z.object({ items: z.array(toolTemplateSchema) });

const columnName = z.string().regex(/^[a-z_][a-z0-9_]{0,60}$/);

export const createToolTemplateSchema = z.strictObject({
  kind: toolKindSchema,
  name: toolTemplateNameSchema,
  title: z.string().trim().min(1).max(120),
  intentKey: z.string().min(1).max(100).nullable().default(null),
  body: z.string().trim().min(1).max(4000),
  allowedColumns: z.array(columnName).max(30).default([]),
  runByAi: z.boolean().default(true),
  active: z.boolean().default(true),
});
export type CreateToolTemplate = z.infer<typeof createToolTemplateSchema>;

/** `kind` and `name` never change: a card and an audit row point at them. */
export const updateToolTemplateSchema = z.strictObject({
  title: z.string().trim().min(1).max(120).optional(),
  intentKey: z.string().min(1).max(100).nullable().optional(),
  body: z.string().trim().min(1).max(4000).optional(),
  allowedColumns: z.array(columnName).max(30).optional(),
  runByAi: z.boolean().optional(),
  active: z.boolean().optional(),
});
export type UpdateToolTemplate = z.infer<typeof updateToolTemplateSchema>;

export const toolTemplateIdParamSchema = z.object({ id: z.uuid() });
export type ToolTemplateIdParam = z.infer<typeof toolTemplateIdParamSchema>;

export const toolTemplateListQuerySchema = z.object({
  intent: z.string().min(1).max(100).optional(),
  kind: toolKindSchema.optional(),
});
export type ToolTemplateListQuery = z.infer<typeof toolTemplateListQuerySchema>;

/** The buttons of a ticket: the templates of its intent (active), then the generic ones. */
export const ticketToolsSchema = z.object({
  intentKey: z.string().nullable(),
  buttons: z.array(
    z.object({
      templateId: z.uuid(),
      kind: toolKindSchema,
      name: toolTemplateNameSchema,
      title: z.string(),
      inputParams: z.array(placeholderName),
      /** True when the system the button reaches is not connected here: pressing it answers 503. */
      connected: z.boolean(),
      /** The answer will come from a fake or a sandbox. */
      mock: z.boolean(),
    }),
  ),
});
export type TicketTools = z.infer<typeof ticketToolsSchema>;

export const TOOL_WINDOW_MINUTES = { min: 5, max: 1440, default: 60 } as const;
const windowMinutes = z.number().int().min(TOOL_WINDOW_MINUTES.min).max(TOOL_WINDOW_MINUTES.max);

const paramValue = z.string().min(1).max(128);

/** Run a saved template on a ticket or an incident (the id is in the path). */
export const runToolSchema = z.strictObject({
  templateId: z.uuid(),
  /** Only the placeholders the ticket does not fill; naming an automatic one is refused. */
  params: z.record(placeholderName, paramValue).default({}),
  windowMinutes: windowMinutes.default(TOOL_WINDOW_MINUTES.default),
});
export type RunTool = z.infer<typeof runToolSchema>;

/**
 * A ticket by id or number (`OPS-1234`), the same shape as `ticketRefSchema`. Not imported from
 * `../ticketing.js`: that file imports this directory, and a cycle would leave the schema undefined.
 */
const ticketRef = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => z.uuid().safeParse(value).success || /^[A-Za-z][A-Za-z0-9]{1,9}-\d{1,15}$/.test(value), {
    message: 'expected a ticket id or a ticket number such as OPS-1234',
  });

/** Where an ad-hoc result is pinned: a ticket or an incident, exactly one. */
const pin = {
  ticketId: ticketRef.optional(),
  incidentId: z.uuid().optional(),
};

export const adhocLogsSchema = z
  .strictObject({
    /** A filter in the subset the connectors read (`service="x" AND labels.k="v" severity>=ERROR "text"`). */
    filter: z.string().max(2000).default(''),
    windowMinutes: windowMinutes.default(TOOL_WINDOW_MINUTES.default),
    limit: z.number().int().min(1).max(100).default(50),
    ...pin,
  })
  .refine((value) => (value.ticketId === undefined) !== (value.incidentId === undefined), {
    message: 'Give a ticketId or an incidentId (one of them) to pin the result to',
  });
export type AdhocLogs = z.infer<typeof adhocLogsSchema>;

export const adhocDataSchema = z
  .strictObject({
    /** One SELECT with `$1..$n` bind parameters. */
    sql: z.string().min(1).max(8000),
    params: z.array(z.union([z.string().max(200), z.number()])).max(10).default([]),
    maxRows: z.number().int().min(1).max(500).default(100),
    ...pin,
  })
  .refine((value) => (value.ticketId === undefined) !== (value.incidentId === undefined), {
    message: 'Give a ticketId or an incidentId (one of them) to pin the result to',
  });
export type AdhocData = z.infer<typeof adhocDataSchema>;

export const evidenceCardSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid().nullable(),
  incidentId: z.uuid().nullable(),
  kind: evidenceKindSchema,
  templateId: z.uuid().nullable(),
  /** The template's name, or `adhoc`. */
  templateName: z.string(),
  title: z.string(),
  /** Counts and the range, never content. */
  summary: z.string(),
  /** A few lines of the result with personal data replaced by placeholders. */
  excerpt: z.string(),
  resultCount: z.number().int().min(0),
  truncated: z.boolean(),
  maskedColumns: z.array(z.string()),
  windowFrom: z.iso.datetime({ offset: true }).nullable(),
  windowTo: z.iso.datetime({ offset: true }).nullable(),
  /** Fake or sandbox data: the card says so (N5). */
  mock: z.boolean(),
  createdBy: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type EvidenceCard = z.infer<typeof evidenceCardSchema>;
export const evidenceCardListSchema = z.object({ items: z.array(evidenceCardSchema) });

export const evidenceCardIdParamSchema = z.object({ id: z.uuid(), cardId: z.uuid() });
export type EvidenceCardIdParam = z.infer<typeof evidenceCardIdParamSchema>;

/** The service status panel of the ops view (R-5.7). */
export const SERVICE_STATUS_SPARK = { windowHours: 24, stepMinutes: 30 } as const;

const sparkPoints = z.array(z.object({ t: z.iso.datetime({ offset: true }), v: z.number() }));

export const serviceStatusSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  alerts: z.object({
    open: z.number().int().min(0),
    acknowledged: z.number().int().min(0),
    /** The worst severity among the open and acknowledged alerts, or null when there are none. */
    worstSeverity: z.enum(['critical', 'error', 'warning', 'info', 'unknown']).nullable(),
  }),
  /** `alerting`: an open alert; `acknowledged`: only acknowledged ones; `ok`: none. */
  state: z.enum(['ok', 'acknowledged', 'alerting']),
  metrics: z.object({
    status: z.enum(['ok', 'not_connected', 'rate_limited', 'error']),
    /** True when the numbers come from a fake. */
    mock: z.boolean(),
    errorRate: sparkPoints,
    latencyP95Ms: sparkPoints,
  }),
  lastDeploy: z
    .object({
      version: z.string(),
      env: z.string(),
      at: z.iso.datetime({ offset: true }),
      source: z.string(),
    })
    .nullable(),
  openIncidents: z.array(
    z.object({
      id: z.uuid(),
      number: z.number().int(),
      title: z.string(),
      severity: z.string(),
      status: z.string(),
    }),
  ),
});
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;
export const serviceStatusListSchema = z.object({
  generatedAt: z.iso.datetime({ offset: true }),
  windowHours: z.number().int(),
  stepMinutes: z.number().int(),
  items: z.array(serviceStatusSchema),
});
export type ServiceStatusList = z.infer<typeof serviceStatusListSchema>;
