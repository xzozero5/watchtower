import { schema } from '@watchtower/db';
import { OPEN_STATUSES, type InsightFact, type InsightFactsResult } from '@watchtower/shared';
import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';

import { readDashboardWindow } from '../dashboard/ops.js';
import { readTicketStats } from '../tickets/sla-stats.js';
import {
  driverFacts,
  finishFacts,
  metric,
  serviceNames,
  state,
  type InsightBuildOptions,
} from './facts.js';
import { topDrivers, type DriverCandidate } from './primitives.js';

export interface IncidentDetailOptions extends InsightBuildOptions {
  readonly incidentId: string;
}

export interface OrgHealthOptions extends InsightBuildOptions {
  readonly orgId: string;
  readonly days: number;
}

/**
 * `incident.detail` (mode N, scope `incident`, period `now`): telemetry of a single incident:
 * severity, current status, duration in minutes, and linked alerts and tickets.
 */
export async function buildIncidentDetailFacts(
  options: IncidentDetailOptions,
): Promise<InsightFactsResult> {
  const { executor, incidentId } = options;
  const now = options.now ?? new Date();

  const [incidentRow, alertsCountRow, ticketsCountRow] = await Promise.all([
    executor
      .select({
        id: schema.incident.id,
        number: schema.incident.number,
        severity: schema.incident.severity,
        status: schema.incident.status,
        startedAt: schema.incident.startedAt,
        resolvedAt: schema.incident.resolvedAt,
      })
      .from(schema.incident)
      .where(eq(schema.incident.id, incidentId))
      .limit(1),
    executor
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.alert)
      .where(eq(schema.alert.incidentId, incidentId)),
    executor
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.ticket)
      .where(eq(schema.ticket.incidentId, incidentId)),
  ]);

  const inc = incidentRow[0];
  if (!inc) {
    throw new Error(`Incident not found: ${incidentId}`);
  }

  const endAt = inc.resolvedAt ?? now;
  const durationMinutes = Math.max(
    0,
    Math.round((endAt.getTime() - inc.startedAt.getTime()) / 60_000),
  );
  const linkedAlerts = alertsCountRow[0]?.count ?? 0;
  const linkedTickets = ticketsCountRow[0]?.count ?? 0;
  const incidentRef = { kind: 'incident' as const, id: inc.id };

  const facts: InsightFact[] = [
    metric(
      'incident_number',
      inc.number,
      {
        th: `Incident หมายเลข INC-${String(inc.number)}`,
        en: `Incident INC-${String(inc.number)}`,
      },
      incidentRef,
    ),
    state('severity', inc.severity, {
      th: `ระดับความรุนแรง ${inc.severity}`,
      en: `Severity ${inc.severity}`,
    }),
    state('incident_status', inc.status, {
      th: `สถานะ ${inc.status}`,
      en: `Status is ${inc.status}`,
    }),
    metric('duration_minutes', durationMinutes, {
      th: `ระยะเวลา ${String(durationMinutes)} นาที`,
      en: `Duration ${String(durationMinutes)} minutes`,
    }),
    metric('linked_alerts', linkedAlerts, {
      th: `Alert ที่เกี่ยวข้อง ${String(linkedAlerts)} รายการ`,
      en: `${String(linkedAlerts)} linked alerts`,
    }),
    metric('linked_tickets', linkedTickets, {
      th: `Ticket ที่เชื่อมโยง ${String(linkedTickets)} รายการ`,
      en: `${String(linkedTickets)} linked tickets`,
    }),
  ];

  return finishFacts(facts, now, options.view);
}

/**
 * `alerts.services` (mode F, scope `instance`): status of the service catalog against firing alerts,
 * identifying which services are currently degraded or have active alerts.
 */
export async function buildAlertsServicesFacts(
  options: InsightBuildOptions,
): Promise<InsightFactsResult> {
  const { executor } = options;
  const now = options.now ?? new Date();

  const [totalServicesRow, activeAlertsByService] = await Promise.all([
    executor.select({ count: sql<number>`count(*)::int` }).from(schema.service),
    executor
      .select({
        serviceId: schema.alert.serviceId,
        alertCount: sql<number>`count(*)::int`,
        hasHighSev: sql<boolean>`bool_or(${schema.alert.severity} IN ('critical', 'high'))`,
      })
      .from(schema.alert)
      .where(and(isNotNull(schema.alert.serviceId), ne(schema.alert.state, 'resolved')))
      .groupBy(schema.alert.serviceId)
      .orderBy(desc(sql`count(*)`)),
  ]);

  const totalServices = totalServicesRow[0]?.count ?? 0;
  const servicesWithAlerts = activeAlertsByService.length;
  const servicesDegraded = activeAlertsByService.filter((r) => r.hasHighSev).length;

  const serviceIds = activeAlertsByService
    .map((r) => r.serviceId)
    .filter((id): id is string => typeof id === 'string');
  const names = await serviceNames(executor, serviceIds);

  const candidates: DriverCandidate[] = activeAlertsByService
    .filter((r): r is { serviceId: string; alertCount: number; hasHighSev: boolean } =>
      Boolean(r.serviceId),
    )
    .slice(0, 3)
    .map((r) => ({
      id: r.serviceId,
      name: names.get(r.serviceId) ?? r.serviceId,
      count: r.alertCount,
    }));
  const topServiceDrivers = topDrivers('service', candidates);

  const facts: InsightFact[] = [
    metric('total_services', totalServices, {
      th: `บริการทั้งหมด ${String(totalServices)} บริการ`,
      en: `${String(totalServices)} total services in catalog`,
    }),
    metric('services_with_alerts', servicesWithAlerts, {
      th: `บริการที่มี Alert เปิดอยู่ ${String(servicesWithAlerts)} บริการ`,
      en: `${String(servicesWithAlerts)} services with open alerts`,
    }),
    metric('services_degraded', servicesDegraded, {
      th: `บริการที่มีปัญหาขั้นวิกฤต/สูง ${String(servicesDegraded)} บริการ`,
      en: `${String(servicesDegraded)} services with critical or high alerts`,
    }),
    ...driverFacts(
      'service_alert',
      { th: 'บริการที่มี Alert สูงสุด', en: 'Top alert service' },
      topServiceDrivers,
    ),
  ];

  return finishFacts(facts, now, options.view);
}

