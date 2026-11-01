import { schema, type Database } from '@watchtower/db';
import {
  HEALTH_FORMULA_VERSION,
  HEALTH_MIN_CSAT_ANSWERS,
  HEALTH_MIN_OBSERVATION_DAYS,
  HEALTH_MIN_SLA_TICKETS,
  HEALTH_MIN_WEIGHT_SHARE,
  HEALTH_WEIGHTS_V1,
  USAGE_AUDIT_ACTIONS,
  type HealthComponent,
  type HealthComponentKey,
  type HealthSnapshot,
} from '@watchtower/shared';
import { eq, sql } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { notFound } from '../errors.js';
import { Effects, type DomainContext } from '../types.js';

const clamp = (value: number): number => Math.max(0, Math.min(100, value));

/** Linear from `best` (100) to `worst` (0), flat outside. */
function ramp(value: number, best: number, worst: number): number {
  if (value <= best) return 100;
  if (value >= worst) return 0;
  return clamp(100 * (1 - (value - best) / (worst - best)));
}

export interface HealthFacts {
  /** Days since the organization was created. */
  readonly ageDays: number;
  readonly tickets: { readonly recent: number; readonly priorWeekly: number; readonly prior: number };
  readonly sla: { readonly tickets: number; readonly breached: number };
  readonly csat: { readonly answers: number; readonly average: number | null };
  readonly incidents: number;
  readonly hasUsageData: boolean;
  readonly anomalies: number;
}

const noData = (key: HealthComponentKey, detail: HealthComponent['detail'] = {}): HealthComponent => ({
  key,
  weight: HEALTH_WEIGHTS_V1[key],
  status: 'no_data',
  score: null,
  detail,
});

const scored = (
  key: HealthComponentKey,
  score: number,
  detail: HealthComponent['detail'],
): HealthComponent => ({
  key,
  weight: HEALTH_WEIGHTS_V1[key],
  status: 'ok',
  score: Math.round(clamp(score) * 10) / 10,
  detail,
});

/**
 * Formula v1 `[ASSUMED]`, pure. Five parts, each 0 to 100 or "no data":
 *  - ticket volume: the last 7 days against the weekly average of the 28 before (flat up to 1.25x, zero at 3x);
 *  - SLA: 100 minus twice the breach rate over 30 days (half breached is zero);
 *  - CSAT: the 90-day average mapped from 1..5 to 0..100;
 *  - incidents: 100 minus 25 for each incident that affected the organization in 30 days;
 *  - usage anomalies: 100 minus 20 for each in 30 days.
 * A part speaks only when it has enough to go on (an organization observed for 28 days, 5 tickets for the
 * SLA, 3 answers for CSAT, usage data for the anomalies). The parts that speak are re-weighted to sum to 1;
 * if they carry less than half of the weights there is no score and the snapshot says so (N5).
 */
