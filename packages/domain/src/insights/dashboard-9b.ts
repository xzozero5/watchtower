import { orgScopeCondition, schema } from '@watchtower/db';
import {
  OPEN_STATUSES,
  type InsightFact,
  type InsightFactsResult,
  type OrgScope,
} from '@watchtower/shared';
import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';

import { readDashboardQueueSla, readDashboardWindow } from '../dashboard/ops.js';
import {
  deltaFact,
  driverFacts,
  finishFacts,
  metric,
  serviceNames,
  state,
  type InsightBuildOptions,
} from './facts.js';
import { delta, share, topDrivers, type DriverCandidate } from './primitives.js';
import { SHIFT_OVERVIEW_MAX_PERSONS } from './shift-overview.js';

export interface DashboardInsightOptions extends InsightBuildOptions {
  readonly days: number;
  readonly scope?: OrgScope;
}

const ALL: OrgScope = { kind: 'all' };

/**
 * `dashboard.ops.now` (mode N, period `now`): immediate snapshot of operations:
 * open tickets, SLA at-risk/breached counts, open incidents, and firing alerts.
 */
export async function buildDashboardOpsNowFacts(
  options: InsightBuildOptions & { scope?: OrgScope },
): Promise<InsightFactsResult> {
  const { executor } = options;
  const now = options.now ?? new Date();
  const scope = options.scope ?? ALL;

  const [queueSla, incidentStats, alertStats] = await Promise.all([
    readDashboardQueueSla(executor, { scope, now }),
    executor
      .select({
        open: sql<number>`count(*) FILTER (WHERE ${schema.incident.status} <> 'resolved')::int`,
        sev1: sql<number>`count(*) FILTER (WHERE ${schema.incident.status} <> 'resolved' AND ${schema.incident.severity} = 'SEV1')::int`,
      })
      .from(schema.incident),
    executor
      .select({
        firing: sql<number>`count(*) FILTER (WHERE ${schema.alert.state} <> 'resolved')::int`,
        highSev: sql<number>`count(*) FILTER (WHERE ${schema.alert.state} <> 'resolved' AND ${schema.alert.severity} IN ('critical', 'high'))::int`,
      })
      .from(schema.alert),
  ]);

  const incidents = incidentStats[0] ?? { open: 0, sev1: 0 };
  const alerts = alertStats[0] ?? { firing: 0, highSev: 0 };

  const facts: InsightFact[] = [
    metric('open_tickets', queueSla.open, {
      th: `Ticket เปิดอยู่ ${String(queueSla.open)} รายการ`,
      en: `${String(queueSla.open)} open tickets`,
    }),
    metric('at_risk_sla', queueSla.atRiskNow, {
      th: `${String(queueSla.atRiskNow)} รายการใกล้ผิด SLA`,
      en: `${String(queueSla.atRiskNow)} tickets close to SLA breach`,
    }),
    metric('breached_sla', queueSla.breachedNow, {
      th: `${String(queueSla.breachedNow)} รายการผิด SLA แล้ว`,
      en: `${String(queueSla.breachedNow)} tickets past SLA`,
    }),
    metric('open_incidents', incidents.open, {
      th: `Incident เปิดอยู่ ${String(incidents.open)} รายการ`,
      en: `${String(incidents.open)} open incidents`,
    }),
    metric('sev1_incidents', incidents.sev1, {
      th: `Incident ระดับ SEV1 ${String(incidents.sev1)} รายการ`,
      en: `${String(incidents.sev1)} SEV1 incidents`,
    }),
    metric('firing_alerts', alerts.firing, {
      th: `Alert กำลังส่งสัญญาณ ${String(alerts.firing)} รายการ`,
      en: `${String(alerts.firing)} firing alerts`,
    }),
    state(
      'ops_now_state',
      incidents.sev1 > 0 || queueSla.breachedNow > 0
        ? 'critical'
        : incidents.open > 0 || queueSla.atRiskNow > 0 || alerts.highSev > 0
          ? 'warning'
          : 'nominal',
      {
        th: 'สถานะระบบปฏิบัติการปัจจุบัน',
        en: 'Current operations state',
      },
    ),
  ];

  return finishFacts(facts, now, options.view);
}

/**
 * `dashboard.ops.reliability` (mode N, period `days`): incident counts, severity P1s,
 * trend against previous window, and top affected service drivers.
 */
