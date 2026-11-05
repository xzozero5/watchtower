import { orgScopeCondition, schema } from '@watchtower/db';
import {
  OPEN_STATUSES,
  type InsightFact,
  type InsightFactsResult,
  type OrgScope,
} from '@watchtower/shared';
import { and, inArray, sql, type SQL } from 'drizzle-orm';

import {
  readDashboardQueueSla,
  readDashboardSla,
  readDashboardVolume,
  readDashboardWindow,
} from '../dashboard/ops.js';
import { readTicketStats } from '../tickets/sla-stats.js';
import {
  driverFacts,
  finishFacts,
  metric,
  queueNames,
  state,
  deltaFact,
  type InsightBuildOptions,
} from './facts.js';
import { delta, share, topDrivers, type DriverCandidate } from './primitives.js';

export interface DashboardInsightOptions extends InsightBuildOptions {
  /** The window of `GET /v1/dashboard/ops?days=`; the registry allows 1 to 90. */
  readonly days: number;
  /** The organization scope the dashboard reads under; staff with `dashboard.ops.read` read `all`. */
  readonly scope?: OrgScope;
}

const ALL: OrgScope = { kind: 'all' };

type RowShape = Record<string, unknown>;

function candidates(rows: readonly RowShape[]): DriverCandidate[] {
  return rows.map((row) => ({
    id: String(row['id']),
    name: String(row['name']),
    count: Number(row['n']),
  }));
}

/**
 * `dashboard.ops.sla`: open tickets and how many are close to or past their SLA, first response and
 * resolution times and breach rates of the window, and the queues holding the most trouble. The numbers are
 * those of `GET /v1/dashboard/ops` (same readers), only the ones this section shows.
 */
export async function buildDashboardSlaFacts(
  options: DashboardInsightOptions,
): Promise<InsightFactsResult> {
  const { executor, days } = options;
  const scope = options.scope ?? ALL;
  const window = await readDashboardWindow(executor, days);
  const now = window.now;
  const [sla, queue, stats] = await Promise.all([
    readDashboardSla(executor, { days, scope, since: window.since }),
    readDashboardQueueSla(executor, { scope, now }),
    readTicketStats(
      executor,
      [
        inArray(schema.ticket.status, [...OPEN_STATUSES]),
        orgScopeCondition(schema.ticket.orgId, scope),
      ],
      now,
    ),
  ]);

  const facts: InsightFact[] = [
    metric('window_days', days, {
      th: `ช่วงเวลา ${String(days)} วัน`,
      en: `Window of ${String(days)} days`,
    }),
    metric('open', queue.open, {
      th: `ticket ที่เปิดอยู่ ${String(queue.open)} รายการ`,
      en: `${String(queue.open)} open tickets`,
    }),
    metric('at_risk', queue.atRiskNow, {
      th: `${String(queue.atRiskNow)} รายการใกล้ผิด SLA`,
      en: `${String(queue.atRiskNow)} tickets close to breaching SLA`,
    }),
    metric('breached', queue.breachedNow, {
      th: `${String(queue.breachedNow)} รายการผิด SLA แล้ว`,
      en: `${String(queue.breachedNow)} tickets already past SLA`,
    }),
    metric('paused', queue.paused, {
      th: `${String(queue.paused)} รายการหยุดนาฬิกา SLA`,
      en: `${String(queue.paused)} tickets with the SLA clock paused`,
    }),
  ];
  const trouble = share(queue.atRiskNow + queue.breachedNow, queue.open);
  if (trouble !== null) {
    facts.push(
      metric('trouble_pct', trouble, {
        th: `${String(trouble)}% ของ ticket ที่เปิดอยู่ใกล้หรือผิด SLA`,
        en: `${String(trouble)}% of open tickets are close to or past SLA`,
      }),
    );
  }
  facts.push(
    state(
      'sla_state',
      queue.breachedNow > 0 ? 'breached' : queue.atRiskNow > 0 ? 'at_risk' : 'ok',
      { th: 'สถานะ SLA ของคิวรวม', en: 'Overall SLA state of the queue' },
    ),
  );

  const duration = (
    prefix: 'frt' | 'ttr',
    label: { th: string; en: string },
    value: typeof sla.firstResponse,
  ): void => {
    if (value.status !== 'ok') return;
    facts.push(
      metric(`${prefix}_median_s`, Math.round(value.data.medianSeconds), {
        th: `${label.th} มัธยฐาน ${String(Math.round(value.data.medianSeconds))} วินาที`,
        en: `${label.en} median ${String(Math.round(value.data.medianSeconds))} seconds`,
      }),
      metric(`${prefix}_p90_s`, Math.round(value.data.p90Seconds), {
        th: `${label.th} p90 ${String(Math.round(value.data.p90Seconds))} วินาที`,
        en: `${label.en} p90 ${String(Math.round(value.data.p90Seconds))} seconds`,
      }),
    );
  };
  duration('frt', { th: 'เวลาตอบครั้งแรก', en: 'First response time' }, sla.firstResponse);
  duration('ttr', { th: 'เวลาแก้ไข', en: 'Resolution time' }, sla.resolution);

  const breach = (
    prefix: 'frt' | 'ttr',
    label: { th: string; en: string },
    value: typeof sla.firstResponseBreach,
  ): void => {
    if (value.status !== 'ok') return;
    const percent = Math.round(value.data.rate * 100);
    facts.push(
      metric(`${prefix}_breach_pct`, percent, {
        th: `${label.th} ผิด SLA ${String(percent)}% (${String(value.data.breached)} จาก ${String(value.data.evaluated)})`,
        en: `${label.en} breached SLA ${String(percent)}% (${String(value.data.breached)} of ${String(value.data.evaluated)})`,
      }),
    );
  };
  breach('frt', { th: 'การตอบครั้งแรก', en: 'First response' }, sla.firstResponseBreach);
  breach('ttr', { th: 'การแก้ไข', en: 'Resolution' }, sla.resolutionBreach);

  // Queues holding the most tickets that are close to or past SLA: a staff-made catalog (C-14).
  const troubleByQueue = stats.byQueue.flatMap((bucket) =>
    bucket.queueId === null
      ? []
      : [{ id: bucket.queueId, n: bucket.sla.at_risk + bucket.sla.breached }],
  );
  const names = await queueNames(
    executor,
    troubleByQueue.filter((entry) => entry.n > 0).map((entry) => entry.id),
  );
  facts.push(
    ...driverFacts(
      'queue_driver',
      {
        th: 'คิวที่มี ticket ใกล้หรือผิด SLA มากสุด',
        en: 'Queue with most tickets close to or past SLA',
      },
      topDrivers(
        'queue',
        troubleByQueue.flatMap((entry) => {
          const name = names.get(entry.id);
          return name === undefined ? [] : [{ id: entry.id, name, count: entry.n }];
        }),
      ),
    ),
  );
  return finishFacts(facts, now, options.view);
}

