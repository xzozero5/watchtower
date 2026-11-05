import { schema } from '@watchtower/db';
import type { AlertSource, NoiseQuery, NoiseReport } from '@watchtower/shared';
import { asc, desc, eq, sql } from 'drizzle-orm';

import type { ReadExecutor } from '../types.js';

/**
 * Noise metrics (R-3.11): per rule (source and title), over the last `days`, measured on the database
 * clock. Actionable = acknowledged by a person or part of an incident; noise = resolved by itself with
 * neither; still-open alerts are not judged. Noisiest first. `GET /v1/alerts/noise` and the `alerts.noise`
 * insight read the same rule.
 */
export async function readAlertNoise(db: ReadExecutor, query: NoiseQuery): Promise<NoiseReport> {
  const alert = schema.alert;
  const acted = sql`(${alert.ackedAt} IS NOT NULL OR ${alert.incidentId} IS NOT NULL)`;
  const rows = await db
    .select({
      source: alert.source,
      title: alert.title,
      alerts: sql<number>`count(*)::int`,
      occurrences: sql<number>`coalesce(sum(${alert.count}), 0)::int`,
      actionable: sql<number>`count(*) FILTER (WHERE ${acted})::int`,
      noise: sql<number>`count(*) FILTER (WHERE NOT ${acted} AND ${alert.state} = 'resolved')::int`,
      stillOpen: sql<number>`count(*) FILTER (WHERE NOT ${acted} AND ${alert.state} <> 'resolved')::int`,
    })
    .from(alert)
    .where(sql`${alert.firstSeenAt} > clock_timestamp() - make_interval(days => ${query.days})`)
    .groupBy(alert.source, alert.title)
    .orderBy(
      desc(sql`count(*) FILTER (WHERE NOT ${acted} AND ${alert.state} = 'resolved')`),
      asc(alert.title),
    )
    .limit(query.limit);
  return {
    windowDays: query.days,
    items: rows.map((row) => {
      const judged = row.actionable + row.noise;
      return {
        source: row.source as AlertSource,
        title: row.title,
        alerts: row.alerts,
        occurrences: row.occurrences,
        actionable: row.actionable,
        noise: row.noise,
        stillOpen: row.stillOpen,
        actionableRatio: judged === 0 ? null : row.actionable / judged,
      };
    }),
  };
}

export interface NoiseTotals {
  readonly windowDays: number;
  readonly alerts: number;
  readonly occurrences: number;
  readonly actionable: number;
  readonly noise: number;
  readonly stillOpen: number;
}

const windowCondition = (days: number) =>
  sql`${schema.alert.firstSeenAt} > clock_timestamp() - make_interval(days => ${days})`;

const isActed = sql`(${schema.alert.ackedAt} IS NOT NULL OR ${schema.alert.incidentId} IS NOT NULL)`;

/**
 * The same counts as `readAlertNoise` over every rule at once, so a total never depends on how many rules the
 * route's `limit` shows. Same window, same definition of actionable and noise.
 */
export async function readAlertNoiseTotals(db: ReadExecutor, days: number): Promise<NoiseTotals> {
  const alert = schema.alert;
  const [row] = await db
    .select({
      alerts: sql<number>`count(*)::int`,
      occurrences: sql<number>`coalesce(sum(${alert.count}), 0)::int`,
      actionable: sql<number>`count(*) FILTER (WHERE ${isActed})::int`,
      noise: sql<number>`count(*) FILTER (WHERE NOT ${isActed} AND ${alert.state} = 'resolved')::int`,
      stillOpen: sql<number>`count(*) FILTER (WHERE NOT ${isActed} AND ${alert.state} <> 'resolved')::int`,
    })
    .from(alert)
    .where(windowCondition(days));
  return {
    windowDays: days,
    alerts: row?.alerts ?? 0,
    occurrences: row?.occurrences ?? 0,
    actionable: row?.actionable ?? 0,
    noise: row?.noise ?? 0,
    stillOpen: row?.stillOpen ?? 0,
  };
}

/** Noise per service (a catalog a staff member keeps), for the drivers. Alerts no service claims are left out. */
export async function readAlertNoiseByService(
  db: ReadExecutor,
  days: number,
): Promise<{ id: string; name: string; noise: number }[]> {
  const alert = schema.alert;
  const rows = await db
    .select({
      id: schema.service.id,
      name: schema.service.name,
      noise: sql<number>`count(*) FILTER (WHERE NOT ${isActed} AND ${alert.state} = 'resolved')::int`,
    })
    .from(alert)
    .innerJoin(schema.service, eq(schema.service.id, alert.serviceId))
    .where(windowCondition(days))
    .groupBy(schema.service.id, schema.service.name);
  return rows;
}