export async function buildDashboardReliabilityFacts(
  options: DashboardInsightOptions,
): Promise<InsightFactsResult> {
  const { executor, days } = options;
  const window = await readDashboardWindow(executor, days);
  const now = window.now;
  const since = window.since;
  const prevSince = new Date(since.getTime() - days * 86_400_000);

  const [currentRows, prevRow, serviceDrivers] = await Promise.all([
    executor
      .select({
        total: sql<number>`count(*)::int`,
        open: sql<number>`count(*) FILTER (WHERE ${schema.incident.status} <> 'resolved')::int`,
        sev1: sql<number>`count(*) FILTER (WHERE ${schema.incident.severity} = 'SEV1')::int`,
      })
      .from(schema.incident)
      .where(sql`${schema.incident.startedAt} >= ${since.toISOString()}::timestamptz`),
    executor
      .select({
        total: sql<number>`count(*)::int`,
      })
      .from(schema.incident)
      .where(
        sql`${schema.incident.startedAt} >= ${prevSince.toISOString()}::timestamptz AND ${schema.incident.startedAt} < ${since.toISOString()}::timestamptz`,
      ),
    executor
      .select({
        id: schema.service.id,
        name: schema.service.name,
        n: sql<number>`count(*)::int`,
      })
      .from(schema.alert)
      .innerJoin(schema.service, eq(schema.alert.serviceId, schema.service.id))
      .where(
        and(
          isNotNull(schema.alert.incidentId),
          sql`${schema.alert.firstSeenAt} >= ${since.toISOString()}::timestamptz`,
        ),
      )
      .groupBy(schema.service.id, schema.service.name)
      .orderBy(desc(sql`count(*)`))
      .limit(3),
  ]);

  const curr = currentRows[0] ?? { total: 0, open: 0, sev1: 0 };
  const prevCount = prevRow[0]?.total ?? 0;
  const incDelta = delta(curr.total, prevCount);

  const candidates: DriverCandidate[] = serviceDrivers.map((row) => ({
    id: row.id,
    name: row.name,
    count: row.n,
  }));
  const topServiceDrivers = topDrivers('service', candidates);

  const facts: InsightFact[] = [
    metric('window_days', days, {
      th: `ช่วงเวลา ${String(days)} วัน`,
      en: `Window of ${String(days)} days`,
    }),
    metric('total_incidents', curr.total, {
      th: `Incident ทั้งหมด ${String(curr.total)} รายการ`,
      en: `${String(curr.total)} total incidents`,
    }),
    metric('open_incidents', curr.open, {
      th: `Incident ยังเปิดอยู่ ${String(curr.open)} รายการ`,
      en: `${String(curr.open)} open incidents`,
    }),
    metric('sev1_incidents', curr.sev1, {
      th: `Incident ระดับ SEV1 ${String(curr.sev1)} รายการ`,
      en: `${String(curr.sev1)} SEV1 incidents`,
    }),
    ...deltaFact('incidents_delta', { th: 'จำนวน Incident', en: 'Incidents count' }, incDelta),
    ...driverFacts(
      'incident_service',
      { th: 'บริการที่พบ Incident', en: 'Service with incident' },
      topServiceDrivers,
    ),
  ];

  return finishFacts(facts, now, options.view);
}

/**
 * `dashboard.ops.services` (mode N, period `days`): health of services in the catalog,
 * counting how many currently have open alerts or incidents.
 */
export async function buildDashboardServicesFacts(
  options: DashboardInsightOptions,
): Promise<InsightFactsResult> {
  const { executor, days } = options;
  const window = await readDashboardWindow(executor, days);
  const now = window.now;

  const [totalServicesRow, alertServicesRows] = await Promise.all([
    executor.select({ count: sql<number>`count(*)::int` }).from(schema.service),
    executor
      .select({
        serviceId: schema.alert.serviceId,
        alertCount: sql<number>`count(*)::int`,
      })
      .from(schema.alert)
      .where(and(isNotNull(schema.alert.serviceId), ne(schema.alert.state, 'resolved')))
      .groupBy(schema.alert.serviceId),
  ]);

  const totalServices = totalServicesRow[0]?.count ?? 0;
  const servicesWithAlerts = alertServicesRows.length;
  const serviceIds = alertServicesRows
    .map((r) => r.serviceId)
    .filter((id): id is string => typeof id === 'string');
  const names = await serviceNames(executor, serviceIds);

  const candidates: DriverCandidate[] = alertServicesRows
    .filter((r): r is { serviceId: string; alertCount: number } => Boolean(r.serviceId))
    .map((r) => ({
      id: r.serviceId,
      name: names.get(r.serviceId) ?? r.serviceId,
      count: r.alertCount,
    }));
  const topDegraded = topDrivers('service', candidates);

  const facts: InsightFact[] = [
    metric('total_services', totalServices, {
      th: `บริการทั้งหมด ${String(totalServices)} บริการ`,
      en: `${String(totalServices)} total services`,
    }),
    metric('services_with_alerts', servicesWithAlerts, {
      th: `บริการที่มี Alert เปิดอยู่ ${String(servicesWithAlerts)} บริการ`,
      en: `${String(servicesWithAlerts)} services with open alerts`,
    }),
    state('catalog_state', servicesWithAlerts > 0 ? 'degraded' : 'healthy', {
      th: 'สถานะภาพรวมบริการ',
      en: 'Overall catalog state',
    }),
    ...driverFacts(
      'service_degraded',
      { th: 'บริการที่มี Alert สูงสุด', en: 'Top alert service' },
      topDegraded,
    ),
  ];

  return finishFacts(facts, now, options.view);
}

