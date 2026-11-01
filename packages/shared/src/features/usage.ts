/**
 * Product usage metrics, anomalies and the Client Health Score (T-205): this feature's own audit actions,
 * ticket event types and queue names (T-200), the rules the worker and the domain share, and the HTTP
 * schemas of `/v1/usage` and `/v1/orgs/:id/health`.
 *
 * Browser-safe (no Node imports). Every number marked `[ASSUMED]` is a default the owner has not
 * confirmed; each is one constant here, so changing it is one line and, for the score, a new
 * `HEALTH_FORMULA_VERSION`.
 */
import { z } from 'zod';

/** Audit `action` strings written by this feature. Metadata holds ids, counts and hashes, never SQL text or a value. */
export const USAGE_AUDIT_ACTIONS = {
  metricCreate: 'usage_metric.create',
  metricUpdate: 'usage_metric.update',
  /** The SQL template changed. Carries the SHA-256 of the old and the new text and the new version. */
  metricTemplateEdit: 'usage_metric.template_edit',
  /** A scheduled run finished (system actor). */
  metricRun: 'usage_metric.run',
  /** The rule found an anomaly and opened an alert (system actor). */
  anomalyDetect: 'usage_anomaly.detect',
  /** The Health Score of an organization was computed (system actor). */
  healthCompute: 'org_health.compute',
} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const USAGE_TICKET_EVENTS = {} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (producer and consumer: worker). */
export const USAGE_QUEUES = {
  usage: 'usage',
} as const satisfies Record<string, string>;

export const USAGE_JOBS = {
  /** Runs the metrics that are due. Repeats every minute; each metric has its own interval. */
  tick: 'tick',
  /** Computes today's Health Score of every active organization. Repeats daily. */
  health: 'health',
} as const;

// --- the rules ------------------------------------------------------------------------------------

/** A point is one hour. A template that returns anything else is refused. */
export const USAGE_BUCKET_SECONDS = 3600;
/** The first run of a metric reads this far back, so a baseline exists from the start `[ASSUMED]`. */
export const USAGE_BACKFILL_HOURS = 8 * 24;
/** Later runs re-read this many hours, so late data is picked up; the upsert makes it harmless `[ASSUMED]`. */
export const USAGE_REFRESH_HOURS = 3;
/** One run writes at most this many points; more is a failed run, not a partial one. */
export const USAGE_MAX_POINTS_PER_RUN = 5000;
/** Longest dimension value kept (characters). */
export const USAGE_DIM_VALUE_MAX = 100;
/** What a dimension value becomes when the redactor found personal data in it. */
export const USAGE_REDACTED_DIM = '[redacted]';
/** The special dimension that carries an organization id. */
export const USAGE_ORG_DIM = 'org';

/** Under this much history a series cannot raise an anomaly (PRD: "under 7 days of data does not fire"). */
export const ANOMALY_MIN_HISTORY_DAYS = 7;
/** Same-hour samples of the previous seven days needed for a median `[ASSUMED]`. */
export const ANOMALY_MIN_SAMPLES = 3;
/** One run opens at most this many anomalies; the rest wait for the next run `[ASSUMED]`. */
export const ANOMALY_RUN_CAP = 5;

/** What a run did, for the audit row and the metric's own status. */
export type UsageRunResult =
  | {
      readonly state: 'ok';
      readonly points: number;
      readonly anomalies: number;
      readonly capped: number;
    }
  | { readonly state: 'failed'; readonly code: UsageRunErrorCode };

/** Stable codes of a failed run: the text of a database error never reaches a row or a log. */
export const USAGE_RUN_ERROR_CODES = [
  'port_unavailable',
  'extra_column',
  'missing_column',
  'bad_row',
  'bad_bucket',
  'too_many_rows',
  'truncated',
] as const;
export type UsageRunErrorCode = (typeof USAGE_RUN_ERROR_CODES)[number];

// --- templates ------------------------------------------------------------------------------------

