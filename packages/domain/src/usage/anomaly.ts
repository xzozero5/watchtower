import { createHash } from 'node:crypto';

import { schema, type Database } from '@watchtower/db';
import {
  AI_JOBS,
  AI_OUTBOX_JOB_OPTIONS,
  ANOMALY_MIN_HISTORY_DAYS,
  ANOMALY_MIN_SAMPLES,
  ANOMALY_RUN_CAP,
  QUEUE_NAMES,
  TICKET_EVENT_TYPES,
  USAGE_AUDIT_ACTIONS,
  USAGE_REFRESH_HOURS,
  normalizedAlertSchema,
  type RealtimeEvent,
} from '@watchtower/shared';
import { eq, sql } from 'drizzle-orm';

import { ingestAlert } from '../alerts/ingest.js';
import { recordAuditInTx } from '../audit.js';
import { enqueueJob } from '../outbox.js';
import { recordTicketEvent } from '../tickets/support.js';
import { Effects, type DbTransaction, type DomainContext } from '../types.js';

export interface AnomalyInput {
  readonly observed: number;
  readonly baseline: number;
  readonly samples: number;
  /** Whether the series has a point at least `ANOMALY_MIN_HISTORY_DAYS` older than the one judged. */
  readonly hasHistory: boolean;
  readonly ratio: number;
  readonly minAbs: number;
  readonly direction: 'up' | 'down';
}

/**
 * The rule (R-8.1), pure. Nothing fires without a week of history for the series and enough same-hour
 * samples to take a median of; then `up` fires when the value is more than `ratio` times the baseline AND
 * more than `minAbs` above it (a rise from 1 to 4 is not news), and `down` mirrors that.
 */
export function isAnomalous(input: AnomalyInput): boolean {
  if (!input.hasHistory || input.samples < ANOMALY_MIN_SAMPLES) return false;
  if (input.direction === 'up') {
    return (
      input.observed > input.baseline * input.ratio &&
      input.observed - input.baseline > input.minAbs
    );
  }
  return (
    input.observed < input.baseline / input.ratio && input.baseline - input.observed > input.minAbs
  );
}

export interface DetectOptions {
  /** Anomalies opened by one run at most; the rest wait for the next run. */
  readonly cap?: number;
  /** Ask the T-108 pipeline for a brief (and, at stage 2, a draft for approval) on the ticket. Default true. */
  readonly requestAiBrief?: boolean;
}

export interface DetectResult {
  readonly opened: number;
  /** Anomalies found that were left for a later run by the cap. */
  readonly capped: number;
  readonly events: RealtimeEvent[];
}

type MetricRow = typeof schema.usageMetricDef.$inferSelect;

interface Candidate {
  readonly ts: Date;
  readonly dimsHash: string;
  readonly orgId: string | null;
  readonly dims: Record<string, string>;
  readonly observed: number;
  readonly baseline: number | null;
  readonly samples: number;
  readonly hasHistory: boolean;
}

const utcDay = (date: Date): string => date.toISOString().slice(0, 10);

/** One anomaly per metric, series and UTC day: the key of `usage_anomaly.dedupe_key`. */
export function anomalyDedupeKey(metricId: string, dimsHash: string, bucket: Date): string {
  return createHash('sha256')
    .update(JSON.stringify(['usage_anomaly', metricId, dimsHash, utcDay(bucket)]))
    .digest('hex');
}

/** The fingerprint of the alert: one open alert per series, whatever the day. */
function anomalyFingerprint(metricId: string, dimsHash: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['usage_anomaly', metricId, dimsHash]))
    .digest('hex');
}

/**
 * The last complete hours of a metric against their same-hour median of the previous seven days. Every
 * time is the database clock; "complete" means the hour has ended by the database's clock, so the hour
 * still being filled in (a partial count) is never judged.
 */
