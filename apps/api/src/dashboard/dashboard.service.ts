import { Inject, Injectable } from '@nestjs/common';
import { orgScopeCondition, schema, type Database } from '@watchtower/db';
import { billingPeriod } from '@watchtower/domain';
import {
  DASHBOARD_AT_RISK_MINUTES,
  DASHBOARD_CFR_ATTRIBUTION_HOURS,
  DASHBOARD_KB_STALE_DAYS,
  DASHBOARD_MAX_AGENTS,
  DASHBOARD_TOP_N,
  HEALTH_FORMULA_VERSION,
  OPEN_STATUSES,
  TICKET_EVENT_TYPES,
  type DashboardOps,
  type OrgScope,
  type Permission,
} from '@watchtower/shared';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import { forbidden } from '../auth/http-errors.js';
import type { Principal } from '../auth/principal.js';
import { DATABASE } from '../database/database.module.js';

type Value<Data> =
  | { readonly status: 'ok'; readonly data: Data }
  | {
      readonly status: 'not_available';
      readonly reason: 'no_data' | 'needs_grader' | 'not_collected' | 'not_implemented';
    }
  | { readonly status: 'restricted'; readonly requires: string };

const ok = <Data>(data: Data): Value<Data> => ({ status: 'ok', data });
const missing = (
  reason: 'no_data' | 'needs_grader' | 'not_collected' | 'not_implemented',
): Value<never> => ({
  status: 'not_available',
  reason,
});

const count = z.number().int();
const maybeNumber = z.number().nullable();
const iso = (date: Date): string => date.toISOString();
const ratio = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);

/** What each restricted section needs, so a role below it sees "restricted" and not an empty figure. */
const GATES = {
  csat: 'csat.read',
  ai: 'ai.run.read',
  perAgent: 'performance.read.all',
  usage: 'metric.read',
  health: 'org.health.read',
} as const satisfies Record<string, Permission>;

const CACHE_MS = 30_000;

interface CacheEntry {
  readonly at: number;
  readonly value: Promise<DashboardOps>;
}

/**
 * The ops dashboard (PRD 9.1) as one read model. Every figure is an aggregate over Watchtower's own tables
 * computed by a handful of queries run together; the whole result is cached for 30 seconds per window, and
 * the part a role may not see is replaced on the way out, never computed into a different answer.
 *
 * Rules: a figure with nothing behind it is `not_available`, not zero (N5); a figure that waits for the
 * grader (Phase 3) is `not_available / needs_grader`; every query that touches an organization's rows takes
 * the caller's scope through `orgScopeCondition`. A customer is refused before any query (the permission
 * guard, and again here).
 */
@Injectable()
export class DashboardService {
  private readonly cache = new Map<number, CacheEntry>();

  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async ops(days: number, principal: Principal): Promise<DashboardOps> {
    if (principal.orgScope.kind !== 'all') throw forbidden();
    const full = await this.cached(days, principal.orgScope);
    return restrict(full, principal);
  }

  private cached(days: number, scope: OrgScope): Promise<DashboardOps> {
    const now = Date.now();
    const hit = this.cache.get(days);
    if (hit !== undefined && now - hit.at < CACHE_MS) return hit.value;
    const value = this.compute(days, scope);
    this.cache.set(days, { at: now, value });
    value.catch(() => {
      // A failed run is not kept: the next request tries again.
      if (this.cache.get(days)?.value === value) this.cache.delete(days);
    });
    return value;
  }

  /** Runs a query and checks every row against the shape the figure below expects. */
  private async rows<Row extends z.ZodType>(row: Row, query: SQL): Promise<z.output<Row>[]> {
    const result = await this.database.db.execute(query);
    return z.array(row).parse(result.rows);
  }

  private async one<Row extends z.ZodType>(row: Row, query: SQL): Promise<z.output<Row>> {
    const [first] = await this.rows(row, query);
    if (first === undefined) throw new Error('an aggregate query returned no row');
    return first;
  }