const WRITE_WORDS =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|execute|merge|vacuum|do)\b/i;

/**
 * Whether a template is shaped like a window query: one `SELECT` (or `WITH`), no second statement, no
 * write keyword, and the window bound as `$1` (from) and `$2` (to) with no other parameter. This is a
 * first line of defence for a head who types a template; the read-only login, the timeout and the row cap
 * of the data port (T-203c) are the real ones. Returns the reason, or null when the shape is fine.
 */
export function metricTemplateProblem(template: string): string | null {
  const raw = template.trim().replace(/;\s*$/, '');
  if (raw.length === 0) return 'The template is empty';
  // One statement: a semicolon anywhere (a comment included) is refused.
  if (raw.includes(';')) return 'Only one statement is allowed';
  // The comments are the author's notes (the starter templates open with some): judge the code.
  const text = raw
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();
  if (!/^(select|with)\b/i.test(text)) return 'The template must start with SELECT or WITH';
  if (WRITE_WORDS.test(text)) return 'The template contains a statement that writes';
  const params = new Set([...text.matchAll(/\$(\d+)/g)].map((match) => match[1]));
  if (!params.has('1') || !params.has('2') || params.size !== 2) {
    return 'The template must bind the window as $1 (from) and $2 (to) and nothing else';
  }
  return null;
}

const metricKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,62}$/, 'Lower case letters, digits and underscores');

const dimNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,30}$/, 'Lower case letters, digits and underscores')
  .refine((name) => name !== 'ts' && name !== 'value', {
    message: '`ts` and `value` are reserved',
  });

const templateSchema = z
  .string()
  .min(1)
  .max(8000)
  .superRefine((template, ctx) => {
    const problem = metricTemplateProblem(template);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
  });

const dimsSchema = z
  .array(dimNameSchema)
  .max(6)
  .refine((dims) => new Set(dims).size === dims.length, { message: 'Dimensions must be distinct' });

export const USAGE_DIRECTIONS = ['up', 'down'] as const;

export const createMetricSchema = z.strictObject({
  key: metricKeySchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(''),
  sqlTemplate: templateSchema,
  dims: dimsSchema.default([]),
  unit: z.string().trim().min(1).max(30).default('count'),
  refreshIntervalSeconds: z.number().int().min(300).max(86_400).default(3600),
  direction: z.enum(USAGE_DIRECTIONS).default('up'),
  anomalyRatio: z.number().gt(1).max(1000).default(3),
  anomalyMinAbs: z.number().min(0).max(1e9).default(10),
  active: z.boolean().default(true),
});
export type CreateMetric = z.infer<typeof createMetricSchema>;

export const updateMetricSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000),
    sqlTemplate: templateSchema,
    dims: dimsSchema,
    unit: z.string().trim().min(1).max(30),
    refreshIntervalSeconds: z.number().int().min(300).max(86_400),
    direction: z.enum(USAGE_DIRECTIONS),
    anomalyRatio: z.number().gt(1).max(1000),
    anomalyMinAbs: z.number().min(0).max(1e9),
    active: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to change' });
export type UpdateMetric = z.infer<typeof updateMetricSchema>;

export const metricIdParamSchema = z.object({ id: z.uuid() });
export type MetricIdParam = z.infer<typeof metricIdParamSchema>;

export const metricSchema = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  /** Present for a caller who may manage metrics only. */
  sqlTemplate: z.string().nullable(),
  templateVersion: z.number().int(),
  dims: z.array(z.string()),
  unit: z.string(),
  refreshIntervalSeconds: z.number().int(),
  direction: z.enum(USAGE_DIRECTIONS),
  anomalyRatio: z.number(),
  anomalyMinAbs: z.number(),
  active: z.boolean(),
  lastRunAt: z.iso.datetime({ offset: true }).nullable(),
  lastRunState: z.enum(['ok', 'failed']).nullable(),
  lastRunError: z.string().nullable(),
  lastRunPoints: z.number().int().nullable(),
});
export type Metric = z.infer<typeof metricSchema>;
export const metricListSchema = z.strictObject({ items: z.array(metricSchema) });