async function candidatesOf(db: Database['db'], metric: MetricRow): Promise<Candidate[]> {
  const result = await db.execute<{
    // The driver returns what the column type says; numbers may arrive as text, so both are accepted.
    ts: Date | string;
    dims_hash: string;
    org_id: string | null;
    dims: Record<string, string>;
    observed: number | string;
    baseline: number | string | null;
    samples: number | string;
    has_history: boolean;
  }>(sql`
    SELECT c.ts, c.dims_hash, c.org_id, c.dims, c.value AS observed, b.baseline, b.samples, b.has_history
    FROM usage_metric_point c
    CROSS JOIN LATERAL (
      SELECT
        percentile_cont(0.5) WITHIN GROUP (ORDER BY h.value)
          FILTER (WHERE h.ts >= c.ts - interval '7 days' AND extract(epoch FROM (c.ts - h.ts))::bigint % 86400 = 0) AS baseline,
        (count(*) FILTER (WHERE h.ts >= c.ts - interval '7 days' AND extract(epoch FROM (c.ts - h.ts))::bigint % 86400 = 0))::int AS samples,
        COALESCE(bool_or(h.ts <= c.ts - make_interval(days => ${ANOMALY_MIN_HISTORY_DAYS})), false) AS has_history
      FROM usage_metric_point h
      WHERE h.metric_id = c.metric_id AND h.dims_hash = c.dims_hash
        AND h.ts < c.ts AND h.ts >= c.ts - interval '9 days'
    ) b
    WHERE c.metric_id = ${metric.id}
      AND c.ts >= date_trunc('hour', clock_timestamp()) - make_interval(hours => ${USAGE_REFRESH_HOURS})
      AND c.ts < date_trunc('hour', clock_timestamp())
    ORDER BY c.ts DESC, c.dims_hash
  `);
  return result.rows.map((row) => ({
    ts: new Date(row.ts),
    dimsHash: row.dims_hash,
    orgId: row.org_id,
    dims: row.dims,
    observed: Number(row.observed),
    baseline: row.baseline === null ? null : Number(row.baseline),
    samples: Number(row.samples),
    hasHistory: row.has_history,
  }));
}

/**
 * Looks at the last complete hours of one metric and opens what the rule finds (R-8.3): one alert and,
 * for a series that has an organization, one internal ticket, each in its own transaction with the
 * `usage_anomaly` row that dedupes it. The same series raises at most one per UTC day however many runs see
 * it, and one run opens at most `cap` (the rest are counted and picked up by a later run). The T-108
 * pipeline is asked for a brief on the ticket after the commit through the outbox; what it drafts for the
 * organization's contact is a draft for a person to approve (N3), exactly as for any other ticket.
 */
export async function detectUsageAnomalies(
  db: Database['db'],
  ctx: DomainContext,
  metric: MetricRow,
  options: DetectOptions = {},
): Promise<DetectResult> {
  const cap = options.cap ?? ANOMALY_RUN_CAP;
  const events: RealtimeEvent[] = [];
  const hits = (await candidatesOf(db, metric)).filter(
    (candidate) =>
      candidate.baseline !== null &&
      isAnomalous({
        observed: candidate.observed,
        baseline: candidate.baseline,
        samples: candidate.samples,
        hasHistory: candidate.hasHistory,
        ratio: Number(metric.anomalyRatio),
        minAbs: Number(metric.anomalyMinAbs),
        direction: metric.direction as 'up' | 'down',
      }),
  );

  let opened = 0;
  let capped = 0;
  for (const hit of hits) {
    const dedupeKey = anomalyDedupeKey(metric.id, hit.dimsHash, hit.ts);
    const [known] = await db
      .select({ id: schema.usageAnomaly.id })
      .from(schema.usageAnomaly)
      .where(eq(schema.usageAnomaly.dedupeKey, dedupeKey))
      .limit(1);
    if (known !== undefined) continue;
    if (opened >= cap) {
      capped += 1;
      continue;
    }
    const fired = await db.transaction((tx) =>
      openAnomaly(tx, ctx, metric, hit, dedupeKey, options.requestAiBrief ?? true, events),
    );
    if (fired) opened += 1;
  }
  return { opened, capped, events };
}

