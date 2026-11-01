/**
 * Alerts, service catalog and escalation policies (T-201, ADR-015): this feature's own audit actions,
 * ticket event types and queue names (T-123a pattern), the alert that crosses from the connectors
 * (producer) to the domain (consumer), and the HTTP schemas of `/v1/alerts`, `/v1/services` and
 * `/v1/escalation-policies`.
 *
 * Browser-safe (no `node:crypto`, no Node imports). The one place that decides which parts of a
 * provider payload may be stored is `sanitizeAlertPayload`: connectors call it when they normalize,
 * and the domain calls it again before it writes, so a connector that forgets cannot widen what
 * `alert.payload` keeps (N4).
 */
import { z } from 'zod';

/** Audit `action` strings written by this feature. Metadata holds ids and counts, never a payload. */
export const ALERTS_AUDIT_ACTIONS = {
  /** A service was added to the catalog. */
  serviceCreate: 'service.create',
  /** A service of the catalog was edited. */
  serviceUpdate: 'service.update',
  /** A service was removed from the catalog (its alerts become unmapped). */
  serviceDelete: 'service.delete',
  /** An escalation policy was added. */
  escalationPolicyCreate: 'escalation_policy.create',
  /** An escalation policy was edited. */
  escalationPolicyUpdate: 'escalation_policy.update',
  /** An escalation policy was removed (its services fall back to the default policy). */
  escalationPolicyDelete: 'escalation_policy.delete',
} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const ALERTS_TICKET_EVENTS = {} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (T-201d adds the escalation sweep). */
export const ALERTS_QUEUES = {} as const satisfies Record<string, string>;

// --- vocabulary ---------------------------------------------------------------------------------

/** Where an alert came from. `gcp_logging` = a log-based alert policy; both GCP ones arrive over Pub/Sub. */
export const ALERT_SOURCES = ['gcp_monitoring', 'gcp_logging', 'alertmanager'] as const;
export type AlertSource = (typeof ALERT_SOURCES)[number];
export const alertSourceSchema = z.enum(ALERT_SOURCES);

/** `unknown`: the provider did not say (GCP "no severity", an Alertmanager alert without `severity`). */
export const ALERT_SEVERITIES = ['critical', 'error', 'warning', 'info', 'unknown'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];
export const alertSeveritySchema = z.enum(ALERT_SEVERITIES);

/** `open` and `acknowledged` are the open states: at most one alert per fingerprint is in either. */
export const ALERT_STATES = ['open', 'acknowledged', 'resolved'] as const;
export type AlertState = (typeof ALERT_STATES)[number];
export const alertStateSchema = z.enum(ALERT_STATES);

/** What one delivery says about the alert. `closed` from GCP and `resolved` from Alertmanager are both `resolved`. */
export const ALERT_SIGNAL_STATES = ['firing', 'resolved'] as const;
export type AlertSignalState = (typeof ALERT_SIGNAL_STATES)[number];

export const ALERT_EVENT_TYPES = ['fired', 'renotified', 'resolved'] as const;
export type AlertEventType = (typeof ALERT_EVENT_TYPES)[number];

// --- what `alert.payload` may keep (N4) ----------------------------------------------------------

/**
 * The only keys `alert.payload` may hold. Everything else a provider sends (documentation text,
 * free-form annotations, request URLs, log lines, labels nobody listed) is dropped. Adding a key is a
 * decision: it needs a reason that it can never carry customer data.
 */
export const ALERT_PAYLOAD_KEYS = [
  'kind',
  'policyName',
  'conditionName',
  'alertname',
  'summary',
  'url',
  'generatorUrl',
  'externalUrl',
  'resourceType',
  'resourceName',
  'resourceDisplayName',
  'metricType',
  'observedValue',
  'thresholdValue',
  'incidentId',
  'scopingProjectId',
  'providerFingerprint',
  'providerSeverity',
  'startedAt',
  'endedAt',
  'renotify',
  'labels',
  'userLabels',
] as const;
export type AlertPayloadKey = (typeof ALERT_PAYLOAD_KEYS)[number];

/**
 * Label keys that survive into `alert.payload.labels` / `userLabels` and into service matching.
 * Resource and infrastructure coordinates only; a label such as `customer` or `email` is not here.
 * (Every label still feeds the fingerprint, so alerts that differ only by a dropped label stay apart.)
 */