export const pointsQuerySchema = z.object({
  orgId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});
export type PointsQuery = z.infer<typeof pointsQuerySchema>;

export const metricPointSchema = z.strictObject({
  ts: z.iso.datetime({ offset: true }),
  orgId: z.uuid().nullable(),
  dims: z.record(z.string(), z.string()),
  value: z.number(),
});
export const metricPointsSchema = z.strictObject({ items: z.array(metricPointSchema) });

export const anomalySchema = z.strictObject({
  id: z.uuid(),
  metricId: z.uuid(),
  metricKey: z.string(),
  orgId: z.uuid().nullable(),
  dims: z.record(z.string(), z.string()),
  bucketTs: z.iso.datetime({ offset: true }),
  observed: z.number(),
  baseline: z.number(),
  baselineSamples: z.number().int(),
  alertId: z.uuid().nullable(),
  ticketId: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export const anomalyListSchema = z.strictObject({ items: z.array(anomalySchema) });
export const anomalyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

// --- Client Health Score (R-8.4) -----------------------------------------------------------------

/**
 * Formula v1 `[ASSUMED]`. A new weighting is a NEW version: the old snapshots keep their version and stay
 * readable, and going back is a change of this constant (reversible, no data lost).
 */
export const HEALTH_FORMULA_VERSION = 1;

export const HEALTH_COMPONENT_KEYS = [
  'ticket_volume',
  'sla',
  'csat',
  'incidents',
  'usage_anomalies',
] as const;
export type HealthComponentKey = (typeof HEALTH_COMPONENT_KEYS)[number];

export const HEALTH_WEIGHTS_V1: Readonly<Record<HealthComponentKey, number>> = {
  ticket_volume: 0.2,
  sla: 0.3,
  csat: 0.2,
  incidents: 0.15,
  usage_anomalies: 0.15,
};

/** An organization younger than this has no baseline: its components say "no data" `[ASSUMED]`. */
export const HEALTH_MIN_OBSERVATION_DAYS = 28;
/** Components with data must carry at least this share of the weights, else there is no score `[ASSUMED]`. */
export const HEALTH_MIN_WEIGHT_SHARE = 0.5;
/** Tickets in the SLA window needed before the SLA component speaks. */
export const HEALTH_MIN_SLA_TICKETS = 5;
/** CSAT answers needed before the CSAT component speaks. */
export const HEALTH_MIN_CSAT_ANSWERS = 3;

export const healthComponentSchema = z.strictObject({
  key: z.enum(HEALTH_COMPONENT_KEYS),
  weight: z.number(),
  status: z.enum(['ok', 'no_data']),
  /** 0 to 100, null when there was no data. */
  score: z.number().min(0).max(100).nullable(),
  /** Facts behind the number (counts, ratios). Never a ticket subject or a name. */
  detail: z.record(z.string(), z.number().nullable()),
});
export type HealthComponent = z.infer<typeof healthComponentSchema>;

export const healthSnapshotSchema = z.strictObject({
  orgId: z.uuid(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  formulaVersion: z.number().int(),
  /** `insufficient_data` is shown as such; there is no score then (N5). */
  status: z.enum(['scored', 'insufficient_data']),
  score: z.number().int().min(0).max(100).nullable(),
  components: z.array(healthComponentSchema),
});
export type HealthSnapshot = z.infer<typeof healthSnapshotSchema>;

export const orgHealthSchema = z.strictObject({ snapshot: healthSnapshotSchema.nullable() });

export const healthListSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      orgId: z.uuid(),
      status: z.enum(['scored', 'insufficient_data']),
      score: z.number().int().nullable(),
      day: z.string(),
    }),
  ),
});
export const healthListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const orgIdParamSchema = z.object({ id: z.uuid() });