/**
 * `statuspage.admin` (mode F, scope `instance`, adminFactsOnly): administrative view
 * of status page components and active announcements.
 */
export async function buildStatuspageAdminFacts(
  options: InsightBuildOptions,
): Promise<InsightFactsResult> {
  const { executor } = options;
  const now = options.now ?? new Date();

  const [componentsSummary, activePostsRow] = await Promise.all([
    executor
      .select({
        total: sql<number>`count(*)::int`,
        nonOperational: sql<number>`count(*) FILTER (WHERE ${schema.statusComponent.status} <> 'operational')::int`,
      })
      .from(schema.statusComponent),
    executor
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.statusPost)
      .where(
        and(ne(schema.statusPost.phase, 'resolved'), eq(schema.statusPost.state, 'published')),
      ),
  ]);

  const total = componentsSummary[0]?.total ?? 0;
  const nonOperational = componentsSummary[0]?.nonOperational ?? 0;
  const activePosts = activePostsRow[0]?.count ?? 0;

  const facts: InsightFact[] = [
    metric('total_components', total, {
      th: `คอมโพเนนต์ทั้งหมด ${String(total)} รายการ`,
      en: `${String(total)} total status page components`,
    }),
    metric('non_operational_components', nonOperational, {
      th: `คอมโพเนนต์ที่ไม่ได้อยู่ในสถานะปกติ ${String(nonOperational)} รายการ`,
      en: `${String(nonOperational)} non-operational components`,
    }),
    metric('active_posts', activePosts, {
      th: `ประกาศ Incident ที่ยังไม่ปิด ${String(activePosts)} รายการ`,
      en: `${String(activePosts)} active published status incident posts`,
    }),
    state('statuspage_state', nonOperational > 0 ? 'degraded' : 'operational', {
      th: 'สถานะหน้า Status page',
      en: 'Status page state',
    }),
  ];

  return finishFacts(facts, now, options.view);
}

/**
 * `org.health` (mode N, scope `org`, period `days`): health profile of a single organization,
 * including ticket load, SLA risks, health score, and usage anomalies.
 */
export async function buildOrgHealthFacts(options: OrgHealthOptions): Promise<InsightFactsResult> {
  const { executor, orgId, days } = options;
  const window = await readDashboardWindow(executor, days);
  const now = window.now;
  const since = window.since;

  const [ticketStats, snapshotRow, anomaliesRow] = await Promise.all([
    readTicketStats(
      executor,
      [eq(schema.ticket.orgId, orgId), inArray(schema.ticket.status, [...OPEN_STATUSES])],
      now,
    ),
    executor
      .select({
        score: schema.orgHealthSnapshot.score,
        status: schema.orgHealthSnapshot.status,
      })
      .from(schema.orgHealthSnapshot)
      .where(eq(schema.orgHealthSnapshot.orgId, orgId))
      .orderBy(desc(schema.orgHealthSnapshot.day))
      .limit(1),
    executor
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.usageAnomaly)
      .where(
        and(
          eq(schema.usageAnomaly.orgId, orgId),
          sql`${schema.usageAnomaly.bucketTs} >= ${since.toISOString()}::timestamptz`,
        ),
      ),
  ]);

  const total = ticketStats.total;
  const snap = snapshotRow[0];
  const anomaliesCount = anomaliesRow[0]?.count ?? 0;
  const orgRef = { kind: 'org' as const, id: orgId };

  const facts: InsightFact[] = [
    metric(
      'open_tickets',
      total.open,
      {
        th: `Ticket เปิดอยู่ ${String(total.open)} รายการ`,
        en: `${String(total.open)} open tickets`,
      },
      orgRef,
    ),
    metric('at_risk', total.sla.at_risk, {
      th: `${String(total.sla.at_risk)} รายการใกล้ผิด SLA`,
      en: `${String(total.sla.at_risk)} tickets close to SLA breach`,
    }),
    metric('breached', total.sla.breached, {
      th: `${String(total.sla.breached)} รายการผิด SLA แล้ว`,
      en: `${String(total.sla.breached)} tickets past SLA`,
    }),
    metric('anomalies_count', anomaliesCount, {
      th: `ตรวจพบความผิดปกติการใช้งาน ${String(anomaliesCount)} ครั้ง`,
      en: `${String(anomaliesCount)} usage anomalies in period`,
    }),
  ];

  if (snap?.score !== null && snap?.score !== undefined) {
    facts.push(
      metric('health_score', snap.score, {
        th: `คะแนนสุขภาพองค์กร ${String(snap.score)}`,
        en: `Organization health score ${String(snap.score)}`,
      }),
    );
  }

  return finishFacts(facts, now, options.view);
}