export const ALERT_LABEL_KEYS: readonly string[] = [
  'alertname',
  'severity',
  'service',
  'service_name',
  'job',
  'instance',
  'instance_id',
  'namespace',
  'namespace_name',
  'cluster',
  'cluster_name',
  'env',
  'environment',
  'team',
  'region',
  'location',
  'zone',
  'project_id',
  'pod',
  'pod_name',
  'container',
  'container_name',
  'deployment',
  'revision_name',
  'configuration_name',
  'function_name',
  'database_id',
  'host',
  'module_id',
  'version_id',
];

export const ALERT_PAYLOAD_MAX_BYTES = 8192;
export const ALERT_SUMMARY_MAX_CHARS = 500;
const ALERT_VALUE_MAX_CHARS = 200;
const ALERT_LABELS_MAX = 30;

export type AlertPayloadValue = string | number | boolean | null | Readonly<Record<string, string>>;
export type AlertPayload = Partial<Record<AlertPayloadKey, AlertPayloadValue>>;

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : value.slice(0, max);

/** Label keys and values, allow-listed by key, bounded in count and length. */
export function allowedLabels(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return out;
  for (const key of Object.keys(input).toSorted()) {
    if (!ALERT_LABEL_KEYS.includes(key)) continue;
    const value = (input as Record<string, unknown>)[key];
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    out[key] = truncate(String(value), ALERT_VALUE_MAX_CHARS);
    if (Object.keys(out).length >= ALERT_LABELS_MAX) break;
  }
  return out;
}

/**
 * Keeps only allow-listed keys, with bounded values, and at most `ALERT_PAYLOAD_MAX_BYTES` once
 * serialized (the largest optional parts go first). Pure; safe to run twice.
 */
export function sanitizeAlertPayload(raw: unknown): AlertPayload {
  const out: Record<string, AlertPayloadValue> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  const source = raw as Record<string, unknown>;
  for (const key of ALERT_PAYLOAD_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    if (key === 'labels' || key === 'userLabels') {
      const labels = allowedLabels(value);
      if (Object.keys(labels).length > 0) out[key] = labels;
    } else if (typeof value === 'string') {
      out[key] = truncate(value, key === 'summary' ? ALERT_SUMMARY_MAX_CHARS : 500);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    }
  }
  let kept: Record<string, AlertPayloadValue> = out;
  for (const drop of ['userLabels', 'labels', 'summary']) {
    if (JSON.stringify(kept).length <= ALERT_PAYLOAD_MAX_BYTES) break;
    kept = Object.fromEntries(Object.entries(kept).filter(([key]) => key !== drop));
  }
  return kept;
}

// --- the alert after a connector normalized it ---------------------------------------------------

const httpUrl = z
  .url({ protocol: /^https?$/ })
  .max(1000)
  .nullable();

/**
 * One alert delivery as the domain wants it. `providerEventId` is the idempotency key together with
 * `source`: a redelivery carries the same one, a second real fire a different one. `fingerprint` is a
 * SHA-256 hex digest computed by the connector from the provider payload.
 */
export const normalizedAlertSchema = z.strictObject({
  source: alertSourceSchema,
  providerEventId: z.string().min(1).max(300),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  state: z.enum(ALERT_SIGNAL_STATES),
  severity: alertSeveritySchema,
  title: z.string().min(1).max(200),
  summary: z.string().max(ALERT_SUMMARY_MAX_CHARS).nullable(),
  conditionName: z.string().max(200).nullable(),
  /** Allow-listed labels only: what service matching and the screen may use. */
  labels: z.record(z.string(), z.string()),
  url: httpUrl,
  /** When the provider says it happened (`started_at`, `ended_at`, `startsAt`). Shown, never used to decide. */
  occurredAt: z.iso.datetime({ offset: true }).nullable(),
  renotify: z.boolean(),
  payload: z.record(z.string(), z.unknown()),
});
export type NormalizedAlert = z.infer<typeof normalizedAlertSchema>;

/**
 * The Pub/Sub push body for an alert notification. Like the Gmail envelope but with room for the
 * payload: a v1.2 incident with its documentation easily passes the 4 KB the Gmail one allows.
 */
