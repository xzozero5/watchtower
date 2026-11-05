import { orgScopeCondition, schema } from '@watchtower/db';
import {
  OPEN_STATUSES,
  SLA_AT_RISK_MINUTES,
  type DashboardOps,
  type OrgScope,
} from '@watchtower/shared';
import { and, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import { readTicketStats } from '../tickets/sla-stats.js';
import type { SqlExecutor } from '../types.js';

/**
 * The parts of the ops dashboard (`GET /v1/dashboard/ops`) that an embedded insight (ADR-029 section 9) reads
 * as well: the volume block, the SLA block and the at-risk counts of the queue. The route and the insight
 * builders call these, so the screen and the insight come from one query. No principal: the caller passes the
 * organization scope it already settled.
 */

type Value<Data> =
  | { readonly status: 'ok'; readonly data: Data }
  | { readonly status: 'not_available'; readonly reason: 'no_data' };

const count = z.number().int();
const maybeNumber = z.number().nullable();
const iso = (date: Date): string => date.toISOString();
const ratio = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);

async function rows<Row extends z.ZodType>(
  db: SqlExecutor,
  row: Row,
  query: SQL,
): Promise<z.output<Row>[]> {
  const result = await db.execute(query);
  return z.array(row).parse(result.rows);
}

async function one<Row extends z.ZodType>(
  db: SqlExecutor,
  row: Row,
  query: SQL,
): Promise<z.output<Row>> {
  const [first] = await rows(db, row, query);
  if (first === undefined) throw new Error('an aggregate query returned no row');
  return first;
}

const and_ = (...parts: (SQL | undefined)[]): SQL => and(...parts) ?? sql`true`;

/** The first instant of the first UTC day of the window: whole days, the last one still running. */
const sinceSql = (days: number): SQL =>
  sql`((date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => ${days - 1}::int)) AT TIME ZONE 'UTC')`;

export interface DashboardWindow {
  readonly now: Date;
  readonly since: Date;
}

/** `now` and the start of the window, on the database clock, as the dashboard computes them. */
export async function readDashboardWindow(db: SqlExecutor, days: number): Promise<DashboardWindow> {
  return one(
    db,
    z.object({ now: z.coerce.date(), since: z.coerce.date() }),
    sql`SELECT now() AS now, ${sinceSql(days)} AS since`,
  );
}

export type DashboardVolume = DashboardOps['volume'];

/** Tickets created in the window, by channel and by day, and the same number of days right before it. */
export async function readDashboardVolume(
  db: SqlExecutor,
  options: { readonly days: number; readonly scope: OrgScope; readonly since?: Date },
): Promise<DashboardVolume> {
  const { days, scope } = options;
  const sinceAt = options.since ?? (await readDashboardWindow(db, days)).since;
  const since = sql`${sinceAt.toISOString()}::timestamptz`;
  const ticketScope = orgScopeCondition(schema.ticket.orgId, scope);
  const [volume, previous] = await Promise.all([
    rows(
      db,
      z.object({ channel: z.string(), day: z.string(), n: count }),
      sql`SELECT channel, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS n
        FROM ticket WHERE ${and_(sql`created_at >= ${since}`, ticketScope)} GROUP BY 1, 2`,
    ),
    // The same number of whole days right before the window (the trend chip, T-159).
    one(
      db,
      z.object({ n: count }),
      sql`SELECT count(*)::int AS n FROM ticket
        WHERE ${and_(
          sql`created_at >= ${since} - make_interval(days => ${days}::int)`,
          sql`created_at < ${since}`,
          ticketScope,
        )}`,
    ),
  ]);
  const byChannel: Record<string, number> = {};
  const perDay = new Map<string, number>();
  const perDayChannel = new Map<string, Record<string, number>>();
  for (const row of volume) {
    byChannel[row.channel] = (byChannel[row.channel] ?? 0) + row.n;
    perDay.set(row.day, (perDay.get(row.day) ?? 0) + row.n);
    perDayChannel.set(row.day, { ...perDayChannel.get(row.day), [row.channel]: row.n });
  }
  const byDay: { day: string; created: number; byChannel: Record<string, number> }[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const day = iso(new Date(sinceAt.getTime() + offset * 86_400_000)).slice(0, 10);
    byDay.push({ day, created: perDay.get(day) ?? 0, byChannel: perDayChannel.get(day) ?? {} });
  }
  return {
    created: [...perDay.values()].reduce((sum, n) => sum + n, 0),
    byChannel,
    byDay,
    previous: {
      from: iso(new Date(sinceAt.getTime() - days * 86_400_000)),
      to: iso(sinceAt),
      created: previous.n,
    },
  };
}

export type DashboardSla = DashboardOps['sla'];