  private async compute(days: number, scope: OrgScope): Promise<DashboardOps> {
    const ticketScope = orgScopeCondition(schema.ticket.orgId, scope);
    const and_ = (...parts: (SQL | undefined)[]): SQL => and(...parts) ?? sql`true`;
    // The first instant of the first UTC day of the window: whole days, the last one still running.
    const since = sql`((date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => ${days - 1}::int)) AT TIME ZONE 'UTC')`;
    const openStatus = inArray(schema.ticket.status, [...OPEN_STATUSES]);
    const db = this.database.db;

    const [
      queue,
      queueGroups,
      volume,
      sla,
      quality,
      csat,
      alertsOpen,
      alertsWindow,
      incidents,
      openIncidents,
      deploys,
      intents,
      drafts,
      cost,
      kb,
      agents,
      carried,
      line,
      usageMetrics,
      usageAnomalies,
      health,
      components,
    ] = await Promise.all([
      this.one(
        z.object({
          now: z.coerce.date(),
          since: z.coerce.date(),
          open: count,
          unassigned: count,
          paused: count,
          breached: count,
          at_risk: count,
          lt_4h: count,
          h4_24: count,
          d1_3: count,
          gt_3d: count,
        }),
        sql`SELECT now() AS now, ${since} AS since,
          count(*)::int AS open,
          count(*) FILTER (WHERE assignee_id IS NULL)::int AS unassigned,
          count(*) FILTER (WHERE sla_paused_at IS NOT NULL)::int AS paused,
          count(*) FILTER (WHERE sla_paused_at IS NULL AND due < now())::int AS breached,
          count(*) FILTER (WHERE sla_paused_at IS NULL AND due >= now()
            AND due < now() + make_interval(mins => ${DASHBOARD_AT_RISK_MINUTES}::int))::int AS at_risk,
          count(*) FILTER (WHERE age < interval '4 hours')::int AS lt_4h,
          count(*) FILTER (WHERE age >= interval '4 hours' AND age < interval '1 day')::int AS h4_24,
          count(*) FILTER (WHERE age >= interval '1 day' AND age < interval '3 days')::int AS d1_3,
          count(*) FILTER (WHERE age >= interval '3 days')::int AS gt_3d
        FROM (
          SELECT assignee_id, sla_paused_at, now() - created_at AS age,
            CASE WHEN first_responded_at IS NULL THEN first_response_due_at ELSE resolution_due_at END AS due
          FROM ticket WHERE ${and_(openStatus, ticketScope)}
        ) open_tickets`,
      ),
      this.rows(
        z.object({ status: z.string(), priority: z.string(), n: count }),
        sql`SELECT status, priority, count(*)::int AS n FROM ticket
          WHERE ${and_(openStatus, ticketScope)} GROUP BY status, priority`,
      ),
      this.rows(
        z.object({ channel: z.string(), day: z.string(), n: count }),
        sql`SELECT channel, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS n
          FROM ticket WHERE ${and_(sql`created_at >= ${since}`, ticketScope)} GROUP BY 1, 2`,
      ),
      this.one(
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
      ),
      this.one(
        z.object({ finished: count, reopened: count, tickets: count, to_dev: count }),
        sql`SELECT
          count(*) FILTER (WHERE resolved_at IS NOT NULL OR reopen_count > 0)::int AS finished,
          count(*) FILTER (WHERE reopen_count > 0)::int AS reopened,
          count(*)::int AS tickets,
          count(*) FILTER (WHERE dev.went)::int AS to_dev
        FROM ticket
        LEFT JOIN LATERAL (
          SELECT true AS went FROM ticket_event e
          WHERE e.ticket_id = ticket.id AND e.created_at >= ${since}
            AND e.type = ${TICKET_EVENT_TYPES.statusChanged} AND e.payload ->> 'to' = 'waiting_on_dev'
          LIMIT 1
        ) dev ON true
        WHERE ${and_(sql`ticket.created_at >= ${since}`, sql`ticket.status <> 'merged'`, ticketScope)}`,
      ),
      this.one(
        z.object({ sent: count, answered: count, average: maybeNumber }),
        sql`SELECT count(*)::int AS sent,
          count(*) FILTER (WHERE status = 'answered')::int AS answered,
          avg(score) FILTER (WHERE status = 'answered')::float8 AS average
        FROM csat_survey
        WHERE ${and_(sql`sent_at >= ${since}`, orgScopeCondition(schema.csatSurvey.orgId, scope))}`,
      ),
      this.rows(
        z.object({ severity: z.string(), n: count }),
        sql`SELECT severity, count(*)::int AS n FROM alert WHERE state <> 'resolved' GROUP BY severity`,
      ),
      this.one(
        z.object({
          acked: count,
          mtta_p50: maybeNumber,
          mtta_p90: maybeNumber,
          settled: count,
          noisy: count,
        }),
        sql`SELECT
          count(*) FILTER (WHERE acked_at IS NOT NULL)::int AS acked,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM acked_at - first_seen_at)::float8)
            FILTER (WHERE acked_at IS NOT NULL) AS mtta_p50,
          percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM acked_at - first_seen_at)::float8)
            FILTER (WHERE acked_at IS NOT NULL) AS mtta_p90,
          count(*) FILTER (WHERE state = 'resolved')::int AS settled,
          count(*) FILTER (WHERE state = 'resolved' AND acked_at IS NULL AND incident_id IS NULL)::int AS noisy
        FROM alert WHERE first_seen_at >= ${since}`,
      ),
      this.one(
        z.object({
          started: count,
          sev1: count,
          sev2: count,
          sev3: count,
          sev4: count,
          mttr_n: count,
          mttr_p50: maybeNumber,
          mttr_p90: maybeNumber,
          open_now: count,
          affected: count,
        }),
        sql`SELECT count(*)::int AS started,
          count(*) FILTER (WHERE severity = 'SEV1')::int AS sev1,
          count(*) FILTER (WHERE severity = 'SEV2')::int AS sev2,
          count(*) FILTER (WHERE severity = 'SEV3')::int AS sev3,
          count(*) FILTER (WHERE severity = 'SEV4')::int AS sev4,
          count(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS mttr_n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM resolved_at - started_at)::float8)
            FILTER (WHERE resolved_at IS NOT NULL) AS mttr_p50,
          percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM resolved_at - started_at)::float8)
            FILTER (WHERE resolved_at IS NOT NULL) AS mttr_p90,
          (SELECT count(*)::int FROM incident WHERE status <> 'resolved') AS open_now,
          (SELECT count(DISTINCT incident_org.org_id)::int FROM incident_org
            JOIN incident i ON i.id = incident_org.incident_id
            WHERE ${and_(sql`i.started_at >= ${since}`, orgScopeCondition(schema.incidentOrg.orgId, scope))}) AS affected
        FROM incident WHERE started_at >= ${since}`,
      ),
      db
        .select({
          id: schema.incident.id,
          number: schema.incident.number,
          title: schema.incident.title,
          severity: schema.incident.severity,
          status: schema.incident.status,
          startedAt: schema.incident.startedAt,
        })
        .from(schema.incident)
        .where(sql`${schema.incident.status} <> 'resolved'`)
        .orderBy(desc(schema.incident.startedAt))
        .limit(10),
      this.one(
        z.object({ deploys: count, followed: count }),
        sql`SELECT count(*)::int AS deploys,
          count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM incident_service s JOIN incident i ON i.id = s.incident_id
            WHERE s.service_id = d.service_id AND i.started_at >= d.occurred_at
              AND i.started_at < d.occurred_at + make_interval(hours => ${DASHBOARD_CFR_ATTRIBUTION_HOURS}::int)
          ))::int AS followed
        FROM deploy d WHERE d.service_id IS NOT NULL AND d.occurred_at >= ${since}`,
      ),
      db
        .select({
          key: schema.intent.key,
          name: schema.intent.name,
          stage: schema.intent.autonomyStage,
          pinned: schema.intent.autonomyPinned,
        })
        .from(schema.intent)
        .where(eq(schema.intent.isActive, true))
        .orderBy(asc(schema.intent.key)),
      this.one(
        z.object({ approved: count, edited: count, rejected: count, edit_distance: maybeNumber }),
        sql`SELECT count(*) FILTER (WHERE disposition = 'approved')::int AS approved,
          count(*) FILTER (WHERE disposition = 'edited')::int AS edited,
          count(*) FILTER (WHERE disposition = 'rejected')::int AS rejected,
          avg(edit_distance) FILTER (WHERE disposition = 'edited')::float8 AS edit_distance
        FROM ai_draft JOIN ticket ON ticket.id = ai_draft.ticket_id
        WHERE ${and_(sql`ai_draft.disposition IS NOT NULL`, sql`ai_draft.resolved_at >= ${since}`, ticketScope)}`,
      ),
      this.one(
        z.object({ total: maybeNumber, tickets: count, unpriced: count }),
        sql`SELECT sum(ai_run.cost_usd)::float8 AS total,
          count(DISTINCT ai_run.ticket_id)::int AS tickets,
          count(*) FILTER (WHERE ai_run.cost_usd IS NULL)::int AS unpriced
        FROM ai_run JOIN ticket ON ticket.id = ai_run.ticket_id
        WHERE ${and_(sql`ai_run.created_at >= ${since}`, ticketScope)}`,
      ),
      this.one(
        z.object({ published: count, stale: count }),
        sql`SELECT count(*)::int AS published,
          count(*) FILTER (WHERE last_verified_at IS NULL
            OR last_verified_at < now() - make_interval(days => ${DASHBOARD_KB_STALE_DAYS}::int))::int AS stale
        FROM kb_article WHERE status = 'published'`,
      ),
      this.rows(
        z.object({ id: z.uuid(), name: z.string(), open: count, resolved: count }),
        sql`SELECT users.id, users.name,
          count(*) FILTER (WHERE ${openStatus})::int AS open,
          count(*) FILTER (WHERE ticket.resolved_at >= ${since})::int AS resolved
        FROM ticket JOIN users ON users.id = ticket.assignee_id
        WHERE ${and_(sql`(${openStatus} OR ticket.resolved_at >= ${since})`, ticketScope)}
        GROUP BY users.id, users.name
        ORDER BY open DESC, resolved DESC, users.name ASC
        LIMIT ${DASHBOARD_MAX_AGENTS}`,
      ),
      this.one(
        z.object({ items: count }),
        sql`SELECT count(*)::int AS items FROM handoff_item
          JOIN handoff ON handoff.id = handoff_item.handoff_id
          WHERE handoff.status = 'confirmed' AND handoff.confirmed_at >= ${since}
            AND handoff_item.carried_shifts > 0 AND handoff_item.ack_status IN ('pending', 'question')`,
      ),
      this.one(
        z.object({ used: count, limit_known: count, quota: count, accounts: count }),
        sql`SELECT coalesce(sum(q.used), 0)::int AS used,
          count(q.quota_limit)::int AS limit_known,
          coalesce(sum(q.quota_limit), 0)::int AS quota,
          count(*)::int AS accounts
        FROM channel_quota_usage q JOIN channel_account a ON a.id = q.channel_account_id
        WHERE a.type = 'line' AND q.period = ${billingPeriod(new Date())}`,
      ),
      this.one(
        z.object({ active: count }),
        sql`SELECT count(*)::int AS active FROM usage_metric_def WHERE active`,
      ),
      this.rows(
        z.object({
          id: z.uuid(),
          key: z.string(),
          org_id: z.uuid().nullable(),
          observed: z.number(),
          baseline: z.number(),
          created_at: z.coerce.date(),
          total: count,
        }),
        sql`SELECT a.id, d.key, a.org_id, a.observed, a.baseline, a.created_at, (count(*) OVER ())::int AS total
          FROM usage_anomaly a JOIN usage_metric_def d ON d.id = a.metric_id
          WHERE ${and_(sql`a.created_at >= ${since}`, orgScopeCondition(schema.usageAnomaly.orgId, scope))}
          ORDER BY a.created_at DESC, a.id DESC LIMIT ${DASHBOARD_TOP_N}`,
      ),
      this.rows(
        z.object({
          org_id: z.uuid(),
          name: z.string(),
          day: z.string(),
          status: z.string(),
          score: z.number().int().nullable(),
          scored: count,
          insufficient: count,
        }),
        sql`WITH latest AS (
            SELECT DISTINCT ON (org_id) org_id, to_char(day, 'YYYY-MM-DD') AS day, status, score
            FROM org_health_snapshot
            WHERE ${and_(
              sql`formula_version = ${HEALTH_FORMULA_VERSION}`,
              orgScopeCondition(schema.orgHealthSnapshot.orgId, scope),
            )}
            ORDER BY org_id, org_health_snapshot.day DESC
          )
          SELECT l.org_id, o.name, l.day, l.status, l.score,
            (count(*) FILTER (WHERE l.status = 'scored') OVER ())::int AS scored,
            (count(*) FILTER (WHERE l.status <> 'scored') OVER ())::int AS insufficient
          FROM latest l JOIN organization o ON o.id = l.org_id
          ORDER BY l.score ASC NULLS LAST, o.name ASC LIMIT ${DASHBOARD_TOP_N}`,
      ),
      db
        .select({
          slug: schema.statusComponent.slug,
          name: schema.statusComponent.name,
          status: schema.statusComponent.status,
          public: schema.statusComponent.public,
        })
        .from(schema.statusComponent)
        .orderBy(asc(schema.statusComponent.position), asc(schema.statusComponent.slug)),
    ]);

    const window = { from: iso(queue.since), to: iso(queue.now) };
    const byStatus: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    for (const group of queueGroups) {
      byStatus[group.status] = (byStatus[group.status] ?? 0) + group.n;
      byPriority[group.priority] = (byPriority[group.priority] ?? 0) + group.n;
    }

    const byChannel: Record<string, number> = {};
    const perDay = new Map<string, number>();
    for (const row of volume) {
      byChannel[row.channel] = (byChannel[row.channel] ?? 0) + row.n;
      perDay.set(row.day, (perDay.get(row.day) ?? 0) + row.n);
    }
    const byDay: { day: string; created: number }[] = [];
    for (let offset = 0; offset < days; offset += 1) {
      const day = iso(new Date(queue.since.getTime() + offset * 86_400_000)).slice(0, 10);
      byDay.push({ day, created: perDay.get(day) ?? 0 });
    }

    const duration = (n: number, median: number | null, p90: number | null) =>
      n === 0 || median === null || p90 === null
        ? missing('no_data')
        : ok({ medianSeconds: median, p90Seconds: p90, samples: n });
    const breach = (evaluated: number, breached: number) =>
      evaluated === 0
        ? missing('no_data')
        : ok({ evaluated, breached, rate: ratio(breached, evaluated) });

    const decided = drafts.approved + drafts.edited + drafts.rejected;
    const openBySeverity: Record<string, number> = {};
    for (const row of alertsOpen) openBySeverity[row.severity] = row.n;

    const lowest = health
      .filter(
        (row): row is typeof row & { score: number } =>
          row.status === 'scored' && row.score !== null,
      )
      .map((row) => ({ orgId: row.org_id, orgName: row.name, score: row.score, day: row.day }));

    return {
      generatedAt: iso(queue.now),
      window: { ...window, days },
      queue: {
        open: queue.open,
        unassigned: queue.unassigned,
        byStatus,
        byPriority,
        paused: queue.paused,
        breachedNow: queue.breached,
        atRiskNow: queue.at_risk,
        atRiskMinutes: DASHBOARD_AT_RISK_MINUTES,
        aging: { lt_4h: queue.lt_4h, h4_24: queue.h4_24, d1_3: queue.d1_3, gt_3d: queue.gt_3d },
      },
      volume: {
        created: [...perDay.values()].reduce((sum, n) => sum + n, 0),
        byChannel,
        byDay,
      },
      sla: {
        basis: 'wall_clock',
        firstResponse: duration(sla.frt_n, sla.frt_p50, sla.frt_p90),
        resolution: duration(sla.ttr_n, sla.ttr_p50, sla.ttr_p90),
        firstResponseBreach: breach(sla.frt_eval, sla.frt_breached),
        resolutionBreach: breach(sla.ttr_eval, sla.ttr_breached),
      },
      quality: {
        csat:
          csat.answered === 0 || csat.average === null
            ? missing('no_data')
            : ok({
                answered: csat.answered,
                sent: csat.sent,
                average: csat.average,
                responseRate: csat.sent === 0 ? null : ratio(csat.answered, csat.sent),
              }),
        reopen:
          quality.finished === 0
            ? missing('no_data')
            : ok({
                resolved: quality.finished,
                reopened: quality.reopened,
                rate: ratio(quality.reopened, quality.finished),
              }),
        toDev:
          quality.tickets === 0
            ? missing('no_data')
            : ok({
                tickets: quality.tickets,
                waitedOnDev: quality.to_dev,
                rate: ratio(quality.to_dev, quality.tickets),
              }),
        // Tickets have no escalation record yet: only alerts escalate. Nothing to count, so nothing is claimed.
        escalation: missing('not_collected'),
      },
      reliability: {
        incidents: {
          started: incidents.started,
          openNow: incidents.open_now,
          bySeverity: {
            SEV1: incidents.sev1,
            SEV2: incidents.sev2,
            SEV3: incidents.sev3,
            SEV4: incidents.sev4,
          },
          affectedOrgs: incidents.affected,
          mttr: duration(incidents.mttr_n, incidents.mttr_p50, incidents.mttr_p90),
          open: openIncidents.map((row) => ({
            id: row.id,
            number: row.number,
            title: row.title,
            severity: row.severity,
            status: row.status,
            startedAt: iso(row.startedAt),
          })),
        },
        alerts: {
          openNow: alertsOpen.reduce((sum, row) => sum + row.n, 0),
          openBySeverity: openBySeverity,
          mtta: duration(alertsWindow.acked, alertsWindow.mtta_p50, alertsWindow.mtta_p90),
          noise:
            alertsWindow.settled === 0
              ? missing('no_data')
              : ok({
                  settled: alertsWindow.settled,
                  noisy: alertsWindow.noisy,
                  ratio: ratio(alertsWindow.noisy, alertsWindow.settled),
                }),
        },
        changeFailure:
          deploys.deploys === 0
            ? missing('no_data')
            : ok({
                deploys: deploys.deploys,
                followedByIncident: deploys.followed,
                rate: ratio(deploys.followed, deploys.deploys),
                attributionHours: DASHBOARD_CFR_ATTRIBUTION_HOURS,
              }),
      },
      ai: ok({
        stages: intents.map((row) => ({
          intent: row.key,
          name: row.name,
          stage: row.stage,
          pinned: row.pinned,
        })),
        drafts:
          decided === 0
            ? missing('no_data')
            : ok({
                decided,
                approved: drafts.approved,
                edited: drafts.edited,
                rejected: drafts.rejected,
                acceptanceRate: ratio(drafts.approved + drafts.edited, decided),
                averageEditDistance: drafts.edit_distance,
              }),
        cost:
          cost.tickets === 0 || cost.total === null
            ? missing('no_data')
            : ok({
                totalUsd: cost.total,
                tickets: cost.tickets,
                perTicketUsd: cost.total / cost.tickets,
                unpricedRuns: cost.unpriced,
              }),
        kb:
          kb.published === 0
            ? missing('no_data')
            : ok({
                published: kb.published,
                stale: kb.stale,
                staleAfterDays: DASHBOARD_KB_STALE_DAYS,
              }),
        // These need the grader (Phase 3) to say whether an answer was right: no stand-in is computed.
        noTouchRate: missing('needs_grader'),
        verifiedVsAssumed: missing('needs_grader'),
        kbCoverage: missing('needs_grader'),
      }),
      team: {
        perAgent:
          agents.length === 0
            ? missing('no_data')
            : ok(
                agents.map((row) => ({
                  userId: row.id,
                  name: row.name,
                  open: row.open,
                  resolved: row.resolved,
                })),
              ),
        // The roster is not compared with the queue yet.
        coverage: missing('not_implemented'),
        carriedOver: ok({ items: carried.items }),
        lineQuota:
          line.accounts === 0
            ? missing('not_collected')
            : ok({
                period: billingPeriod(new Date()),
                used: line.used,
                // One account without a limit makes the total unknown, not the sum of the others.
                limit: line.limit_known === line.accounts ? line.quota : null,
                accounts: line.accounts,
              }),
      },
      usage:
        usageMetrics.active === 0
          ? missing('not_collected')
          : ok({
              anomalies: usageAnomalies[0]?.total ?? 0,
              recent: usageAnomalies.map((row) => ({
                id: row.id,
                metricKey: row.key,
                orgId: row.org_id,
                observed: row.observed,
                baseline: row.baseline,
                createdAt: iso(row.created_at),
              })),
            }),
      health:
        health.length === 0
          ? missing('no_data')
          : ok({
              scored: health[0]?.scored ?? 0,
              insufficientData: health[0]?.insufficient ?? 0,
              lowest,
            }),
      services: components.length === 0 ? missing('not_collected') : ok(components),
    };
  }
}

/** Replaces the sections the caller's role does not include. The computed figures are shared; nothing leaks. */
function restrict(full: DashboardOps, principal: Principal): DashboardOps {
  const lacks = (permission: Permission): boolean => !principal.permissions.has(permission);
  const blocked = (permission: Permission) =>
    ({ status: 'restricted', requires: permission }) as const;
  return {
    ...full,
    quality: {
      ...full.quality,
      csat: lacks(GATES.csat) ? blocked(GATES.csat) : full.quality.csat,
    },
    ai: lacks(GATES.ai) ? blocked(GATES.ai) : full.ai,
    team: {
      ...full.team,
      perAgent: lacks(GATES.perAgent) ? blocked(GATES.perAgent) : full.team.perAgent,
    },
    usage: lacks(GATES.usage) ? blocked(GATES.usage) : full.usage,
    health: lacks(GATES.health) ? blocked(GATES.health) : full.health,
  };
}