export function scoreHealth(facts: HealthFacts): {
  status: HealthSnapshot['status'];
  score: number | null;
  components: HealthComponent[];
} {
  const observed = facts.ageDays >= HEALTH_MIN_OBSERVATION_DAYS;
  const components: HealthComponent[] = [];

  if (observed && facts.tickets.prior >= 4) {
    const baseline = Math.max(facts.tickets.priorWeekly, 1);
    const ratio = facts.tickets.recent / baseline;
    components.push(
      scored('ticket_volume', ramp(ratio, 1.25, 3), {
        recent: facts.tickets.recent,
        priorWeekly: Math.round(facts.tickets.priorWeekly * 100) / 100,
        ratio: Math.round(ratio * 100) / 100,
      }),
    );
  } else {
    components.push(noData('ticket_volume', { prior: facts.tickets.prior }));
  }

  if (facts.sla.tickets >= HEALTH_MIN_SLA_TICKETS) {
    const rate = facts.sla.breached / facts.sla.tickets;
    components.push(
      scored('sla', 100 - 200 * rate, {
        tickets: facts.sla.tickets,
        breached: facts.sla.breached,
        rate: Math.round(rate * 1000) / 1000,
      }),
    );
  } else {
    components.push(noData('sla', { tickets: facts.sla.tickets }));
  }

  if (facts.csat.answers >= HEALTH_MIN_CSAT_ANSWERS && facts.csat.average !== null) {
    components.push(
      scored('csat', ((facts.csat.average - 1) / 4) * 100, {
        answers: facts.csat.answers,
        average: Math.round(facts.csat.average * 100) / 100,
      }),
    );
  } else {
    components.push(noData('csat', { answers: facts.csat.answers }));
  }

  components.push(
    observed
      ? scored('incidents', 100 - 25 * facts.incidents, { incidents: facts.incidents })
      : noData('incidents'),
  );

  components.push(
    observed && facts.hasUsageData
      ? scored('usage_anomalies', 100 - 20 * facts.anomalies, { anomalies: facts.anomalies })
      : noData('usage_anomalies'),
  );

  const speaking = components.filter((component) => component.status === 'ok');
  const weight = speaking.reduce((sum, component) => sum + component.weight, 0);
  const share = weight / Object.values(HEALTH_WEIGHTS_V1).reduce((sum, w) => sum + w, 0);
  if (speaking.length === 0 || share < HEALTH_MIN_WEIGHT_SHARE) {
    return { status: 'insufficient_data', score: null, components };
  }
  const total = speaking.reduce(
    (sum, component) => sum + component.weight * (component.score ?? 0),
    0,
  );
  return { status: 'scored', score: Math.round(total / weight), components };
}

/** The facts of one organization, read with the database clock. */
async function gatherFacts(
  db: Database['db'],
  orgId: string,
): Promise<{ facts: HealthFacts; day: string }> {
  const result = await db.execute<{
    day: string;
    age_days: number;
    recent: number;
    prior: number;
    sla_tickets: number;
    sla_breached: number;
    csat_answers: number;
    csat_avg: number | null;
    incidents: number;
    has_usage: boolean;
    anomalies: number;
  }>(sql`
    SELECT
      to_char(timezone('UTC', clock_timestamp()), 'YYYY-MM-DD') AS day,
      extract(epoch FROM (clock_timestamp() - o.created_at)) / 86400 AS age_days,
      (SELECT count(*) FROM ticket t WHERE t.org_id = o.id AND t.channel <> 'internal'
         AND t.created_at >= clock_timestamp() - interval '7 days')::int AS recent,
      (SELECT count(*) FROM ticket t WHERE t.org_id = o.id AND t.channel <> 'internal'
         AND t.created_at >= clock_timestamp() - interval '35 days'
         AND t.created_at < clock_timestamp() - interval '7 days')::int AS prior,
      (SELECT count(*) FROM ticket t WHERE t.org_id = o.id AND t.channel <> 'internal'
         AND t.created_at >= clock_timestamp() - interval '30 days')::int AS sla_tickets,
      (SELECT count(*) FROM ticket t WHERE t.org_id = o.id AND t.channel <> 'internal'
         AND t.created_at >= clock_timestamp() - interval '30 days'
         AND (
           (t.first_response_due_at IS NOT NULL AND (
              t.first_responded_at > t.first_response_due_at
              OR (t.first_responded_at IS NULL AND t.first_response_due_at < clock_timestamp())))
           OR (t.resolution_due_at IS NOT NULL AND (
              t.resolved_at > t.resolution_due_at
              OR (t.resolved_at IS NULL AND t.status NOT IN ('resolved', 'closed', 'merged')
                  AND t.resolution_due_at < clock_timestamp())))
         ))::int AS sla_breached,
      (SELECT count(t.csat_score) FROM ticket t WHERE t.org_id = o.id AND t.csat_score IS NOT NULL
         AND t.created_at >= clock_timestamp() - interval '90 days')::int AS csat_answers,
      (SELECT avg(t.csat_score)::float8 FROM ticket t WHERE t.org_id = o.id AND t.csat_score IS NOT NULL
         AND t.created_at >= clock_timestamp() - interval '90 days') AS csat_avg,
      (SELECT count(*) FROM incident_org io JOIN incident i ON i.id = io.incident_id
         WHERE io.org_id = o.id AND i.started_at >= clock_timestamp() - interval '30 days')::int AS incidents,
      EXISTS (SELECT 1 FROM usage_metric_point p WHERE p.org_id = o.id
         AND p.ts >= clock_timestamp() - interval '7 days') AS has_usage,
      (SELECT count(*) FROM usage_anomaly a WHERE a.org_id = o.id
         AND a.created_at >= clock_timestamp() - interval '30 days')::int AS anomalies
    FROM organization o WHERE o.id = ${orgId}
  `);
  const row = result.rows[0];
  if (row === undefined) throw notFound('No such organization');
  const prior = Number(row.prior);
  return {
    day: row.day,
    facts: {
      ageDays: Number(row.age_days),
      tickets: { recent: Number(row.recent), prior, priorWeekly: prior / 4 },
      sla: { tickets: Number(row.sla_tickets), breached: Number(row.sla_breached) },
      csat: {
        answers: Number(row.csat_answers),
        average: row.csat_avg === null ? null : Number(row.csat_avg),
      },
      incidents: Number(row.incidents),
      hasUsageData: Boolean(row.has_usage),
      anomalies: Number(row.anomalies),
    },
  };
}

