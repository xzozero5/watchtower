import { schema, type Database } from '@watchtower/db';
import {
  USAGE_AUDIT_ACTIONS,
  USAGE_BACKFILL_HOURS,
  USAGE_MAX_POINTS_PER_RUN,
  USAGE_REFRESH_HOURS,
  type RealtimeEvent,
  type UsageRunErrorCode,
} from '@watchtower/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { Effects, type DomainContext } from '../types.js';
import { detectUsageAnomalies, type DetectOptions } from './anomaly.js';
import { parseUsageRows, type ParsedPoint, type UsageDataResult } from './rows.js';

export type { UsageDataResult } from './rows.js';

/**
 * What the scheduler needs from the product data, and nothing more: one parameterised read of a stored
 * template for a window. The window is bound as `$1` (from) and `$2` (to); a value is never put into the
 * SQL text. The adapter over the T-203 `DataQueryClient` supplies the guardrails of the read (read-only
 * transaction, statement timeout, row cap, personal-data allow-list, the shared rate and cost budget): the
 * scheduler leans on them and does not duplicate them (N2). Method name: a read, never a write verb.
 */
export interface UsageDataPort {
  query(request: {
    readonly metricKey: string;
    readonly sql: string;
    readonly params: readonly [Date, Date];
    readonly maxRows: number;
  }): Promise<UsageDataResult>;
}

export interface RunUsageOptions {
  readonly port: UsageDataPort;
  /** Maps a dimension value to what may be stored: the PII redactor in production. */
  readonly sanitizeDim: (value: string) => string;
  readonly maxPoints?: number;
  readonly detect?: DetectOptions;
}

export type RunOutcome =
  | {
      readonly state: 'ok';
      readonly points: number;
      readonly skippedUnknownOrg: number;
      readonly anomalies: number;
      readonly capped: number;
      readonly events: RealtimeEvent[];
    }
  | { readonly state: 'failed'; readonly code: UsageRunErrorCode }
  | { readonly state: 'not_due' };

const dbNow = sql`clock_timestamp()`;
const CHUNK = 500;

/**
 * Runs one metric if it is due: claims it (so a second worker skips it), reads the window through the port,
 * checks the answer against the declaration, and replaces the points of the window (upsert: running the same
 * window again changes nothing). Then judges the last complete hours (`detectUsageAnomalies`).
 *
 * Time: the claim, the window and "due" are all the database clock. The first run of a metric (and the run
 * after its template changed) reads `USAGE_BACKFILL_HOURS`; later ones re-read `USAGE_REFRESH_HOURS`.
 * A failed run writes nothing and records a stable code on the metric, never the text of an error.
 */