/**
 * `dashboard.ops.quality` (mode N, period `days`): CSAT results in the window,
 * average score, and share of positive ratings (>= 4). Excludes seed tickets.
 */
export async function buildDashboardQualityFacts(
  options: DashboardInsightOptions,
): Promise<InsightFactsResult> {
  const { executor, days } = options;
  const window = await readDashboardWindow(executor, days);
  const now = window.now;
  const since = window.since;

  const [csatSummary] = await executor
    .select({
      answered: sql<number>`count(*)::int`,
      avgScore: sql<string | null>`avg(${schema.csatSurvey.score})::numeric(3, 2)`,
      good: sql<number>`count(*) FILTER (WHERE ${schema.csatSurvey.score} >= 4)::int`,
    })
    .from(schema.csatSurvey)
    .innerJoin(schema.ticket, eq(schema.ticket.id, schema.csatSurvey.ticketId))
    .where(
      and(
        sql`${schema.csatSurvey.answeredAt} >= ${since.toISOString()}::timestamptz`,
        eq(schema.csatSurvey.status, 'answered'),
        sql`${schema.ticket.seedBatchId} IS NULL`,
      ),
    );

  const answered = csatSummary?.answered ?? 0;
  const avg =
    csatSummary?.avgScore !== null && csatSummary?.avgScore !== undefined
      ? Number(csatSummary.avgScore)
      : 0;
  const goodPct = answered > 0 ? (share(csatSummary?.good ?? 0, answered) ?? 0) : 0;

  const facts: InsightFact[] = [
    metric('window_days', days, {
      th: `ช่วงเวลา ${String(days)} วัน`,
      en: `Window of ${String(days)} days`,
    }),
    metric('csat_answered', answered, {
      th: `แบบสำรวจ CSAT ที่ตอบกลับ ${String(answered)} รายการ`,
      en: `${String(answered)} CSAT surveys answered`,
    }),
    metric('csat_avg', avg, {
      th: `คะแนนเฉลี่ย ${String(avg)} จาก 5`,
      en: `Average score ${String(avg)} of 5`,
    }),
    metric('csat_good_pct', goodPct, {
      th: `${String(goodPct)}% ให้คะแนนระดับดี (4-5)`,
      en: `${String(goodPct)}% rated 4 or 5 stars`,
    }),
  ];

  return finishFacts(facts, now, options.view);
}

/**
 * `dashboard.ops.ai` (mode F, period `days`): total model runs, input/output tokens,
 * total cost, and error/fallback counts.
 */