/**
 * Computes today's score (UTC day of the database clock) for one organization and stores it: the snapshot
 * of (organization, day, formula version) is replaced, and `organization.health_score` follows it (NULL when
 * there is not enough data). Only facts about this organization are read; nothing is compared with another.
 */
export async function computeOrgHealth(
  db: Database['db'],
  orgId: string,
): Promise<HealthSnapshot> {
  const { facts, day } = await gatherFacts(db, orgId);
  const result = scoreHealth(facts);
  await db.transaction(async (tx) => {
    await tx
      .insert(schema.orgHealthSnapshot)
      .values({
        orgId,
        day,
        formulaVersion: HEALTH_FORMULA_VERSION,
        status: result.status,
        score: result.score,
        components: Object.fromEntries(result.components.map((component) => [component.key, component])),
      })
      .onConflictDoUpdate({
        target: [
          schema.orgHealthSnapshot.orgId,
          schema.orgHealthSnapshot.day,
          schema.orgHealthSnapshot.formulaVersion,
        ],
        set: {
          status: result.status,
          score: result.score,
          components: Object.fromEntries(
            result.components.map((component) => [component.key, component]),
          ),
          createdAt: sql`clock_timestamp()`,
        },
      });
    await tx
      .update(schema.organization)
      .set({ healthScore: result.score })
      .where(eq(schema.organization.id, orgId));
  });
  return {
    orgId,
    day,
    formulaVersion: HEALTH_FORMULA_VERSION,
    status: result.status,
    score: result.score,
    components: result.components,
  };
}

/** Computes every active organization's score, then writes one audit row for the run (system actor). */
export async function computeAllOrgHealth(
  db: Database['db'],
  ctx: DomainContext,
): Promise<{ readonly organizations: number; readonly scored: number }> {
  const orgs = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.status, 'active'));
  let scoredCount = 0;
  for (const org of orgs) {
    const snapshot = await computeOrgHealth(db, org.id);
    if (snapshot.status === 'scored') scoredCount += 1;
  }
  const fx = new Effects();
  await recordAuditInTx(db, ctx, fx, {
    action: USAGE_AUDIT_ACTIONS.healthCompute,
    targetType: 'organization',
    metadata: { organizations: orgs.length, scored: scoredCount, formulaVersion: HEALTH_FORMULA_VERSION },
  });
  return { organizations: orgs.length, scored: scoredCount };
}