/**
 * `dashboard.ops.volume`: tickets created in the window against the window before it, the last 24 hours
 * against the daily average of the 7 days before, and the intents and queues that account for the most.
 */
export async function buildDashboardVolumeFacts(
  options: DashboardInsightOptions,
): Promise<InsightFactsResult> {
  const { executor, days } = options;
  const scope = options.scope ?? ALL;
  const window = await readDashboardWindow(executor, days);
  const volume = await readDashboardVolume(executor, { days, scope, since: window.since });
  const ticketScope = orgScopeCondition(schema.ticket.orgId, scope);
  const where = (...parts: (SQL | undefined)[]): SQL => and(...parts) ?? sql`true`;

  const rate = await executor.execute(
    sql`SELECT count(*) FILTER (WHERE created_at >= ${window.now}::timestamptz - interval '24 hours')::int AS last_24h,
      count(*) FILTER (WHERE created_at >= ${window.now}::timestamptz - interval '8 days'
        AND created_at < ${window.now}::timestamptz - interval '1 day')::int AS prior_7d
      FROM ticket WHERE ${where(sql`created_at >= ${window.now}::timestamptz - interval '8 days'`, ticketScope)}`,
  );
  const rateRow = rate.rows[0] as { last_24h?: unknown; prior_7d?: unknown } | undefined;
  const last24h = Number(rateRow?.last_24h ?? 0);
  const prior7d = Number(rateRow?.prior_7d ?? 0);

  const byIntent = await executor.execute(
    sql`SELECT intent.id AS id, intent.name AS name, count(*)::int AS n
      FROM ticket JOIN intent ON intent.id = ticket.intent_id
      WHERE ${where(sql`ticket.created_at >= ${window.since}`, ticketScope)}
      GROUP BY intent.id, intent.name`,
  );
  const byQueue = await executor.execute(
    sql`SELECT team_queue.id AS id, team_queue.name AS name, count(*)::int AS n
      FROM ticket JOIN team_queue ON team_queue.id = ticket.queue_id
      WHERE ${where(sql`ticket.created_at >= ${window.since}`, ticketScope)}
      GROUP BY team_queue.id, team_queue.name`,
  );

  const facts: InsightFact[] = [
    metric('window_days', days, {
      th: `ช่วงเวลา ${String(days)} วัน`,
      en: `Window of ${String(days)} days`,
    }),
    metric('created', volume.created, {
      th: `สร้าง ticket ใหม่ ${String(volume.created)} รายการใน ${String(days)} วัน`,
      en: `${String(volume.created)} tickets created in ${String(days)} days`,
    }),
    metric('created_prev', volume.previous.created, {
      th: `${String(volume.previous.created)} รายการใน ${String(days)} วันก่อนหน้า`,
      en: `${String(volume.previous.created)} tickets in the ${String(days)} days before`,
    }),
    metric('created_24h', last24h, {
      th: `สร้างใน 24 ชั่วโมงล่าสุด ${String(last24h)} รายการ`,
      en: `${String(last24h)} tickets created in the last 24 hours`,
    }),
    ...deltaFact(
      'created_24h_delta',
      { th: 'ticket ใหม่ใน 24 ชั่วโมงล่าสุด', en: 'Tickets created in the last 24 hours' },
      delta(last24h, prior7d / 7),
    ),
    ...driverFacts(
      'intent_driver',
      { th: 'intent ที่มี ticket ใหม่มากสุด', en: 'Intent with the most new tickets' },
      topDrivers('intent', candidates(byIntent.rows)),
    ),
    ...driverFacts(
      'queue_driver',
      { th: 'คิวที่รับ ticket ใหม่มากสุด', en: 'Queue with the most new tickets' },
      topDrivers('queue', candidates(byQueue.rows)),
    ),
  ];
  return finishFacts(facts, window.now, options.view);
}