export async function buildDashboardAiFacts(
  options: DashboardInsightOptions,
): Promise<InsightFactsResult> {
  const { executor, days } = options;
  const window = await readDashboardWindow(executor, days);
  const now = window.now;
  const since = window.since;

  const [aiSummary] = await executor
    .select({
      totalRuns: sql<number>`count(*)::int`,
      tokens: sql<number>`coalesce(sum(${schema.aiRun.inputTokens} + ${schema.aiRun.outputTokens}), 0)::int`,
      cost: sql<string | null>`coalesce(sum(${schema.aiRun.costUsd}), 0)::numeric(10, 4)`,
      errors: sql<number>`count(*) FILTER (WHERE ${schema.aiRun.status} = 'error')::int`,
      fallbacks: sql<number>`count(*) FILTER (WHERE ${schema.aiRun.status} = 'fallback')::int`,
    })
    .from(schema.aiRun)
    .where(sql`${schema.aiRun.createdAt} >= ${since.toISOString()}::timestamptz`);

  const totalRuns = aiSummary?.totalRuns ?? 0;
  const tokens = aiSummary?.tokens ?? 0;
  const cost = Number(aiSummary?.cost ?? 0);
  const errors = aiSummary?.errors ?? 0;
  const fallbacks = aiSummary?.fallbacks ?? 0;

  const facts: InsightFact[] = [
    metric('window_days', days, {
      th: `ช่วงเวลา ${String(days)} วัน`,
      en: `Window of ${String(days)} days`,
    }),
    metric('total_runs', totalRuns, {
      th: `AI ประมวลผล ${String(totalRuns)} ครั้ง`,
      en: `${String(totalRuns)} AI runs`,
    }),
    metric('total_tokens', tokens, {
      th: `ใช้งาน ${String(tokens)} tokens`,
      en: `${String(tokens)} tokens used`,
    }),
    metric('cost_usd', cost, {
      th: `ต้นทุน $${String(cost)} USD`,
      en: `$${String(cost)} USD total cost`,
    }),
    metric('error_count', errors, {
      th: `ข้อผิดพลาด ${String(errors)} ครั้ง`,
      en: `${String(errors)} errors`,
    }),
    metric('fallback_count', fallbacks, {
      th: `สลับไปใช้ fallback ${String(fallbacks)} ครั้ง`,
      en: `${String(fallbacks)} fallbacks`,
    }),
  ];

  return finishFacts(facts, now, options.view);
}

/**
 * `dashboard.ops.grades` (mode F, period `days`): results of independent AI resolution grades,
 * verified percentage and policy violations count.
 */
export async function buildDashboardGradesFacts(
  options: DashboardInsightOptions,
): Promise<InsightFactsResult> {
  const { executor, days } = options;
  const window = await readDashboardWindow(executor, days);
  const now = window.now;
  const since = window.since;

  const [gradeSummary] = await executor
    .select({
      total: sql<number>`count(*)::int`,
      verified: sql<number>`count(*) FILTER (WHERE ${schema.aiResolutionGrade.resolutionClass} = 'verified')::int`,
      violations: sql<number>`coalesce(sum(${schema.aiResolutionGrade.violationCount}), 0)::int`,
    })
    .from(schema.aiResolutionGrade)
    .where(
      and(
        sql`${schema.aiResolutionGrade.gradedAt} >= ${since.toISOString()}::timestamptz`,
        eq(schema.aiResolutionGrade.mock, false),
      ),
    );

  const total = gradeSummary?.total ?? 0;
  const verified = gradeSummary?.verified ?? 0;
  const verifiedPct = total > 0 ? (share(verified, total) ?? 0) : 0;
  const violations = gradeSummary?.violations ?? 0;

  const facts: InsightFact[] = [
    metric('window_days', days, {
      th: `ช่วงเวลา ${String(days)} วัน`,
      en: `Window of ${String(days)} days`,
    }),
    metric('total_graded', total, {
      th: `ตรวจคำตอบแล้ว ${String(total)} รายการ`,
      en: `${String(total)} resolutions graded`,
    }),
    metric('verified_count', verified, {
      th: `ยืนยันว่าถูกต้อง ${String(verified)} รายการ`,
      en: `${String(verified)} verified resolutions`,
    }),
    metric('verified_pct', verifiedPct, {
      th: `สัดส่วนที่ถูกต้อง ${String(verifiedPct)}%`,
      en: `${String(verifiedPct)}% verified`,
    }),
    metric('violation_count', violations, {
      th: `พบ Policy violation ${String(violations)} ข้อ`,
      en: `${String(violations)} policy violations`,
    }),
  ];

  return finishFacts(facts, now, options.view);
}

/**
 * `dashboard.ops.team` (mode N, period `days`): factual workload counts for staff members,
 * adhering to PII performance rules (§9.9: strictly factual, capped to max persons, no rank/comparisons).
 */