const duration = (
  n: number,
  median: number | null,
  p90: number | null,
): Value<{ medianSeconds: number; p90Seconds: number; samples: number }> =>
  n === 0 || median === null || p90 === null
    ? { status: 'not_available', reason: 'no_data' }
    : { status: 'ok', data: { medianSeconds: median, p90Seconds: p90, samples: n } };

const breach = (
  evaluated: number,
  breached: number,
): Value<{ evaluated: number; breached: number; rate: number }> =>
  evaluated === 0
    ? { status: 'not_available', reason: 'no_data' }
    : { status: 'ok', data: { evaluated, breached, rate: ratio(breached, evaluated) } };

/** First response and resolution times and SLA breach rates of the tickets created in the window. */
export async function readDashboardSla(
  db: SqlExecutor,
  options: { readonly days: number; readonly scope: OrgScope; readonly since?: Date },
): Promise<DashboardSla> {
  const { days, scope } = options;
  const sinceAt = options.since ?? (await readDashboardWindow(db, days)).since;
  const since = sql`${sinceAt.toISOString()}::timestamptz`;
  const ticketScope = orgScopeCondition(schema.ticket.orgId, scope);
  const sla = await one(
    db,
    z.object({
      frt_n: count,
      frt_p50: maybeNumber,
      frt_p90: maybeNumber,
      ttr_n: count,
      ttr_p50: maybeNumber,
      ttr_p90: maybeNumber,
      frt_eval: count,
      frt_breached: count,
      ttr_eval: count,
      ttr_breached: count,
    }),
    sql`SELECT
      count(*) FILTER (WHERE first_responded_at IS NOT NULL)::int AS frt_n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_responded_at - created_at)::float8)
        FILTER (WHERE first_responded_at IS NOT NULL) AS frt_p50,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM first_responded_at - created_at)::float8)
        FILTER (WHERE first_responded_at IS NOT NULL) AS frt_p90,
      count(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS ttr_n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM resolved_at - created_at)::float8)
        FILTER (WHERE resolved_at IS NOT NULL) AS ttr_p50,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM resolved_at - created_at)::float8)
        FILTER (WHERE resolved_at IS NOT NULL) AS ttr_p90,
      count(*) FILTER (WHERE first_response_due_at IS NOT NULL AND (first_responded_at IS NOT NULL
        OR (first_response_due_at < now() AND sla_paused_at IS NULL)))::int AS frt_eval,
      count(*) FILTER (WHERE first_response_due_at IS NOT NULL AND (
        (first_responded_at IS NOT NULL AND first_responded_at > first_response_due_at)
        OR (first_responded_at IS NULL AND first_response_due_at < now() AND sla_paused_at IS NULL)))::int AS frt_breached,
      count(*) FILTER (WHERE resolution_due_at IS NOT NULL AND (resolved_at IS NOT NULL
        OR (resolution_due_at < now() AND sla_paused_at IS NULL)))::int AS ttr_eval,
      count(*) FILTER (WHERE resolution_due_at IS NOT NULL AND (
        (resolved_at IS NOT NULL AND resolved_at > resolution_due_at)
        OR (resolved_at IS NULL AND resolution_due_at < now() AND sla_paused_at IS NULL)))::int AS ttr_breached
    FROM ticket WHERE ${and_(sql`created_at >= ${since}`, sql`status <> 'merged'`, ticketScope)}`,
  );
  return {
    basis: 'wall_clock',
    firstResponse: duration(sla.frt_n, sla.frt_p50, sla.frt_p90),
    resolution: duration(sla.ttr_n, sla.ttr_p50, sla.ttr_p90),
    firstResponseBreach: breach(sla.frt_eval, sla.frt_breached),
    resolutionBreach: breach(sla.ttr_eval, sla.ttr_breached),
  };
}

export interface DashboardQueueSla {
  readonly open: number;
  readonly paused: number;
  readonly breachedNow: number;
  readonly atRiskNow: number;
  readonly atRiskMinutes: number;
}

/** Open tickets and how many are paused, breached or close to breaching their SLA (one at-risk rule, T-177). */
export async function readDashboardQueueSla(
  db: SqlExecutor,
  options: { readonly scope: OrgScope; readonly now?: Date },
): Promise<DashboardQueueSla> {
  const stats = await readTicketStats(
    db,
    [
      inArray(schema.ticket.status, [...OPEN_STATUSES]),
      orgScopeCondition(schema.ticket.orgId, options.scope),
    ],
    options.now ?? new Date(),
  );
  return {
    open: stats.total.open,
    paused: stats.total.sla.paused,
    breachedNow: stats.total.sla.breached,
    atRiskNow: stats.total.sla.at_risk,
    atRiskMinutes: SLA_AT_RISK_MINUTES,
  };
}