export const alertPubsubEnvelopeSchema = z.object({
  message: z.object({
    // Under the 100 kB default body limit of the api, base64 included.
    data: z.string().min(1).max(80_000),
    messageId: z.string().regex(/^[0-9]{1,30}$/),
    publishTime: z.string().max(64).optional(),
  }),
  subscription: z.string().max(300).optional(),
});
export type AlertPubsubEnvelope = z.infer<typeof alertPubsubEnvelopeSchema>;

// --- webhook signature ---------------------------------------------------------------------------

/** `X-Watchtower-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>." + raw body>` */
export const ALERT_WEBHOOK_SIGNATURE_HEADER = 'x-watchtower-signature';
export const ALERT_WEBHOOK_TOLERANCE_SECONDS = 300;

// --- service catalog (R-3.7) ---------------------------------------------------------------------

const labelKey = z.string().trim().min(1).max(64);
const labelValue = z.string().trim().min(1).max(ALERT_VALUE_MAX_CHARS);

/**
 * How an alert finds its service. A rule matches when every condition it names holds: the source,
 * the policy name / alertname (case-insensitive), and each label (exact value). A service matches
 * when any of its rules does; the rule with the most conditions wins between services.
 */
export const serviceMatchRuleSchema = z
  .strictObject({
    source: alertSourceSchema.optional(),
    policyName: z.string().trim().min(1).max(200).optional(),
    labels: z.record(labelKey, labelValue).default({}),
  })
  .refine(
    (rule) =>
      rule.source !== undefined ||
      rule.policyName !== undefined ||
      Object.keys(rule.labels).length > 0,
    {
      message: 'A rule needs a source, a policy name or at least one label',
    },
  )
  .refine((rule) => Object.keys(rule.labels).length <= 10, {
    message: 'At most 10 labels per rule',
  })
  .refine((rule) => Object.keys(rule.labels).every((key) => ALERT_LABEL_KEYS.includes(key)), {
    message: 'Only label keys that alerts keep can be matched',
  });
export type ServiceMatchRule = z.infer<typeof serviceMatchRuleSchema>;

const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Lower case letters, digits and single dashes');

const optionalHttpUrl = z
  .url({ protocol: /^https?$/ })
  .max(1000)
  .nullable();

export const serviceFieldsSchema = z.strictObject({
  slug: slugSchema,
  name: z.string().trim().min(1).max(120),
  ownerQueueId: z.uuid().nullable(),
  runbookUrl: optionalHttpUrl,
  runbookArticleId: z.uuid().nullable(),
  dashboardUrl: optionalHttpUrl,
  matchRules: z.array(serviceMatchRuleSchema).max(20),
  repos: z.array(z.string().trim().min(1).max(200)).max(20),
  escalationPolicyId: z.uuid().nullable(),
  active: z.boolean(),
});

export const createServiceSchema = serviceFieldsSchema.partial({
  ownerQueueId: true,
  runbookUrl: true,
  runbookArticleId: true,
  dashboardUrl: true,
  matchRules: true,
  repos: true,
  escalationPolicyId: true,
  active: true,
});
export type CreateService = z.infer<typeof createServiceSchema>;

export const updateServiceSchema = serviceFieldsSchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type UpdateService = z.infer<typeof updateServiceSchema>;

export const serviceSchema = serviceFieldsSchema.extend({
  id: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type Service = z.infer<typeof serviceSchema>;
export const serviceListSchema = z.object({ items: z.array(serviceSchema) });
export const serviceIdParamSchema = z.object({ id: z.uuid() });
export type ServiceIdParam = z.infer<typeof serviceIdParamSchema>;

// --- escalation policy (R-3.8) -------------------------------------------------------------------

export const ESCALATION_TARGETS = ['on_shift', 'lead', 'head'] as const;
export type EscalationTarget = (typeof ESCALATION_TARGETS)[number];

/** Seconds after the alert first fired at which this target is told. The first step is at 0. */
export const escalationStepSchema = z.strictObject({
  target: z.enum(ESCALATION_TARGETS),
  afterSeconds: z.number().int().min(0).max(86_400),
});
export type EscalationStep = z.infer<typeof escalationStepSchema>;

export const escalationStepsSchema = z
  .array(escalationStepSchema)
  .min(1)
  .max(5)
  .refine((steps) => steps[0]?.afterSeconds === 0, { message: 'The first step is at 0 seconds' })
  .refine(
    (steps) =>
      steps.every(
        (step, index) => index === 0 || step.afterSeconds > (steps[index - 1]?.afterSeconds ?? 0),
      ),
    { message: 'Steps must be in strictly increasing time order' },
  );

/**
 * `[ASSUMED]` T1 = 5 minutes to the lead, T2 = 15 minutes to the head (PRD R-3.8 names T1 and T2
 * without values). Migration 0041 seeds the same default; `po` confirms the numbers.
 */
export const DEFAULT_ESCALATION_STEPS: readonly EscalationStep[] = [
  { target: 'on_shift', afterSeconds: 0 },
  { target: 'lead', afterSeconds: 300 },
  { target: 'head', afterSeconds: 900 },
];

export const createEscalationPolicySchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  steps: escalationStepsSchema,
});
export type CreateEscalationPolicy = z.infer<typeof createEscalationPolicySchema>;

