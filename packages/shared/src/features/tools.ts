/**
 * Investigation tools, rate budget and ad-hoc runs (T-203): this feature's own audit actions, ticket event types and queue names (T-200).
 *
 * Created empty by T-200 so the Phase 2 tasks that run in parallel never edit the same lines of
 * `./index.ts`, `auth.ts`, `ticketing.ts` or `queues.ts`. The task that owns this feature adds its
 * entries here and nowhere else in `packages/shared` (see `./gmail.ts` for the conventions).
 */
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