export async function runUsageMetric(
  db: Database['db'],
  ctx: DomainContext,
  options: RunUsageOptions,
  metricId: string,
  force = false,
): Promise<RunOutcome> {
  const claim = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        metric: schema.usageMetricDef,
        due: sql<boolean>`${schema.usageMetricDef.lastRunAt} IS NULL
          OR ${schema.usageMetricDef.lastRunAt}
             + make_interval(secs => ${schema.usageMetricDef.refreshIntervalSeconds}) <= clock_timestamp()`,
      })
      .from(schema.usageMetricDef)
      .where(and(eq(schema.usageMetricDef.id, metricId), eq(schema.usageMetricDef.active, true)))
      .for('update', { skipLocked: true })
      .limit(1);
    if (row === undefined || (!row.due && !force)) return null;
    const backfill = row.metric.lastRunState !== 'ok';
    const hours = backfill ? USAGE_BACKFILL_HOURS : USAGE_REFRESH_HOURS;
    await tx
      .update(schema.usageMetricDef)
      .set({ lastRunAt: dbNow })
      .where(eq(schema.usageMetricDef.id, metricId));
    const clock = await tx.execute<{ from: Date; to: Date }>(
      sql`SELECT date_trunc('hour', clock_timestamp()) - make_interval(hours => ${hours}) AS "from",
                 clock_timestamp() AS "to"`,
    );
    const window = clock.rows[0];
    if (window === undefined) throw new Error('the database returned no clock');
    return { metric: row.metric, from: new Date(window.from), to: new Date(window.to) };
  });
  if (claim === null) return { state: 'not_due' };
  const { metric } = claim;

  const finish = async (
    outcome: { state: 'ok'; points: number } | { state: 'failed'; code: UsageRunErrorCode },
  ): Promise<void> => {
    const fx = new Effects();
    await db.transaction(async (tx) => {
      await tx
        .update(schema.usageMetricDef)
        .set({
          lastRunState: outcome.state,
          lastRunError: outcome.state === 'failed' ? outcome.code : null,
          lastRunPoints: outcome.state === 'ok' ? outcome.points : null,
        })
        .where(eq(schema.usageMetricDef.id, metric.id));
      // A run is audited when its state changes (first success, a failure, a recovery), not every hour.
      if (outcome.state === 'failed' || metric.lastRunState !== 'ok') {
        await recordAuditInTx(tx, ctx, fx, {
          action: USAGE_AUDIT_ACTIONS.metricRun,
          targetType: 'usage_metric',
          targetId: metric.id,
          outcome: outcome.state === 'ok' ? 'success' : 'failure',
          metadata: {
            key: metric.key,
            version: metric.templateVersion,
            ...(outcome.state === 'ok' ? { points: outcome.points } : { code: outcome.code }),
          },
        });
      }
    });
  };

  let answer: UsageDataResult;
  try {
    answer = await options.port.query({
      metricKey: metric.key,
      sql: metric.sqlTemplate,
      params: [claim.from, claim.to],
      maxRows: (options.maxPoints ?? USAGE_MAX_POINTS_PER_RUN) + 1,
    });
  } catch {
    await finish({ state: 'failed', code: 'port_unavailable' });
    return { state: 'failed', code: 'port_unavailable' };
  }

  const parsed = parseUsageRows(
    answer,
    metric,
    { from: claim.from, to: claim.to },
    options.sanitizeDim,
    options.maxPoints ?? USAGE_MAX_POINTS_PER_RUN,
  );
  if (!parsed.ok) {
    await finish({ state: 'failed', code: parsed.code });
    return { state: 'failed', code: parsed.code };
  }

  const written = await writePoints(db, metric.id, parsed.points);
  await finish({ state: 'ok', points: written.written });

  const detected = await detectUsageAnomalies(db, ctx, metric, options.detect);
  return {
    state: 'ok',
    points: written.written,
    skippedUnknownOrg: written.skipped,
    anomalies: detected.opened,
    capped: detected.capped,
    events: detected.events,
  };
}

/**
 * Upserts the points of a run in one transaction (all or nothing). A point whose organization is not one
 * of ours is left out and counted: the product may know organizations Watchtower does not.
 */
async function writePoints(
  db: Database['db'],
  metricId: string,
  points: readonly ParsedPoint[],
): Promise<{ written: number; skipped: number }> {
  return db.transaction(async (tx) => {
    const orgIds = [
      ...new Set(points.flatMap((point) => (point.orgId === null ? [] : [point.orgId]))),
    ];
    const known = new Set<string>();
    if (orgIds.length > 0) {
      const rows = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(inArray(schema.organization.id, orgIds));
      for (const row of rows) known.add(row.id);
    }
    const keep = points.filter((point) => point.orgId === null || known.has(point.orgId));
    for (let start = 0; start < keep.length; start += CHUNK) {
      const chunk = keep.slice(start, start + CHUNK);
      await tx
        .insert(schema.usageMetricPoint)
        .values(
          chunk.map((point) => ({
            metricId,
            ts: point.ts,
            dimsHash: point.dimsHash,
            orgId: point.orgId,
            dims: point.dims,
            value: point.value,
          })),
        )
        .onConflictDoUpdate({
          target: [
            schema.usageMetricPoint.metricId,
            schema.usageMetricPoint.ts,
            schema.usageMetricPoint.dimsHash,
          ],
          set: { value: sql`excluded.value`, updatedAt: dbNow },
        });
    }
    return { written: keep.length, skipped: points.length - keep.length };
  });
}

/** Ids of the active metrics that are due now (the database clock decides), oldest run first. */
export async function dueUsageMetrics(db: Database['db'], limit = 20): Promise<string[]> {
  const rows = await db
    .select({ id: schema.usageMetricDef.id })
    .from(schema.usageMetricDef)
    .where(
      and(
        eq(schema.usageMetricDef.active, true),
        sql`(${schema.usageMetricDef.lastRunAt} IS NULL
          OR ${schema.usageMetricDef.lastRunAt}
             + make_interval(secs => ${schema.usageMetricDef.refreshIntervalSeconds}) <= clock_timestamp())`,
      ),
    )
    .orderBy(sql`${schema.usageMetricDef.lastRunAt} NULLS FIRST`, schema.usageMetricDef.id)
    .limit(limit);
  return rows.map((row) => row.id);
}