export const updateEscalationPolicySchema = createEscalationPolicySchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type UpdateEscalationPolicy = z.infer<typeof updateEscalationPolicySchema>;

export const escalationPolicySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  steps: z.array(escalationStepSchema),
  isDefault: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type EscalationPolicy = z.infer<typeof escalationPolicySchema>;
export const escalationPolicyListSchema = z.object({ items: z.array(escalationPolicySchema) });
export const escalationPolicyIdParamSchema = z.object({ id: z.uuid() });
export type EscalationPolicyIdParam = z.infer<typeof escalationPolicyIdParamSchema>;

// --- alerts (read side) --------------------------------------------------------------------------

export const alertSchema = z.object({
  id: z.uuid(),
  fingerprint: z.string(),
  source: alertSourceSchema,
  serviceId: z.uuid().nullable(),
  severity: alertSeveritySchema,
  state: alertStateSchema,
  title: z.string(),
  summary: z.string().nullable(),
  count: z.number().int().positive(),
  firstSeenAt: z.iso.datetime({ offset: true }),
  lastSeenAt: z.iso.datetime({ offset: true }),
  resolvedAt: z.iso.datetime({ offset: true }).nullable(),
  ackedAt: z.iso.datetime({ offset: true }).nullable(),
  ackedBy: z.uuid().nullable(),
  incidentId: z.uuid().nullable(),
  payload: z.record(z.string(), z.unknown()),
});
export type Alert = z.infer<typeof alertSchema>;

export const alertEventSchema = z.object({
  id: z.uuid(),
  type: z.enum(ALERT_EVENT_TYPES),
  occurredAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});

export const alertDetailSchema = alertSchema.extend({ events: z.array(alertEventSchema) });
export type AlertDetail = z.infer<typeof alertDetailSchema>;

export const alertListQuerySchema = z.object({
  state: alertStateSchema.optional(),
  source: alertSourceSchema.optional(),
  serviceId: z.uuid().optional(),
  /** `true`: only alerts no service claims. */
  unmapped: z.stringbool().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(300).optional(),
});
export type AlertListQuery = z.infer<typeof alertListQuerySchema>;

export const alertListSchema = z.object({
  items: z.array(alertSchema),
  nextCursor: z.string().nullable(),
});
export const alertIdParamSchema = z.object({ id: z.uuid() });
export type AlertIdParam = z.infer<typeof alertIdParamSchema>;

/** Alerts no service claims, grouped by source and title: what the weekly "unmapped" look reads. */
export const unmappedAlertGroupSchema = z.object({
  source: alertSourceSchema,
  title: z.string(),
  alerts: z.number().int().nonnegative(),
  occurrences: z.number().int().nonnegative(),
  openAlerts: z.number().int().nonnegative(),
  lastSeenAt: z.iso.datetime({ offset: true }),
});
export const unmappedAlertsSchema = z.object({
  /** Days looked back; fixed server side. */
  windowDays: z.number().int().positive(),
  items: z.array(unmappedAlertGroupSchema),
});
export const UNMAPPED_WINDOW_DAYS = 7;

/** What the receivers answer: counts only. */
export const alertIngestResultSchema = z.object({
  /** Deliveries that opened an alert, raised its count or closed it. */
  accepted: z.number().int().nonnegative(),
  /** Deliveries seen before (a redelivery): ignored. */
  duplicates: z.number().int().nonnegative(),
  /** Deliveries that could not be used (not a closed alert of ours, or unreadable): acknowledged and dropped. */
  ignored: z.number().int().nonnegative(),
});
export type AlertIngestResult = z.infer<typeof alertIngestResultSchema>;
