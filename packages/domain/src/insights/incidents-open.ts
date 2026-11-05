import { schema } from '@watchtower/db';
import type { IncidentSeverity, InsightFact, InsightFactsResult } from '@watchtower/shared';
import { sql } from 'drizzle-orm';

import { readOpenIncidents } from '../incidents/summary.js';
import {
  deltaFact,
  driverFacts,
  finishFacts,
  metric,
  serviceNames,
  state,
  type InsightBuildOptions,
} from './facts.js';
import { delta, topDrivers } from './primitives.js';

const SEVERITIES: readonly IncidentSeverity[] = ['SEV1', 'SEV2', 'SEV3', 'SEV4'];

/**
 * `incidents.open`: the incidents that are not resolved, by severity, how many have no commander, how long the
 * oldest has been open, how many started in the last 24 hours against the daily average of the 7 days before,
 * and the services that appear in the most open incidents. The title, root cause and notes are free text and
 * stay out; the incidents are only counted.
 */
export async function buildIncidentsOpenFacts(
  options: InsightBuildOptions,
): Promise<InsightFactsResult> {
  const { executor } = options;
  const now = options.now ?? new Date();
  const open = await readOpenIncidents(executor, 100);

  const rate = await executor.execute(
    sql`SELECT count(*) FILTER (WHERE started_at >= ${now}::timestamptz - interval '24 hours')::int AS last_24h,
      count(*) FILTER (WHERE started_at >= ${now}::timestamptz - interval '8 days'
        AND started_at < ${now}::timestamptz - interval '1 day')::int AS prior_7d
      FROM ${schema.incident}
      WHERE started_at >= ${now}::timestamptz - interval '8 days'`,
  );
  const rateRow = rate.rows[0] as { last_24h?: unknown; prior_7d?: unknown } | undefined;
  const last24h = Number(rateRow?.last_24h ?? 0);
  const prior7d = Number(rateRow?.prior_7d ?? 0);

  const facts: InsightFact[] = [
    metric('open', open.length, {
      th: `incident ที่เปิดอยู่ ${String(open.length)} รายการ`,
      en: `${String(open.length)} open incidents`,
    }),
  ];
  for (const severity of SEVERITIES) {
    const n = open.filter((incident) => incident.severity === severity).length;
    facts.push(
      metric(`open_${severity.toLowerCase()}`, n, {
        th: `${severity} ที่เปิดอยู่ ${String(n)} รายการ`,
        en: `${String(n)} open ${severity}`,
      }),
    );
  }
  const withoutCommander = open.filter((incident) => incident.commanderId === null).length;
  facts.push(
    metric('no_commander', withoutCommander, {
      th: `${String(withoutCommander)} รายการยังไม่มี commander`,
      en: `${String(withoutCommander)} have no commander yet`,
    }),
  );
  const oldest = open.reduce<number | null>((min, incident) => {
    const started = new Date(incident.startedAt).getTime();
    return min === null || started < min ? started : min;
  }, null);
  if (oldest !== null) {
    const hours = Math.max(0, Math.floor((now.getTime() - oldest) / 3_600_000));
    facts.push(
      metric('oldest_hours', hours, {
        th: `incident ที่เปิดนานสุดเปิดมา ${String(hours)} ชั่วโมง`,
        en: `the longest-open incident has been open ${String(hours)} hours`,
      }),
    );
  }
  facts.push(
    metric('started_24h', last24h, {
      th: `incident ใหม่ใน 24 ชั่วโมงล่าสุด ${String(last24h)} รายการ`,
      en: `${String(last24h)} incidents started in the last 24 hours`,
    }),
    ...deltaFact(
      'started_24h_delta',
      { th: 'incident ใหม่ใน 24 ชั่วโมงล่าสุด', en: 'Incidents started in the last 24 hours' },
      delta(last24h, prior7d / 7),
    ),
    state(
      'top_severity',
      SEVERITIES.find((severity) => open.some((incident) => incident.severity === severity)) ??
        'none',
      { th: 'ความรุนแรงสูงสุดที่เปิดอยู่', en: 'Highest open severity' },
    ),
  );

  const perService = new Map<string, number>();
  for (const incident of open) {
    for (const serviceId of incident.serviceIds) {
      perService.set(serviceId, (perService.get(serviceId) ?? 0) + 1);
    }
  }
  const names = await serviceNames(executor, [...perService.keys()]);
  facts.push(
    ...driverFacts(
      'service_driver',
      {
        th: 'service ที่อยู่ใน incident ที่เปิดอยู่มากสุด',
        en: 'Service in the most open incidents',
      },
      topDrivers(
        'service',
        [...perService].flatMap(([id, count]) => {
          const name = names.get(id);
          return name === undefined ? [] : [{ id, name, count }];
        }),
      ),
    ),
  );
  return finishFacts(facts, now, options.view);
}