export async function buildDashboardTeamFacts(
  options: DashboardInsightOptions,
): Promise<InsightFactsResult> {
  const { executor, days } = options;
  const scope = options.scope ?? ALL;
  const window = await readDashboardWindow(executor, days);
  const now = window.now;
  const since = window.since;

  const rawRows = await executor
    .select({
      userId: schema.ticket.assigneeId,
      openAssigned: sql<number>`count(*) FILTER (WHERE ${inArray(schema.ticket.status, [...OPEN_STATUSES])})::int`,
      resolvedInWindow: sql<number>`count(*) FILTER (WHERE ${schema.ticket.resolvedAt} >= ${since.toISOString()}::timestamptz)::int`,
    })
    .from(schema.ticket)
    .where(and(isNotNull(schema.ticket.assigneeId), orgScopeCondition(schema.ticket.orgId, scope)))
    .groupBy(schema.ticket.assigneeId);

  const activeRows = rawRows
    .filter(
      (r): r is { userId: string; openAssigned: number; resolvedInWindow: number } =>
        Boolean(r.userId) && (r.openAssigned > 0 || r.resolvedInWindow > 0),
    )
    .sort((a, b) => a.userId.localeCompare(b.userId))
    .slice(0, SHIFT_OVERVIEW_MAX_PERSONS);

  const facts: InsightFact[] = [
    metric('window_days', days, {
      th: `ช่วงเวลา ${String(days)} วัน`,
      en: `Window of ${String(days)} days`,
    }),
    metric('team_members_count', activeRows.length, {
      th: `เจ้าหน้าที่ที่มีงาน ${String(activeRows.length)} คน`,
      en: `${String(activeRows.length)} active team members`,
    }),
  ];

  const LETTERS = 'abcdefgh';
  activeRows.forEach((row, index) => {
    const letter = LETTERS[index];
    if (letter === undefined) return;
    const ref = { kind: 'user' as const, id: row.userId };
    facts.push(
      metric(
        `person_${letter}_open`,
        row.openAssigned,
        {
          th: `{person_${letter}}: ถืออยู่ ${String(row.openAssigned)} รายการ`,
          en: `{person_${letter}}: ${String(row.openAssigned)} open items`,
        },
        ref,
      ),
      metric(
        `person_${letter}_resolved`,
        row.resolvedInWindow,
        {
          th: `{person_${letter}}: ปิดได้ ${String(row.resolvedInWindow)} รายการ`,
          en: `{person_${letter}}: ${String(row.resolvedInWindow)} items resolved`,
        },
        ref,
      ),
    );
  });

  return finishFacts(facts, now, options.view);
}

/**
 * `dashboard.ops.usage` (mode N, period `days`): telemetry points collected,
 * active metric definitions, anomalies detected, and resulting proactive tickets.
 */
export async function buildDashboardUsageFacts(
  options: DashboardInsightOptions,
): Promise<InsightFactsResult> {
  const { executor, days } = options;
  const window = await readDashboardWindow(executor, days);
  const now = window.now;
  const since = window.since;

  const [metricDefs, pointsRow, anomaliesRow] = await Promise.all([
    executor
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.usageMetricDef)
      .where(eq(schema.usageMetricDef.active, true)),
    executor
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.usageMetricPoint)
      .where(sql`${schema.usageMetricPoint.ts} >= ${since.toISOString()}::timestamptz`),
    executor
      .select({
        totalAnomalies: sql<number>`count(*)::int`,
        proactiveTickets: sql<number>`count(DISTINCT ${schema.usageAnomaly.ticketId})::int`,
      })
      .from(schema.usageAnomaly)
      .where(sql`${schema.usageAnomaly.bucketTs} >= ${since.toISOString()}::timestamptz`),
  ]);

  const activeMetrics = metricDefs[0]?.count ?? 0;
  const totalPoints = pointsRow[0]?.count ?? 0;
  const anom = anomaliesRow[0] ?? { totalAnomalies: 0, proactiveTickets: 0 };

  const facts: InsightFact[] = [
    metric('window_days', days, {
      th: `ช่วงเวลา ${String(days)} วัน`,
      en: `Window of ${String(days)} days`,
    }),
    metric('active_metrics', activeMetrics, {
      th: `Metric ที่เปิดใช้งาน ${String(activeMetrics)} รายการ`,
      en: `${String(activeMetrics)} active metric definitions`,
    }),
    metric('total_points', totalPoints, {
      th: `บันทึกข้อมูล Usage ${String(totalPoints)} จุด`,
      en: `${String(totalPoints)} usage metric points collected`,
    }),
    metric('anomalies_count', anom.totalAnomalies, {
      th: `ตรวจพบความผิดปกติ ${String(anom.totalAnomalies)} ครั้ง`,
      en: `${String(anom.totalAnomalies)} anomalies detected`,
    }),
    metric('proactive_tickets', anom.proactiveTickets, {
      th: `สร้าง Proactive ticket ${String(anom.proactiveTickets)} รายการ`,
      en: `${String(anom.proactiveTickets)} proactive tickets created`,
    }),
  ];

  return finishFacts(facts, now, options.view);
}