async function openAnomaly(
  tx: DbTransaction,
  ctx: DomainContext,
  metric: MetricRow,
  hit: Candidate,
  dedupeKey: string,
  requestAiBrief: boolean,
  events: RealtimeEvent[],
): Promise<boolean> {
  const fx = new Effects();
  const [row] = await tx
    .insert(schema.usageAnomaly)
    .values({
      metricId: metric.id,
      orgId: hit.orgId,
      dimsHash: hit.dimsHash,
      dims: hit.dims,
      bucketTs: hit.ts,
      observed: hit.observed,
      baseline: hit.baseline ?? 0,
      baselineSamples: Math.min(7, Math.max(1, hit.samples)),
      dedupeKey,
    })
    .onConflictDoNothing({ target: schema.usageAnomaly.dedupeKey })
    .returning({ id: schema.usageAnomaly.id });
  // Another run opened it first (two workers, or a repeat): nothing to do, nothing to count.
  if (row === undefined) return false;

  // The alert says what moved and never whose: the title and summary carry the metric, not the organization.
  const unit = metric.unit;
  const alert = await ingestAlert(tx, ctx, {
    alert: normalizedAlertSchema.parse({
      source: 'usage_anomaly',
      providerEventId: dedupeKey,
      fingerprint: anomalyFingerprint(metric.id, hit.dimsHash),
      state: 'firing',
      severity: 'warning',
      title: `Usage anomaly: ${metric.name}`.slice(0, 200),
      summary: `Observed ${String(hit.observed)} ${unit} against a baseline of ${String(hit.baseline)} (${String(hit.samples)} same-hour samples)`,
      conditionName: null,
      labels: {},
      url: null,
      occurredAt: null,
      renotify: false,
      payload: {
        kind: 'usage_anomaly',
        observedValue: hit.observed,
        thresholdValue: hit.baseline ?? 0,
      },
    }),
  });
  fx.events.push(...alert.events);
  const alertId = 'alertId' in alert.value ? alert.value.alertId : null;

  let ticketId: string | null = null;
  if (hit.orgId !== null) {
    ticketId = await openInternalTicket(tx, ctx, metric, hit, hit.orgId, row.id);
    if (requestAiBrief) {
      await enqueueJob(tx, ctx.config, {
        queue: QUEUE_NAMES.ai,
        name: AI_JOBS.summarize,
        jobId: `ai-summarize-${ticketId}`,
        payload: { ticketId },
        options: AI_OUTBOX_JOB_OPTIONS,
      });
    }
  }
  await tx
    .update(schema.usageAnomaly)
    .set({ alertId, ticketId })
    .where(eq(schema.usageAnomaly.id, row.id));
  await recordAuditInTx(tx, ctx, fx, {
    action: USAGE_AUDIT_ACTIONS.anomalyDetect,
    targetType: 'usage_anomaly',
    targetId: row.id,
    metadata: { metric: metric.key, alertId, ticketId, hasOrg: hit.orgId !== null },
  });
  events.push(...fx.events);
  return true;
}

/**
 * The ticket for the people who look after the organization. `internal` channel: nothing is delivered on
 * it, the customer never sees it (client views filter the channel out), and its one message is an internal
 * note. No realtime event is sent for it. The wording holds the metric, the numbers and the hour; the
 * dimension values are the stored (redacted) ones.
 */
async function openInternalTicket(
  tx: DbTransaction,
  ctx: DomainContext,
  metric: MetricRow,
  hit: Candidate,
  orgId: string,
  anomalyId: string,
): Promise<string> {
  const dimLines = Object.entries(hit.dims).map(([name, value]) => `${name}: ${value}`);
  const body = [
    `${metric.name}: ${String(hit.observed)} ${metric.unit} in the hour starting ${hit.ts.toISOString()}, against a baseline of ${String(hit.baseline)} (median of ${String(hit.samples)} same-hour values of the previous week).`,
    ...dimLines,
  ].join('\n');
  const [ticket] = await tx
    .insert(schema.ticket)
    .values({
      subject: `Usage anomaly: ${metric.name}`.slice(0, 300),
      orgId,
      channel: 'internal',
      channelAccountId: null,
      priority: 'P3',
      status: 'new',
      tags: ['usage-anomaly'],
      customFields: { usageAnomalyId: anomalyId, metric: metric.key },
    })
    .returning({ id: schema.ticket.id });
  if (ticket === undefined) throw new Error('ticket insert returned no row');
  await tx.insert(schema.message).values({
    ticketId: ticket.id,
    channelAccountId: null,
    direction: 'internal',
    bodyText: body,
    visibility: 'internal',
    deliveryStatus: 'not_applicable',
  });
  await recordTicketEvent(tx, ticket.id, TICKET_EVENT_TYPES.created, ctx.actor, 'internal', {
    channel: 'internal',
    priority: 'P3',
    source: 'usage_anomaly',
  });
  return ticket.id;
}
