import { schema, type Database } from '@watchtower/db';
import { AUDIT_ACTIONS, type GateCriterion, type GateReport } from '@watchtower/shared';
import { desc, eq, sql } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { DomainError, notFound } from '../errors.js';
import type { Actor, DomainContext } from '../types.js';

/**
 * The gate report of one intent (ADR-025 section 6, PRD 6.4): the numbers a head and the owner read before a
 * promotion, and the input of the automatic rollback. A report is an input to people, never the decider.
 *
 * What is counted:
 *  - resolved tickets of the intent graded in the window (`ai_resolution_grade`), never seed data
 *    (`ticket.seed_batch_id IS NULL`, mock grades left out);
 *  - the AI group is the tickets whose reply was an AI draft sent as it was or edited by at most 10% (what
 *    stage 3 would send), or that an automatic reply handled; the human group is every other graded ticket
 *    `[ASSUMED]`;
 *  - shadow evaluations (`ai_autosend_evaluation`, `mode = 'shadow'`) of those tickets.
 *
 * A criterion with too little data is `pass: null`. The status is `red` when a measurable criterion fails,
 * `insufficient_data` when none fails but one cannot be measured yet, `green` only when all can and pass.
 * The replay of the eval set and the redaction eval run outside the database (`evals/runner`): they are listed
 * as `not_measured` and do not decide the status `[UNVERIFIED]` — the owner's approval step is where they are
 * read.
 */

/** Days a promotion needs at stage 2 (PRD 6.4: 4 weeks). */
export const GATE_WINDOW_DAYS = 28;
/** Graded tickets needed per group before a rate means anything `[ASSUMED]`. */
export const GATE_MIN_GRADED = 20;
/** CSAT answers needed per group (ADR-025 section 6). */
export const GATE_MIN_CSAT = 20;
/** CSAT of the AI group may be at most this far under the human group `[ASSUMED]`. */
export const GATE_CSAT_TOLERANCE = 0.1;
/** Shadow evaluations needed, and the share of the "would send" ones that a person accepted (ADR-025 section 6). */
export const GATE_MIN_SHADOW = 50;
export const GATE_SHADOW_PRECISION = 0.9;
/** A reply edited by at most this share of its length counts as accepted (ADR-025 section 3). */
export const GATE_EDIT_TOLERANCE = 0.1;

export interface GroupStats {
  readonly graded: number;
  readonly verified: number;
  readonly reopened: number;
  readonly violations: number;
  readonly csatN: number;
  readonly csatAvg: number | null;
}

export interface ReportInputs {
  readonly stage: number;
  /** Days the intent has been at its stage without a change (promotion, rollback, manual change). */
  readonly daysAtStage: number;
  readonly ai: GroupStats;
  readonly human: GroupStats;
  readonly shadowEvaluations: number;
  /** Shadow "would send" rows whose draft a person later handled. */
  readonly shadowDecided: number;
  readonly shadowAccepted: number;
}

const rate = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);
const round = (value: number | null, digits = 4): number | null =>
  value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits;

/** Pure: the criteria and the status from the counts. */
export function buildReport(input: ReportInputs): {
  readonly status: GateReport['status'];
  readonly criteria: GateCriterion[];
  readonly metrics: Record<string, unknown>;
} {
  const criteria: GateCriterion[] = [];
  const enough = input.ai.graded >= GATE_MIN_GRADED && input.human.graded >= GATE_MIN_GRADED;
  const aiVerified = rate(input.ai.verified, input.ai.graded);
  const humanVerified = rate(input.human.verified, input.human.graded);
  const aiReopen = rate(input.ai.reopened, input.ai.graded);
  const humanReopen = rate(input.human.reopened, input.human.graded);
  const precision = rate(input.shadowAccepted, input.shadowDecided);

  if (input.stage <= 2) {
    criteria.push({
      key: 'days_at_stage_2',
      pass: input.daysAtStage >= GATE_WINDOW_DAYS ? true : null,
      value: round(input.daysAtStage, 1),
      threshold: GATE_WINDOW_DAYS,
      basis: 'PRD',
    });
  }
  criteria.push(
    {
      key: 'graded_sample',
      pass: enough ? true : null,
      value: `${String(input.ai.graded)} AI / ${String(input.human.graded)} human`,
      threshold: GATE_MIN_GRADED,
      basis: 'ASSUMED',
    },
    {
      key: 'verified_resolution',
      pass:
        !enough || aiVerified === null || humanVerified === null
          ? null
          : aiVerified >= humanVerified,
      value: round(aiVerified),
      threshold: round(humanVerified),
      basis: 'PRD',
    },
    {
      key: 'reopen_rate',
      pass: !enough || aiReopen === null || humanReopen === null ? null : aiReopen <= humanReopen,
      value: round(aiReopen),
      threshold: round(humanReopen),
      basis: 'PRD',
    },
  );
  const csatEnough = input.ai.csatN >= GATE_MIN_CSAT && input.human.csatN >= GATE_MIN_CSAT;
  criteria.push({
    key: 'csat_parity',
    pass:
      csatEnough && input.ai.csatAvg !== null && input.human.csatAvg !== null
        ? input.ai.csatAvg >= input.human.csatAvg - GATE_CSAT_TOLERANCE
        : null,
    value: round(input.ai.csatAvg, 2),
    threshold:
      input.human.csatAvg === null ? null : round(input.human.csatAvg - GATE_CSAT_TOLERANCE, 2),
    basis: 'ASSUMED',
  });
  criteria.push({
    key: 'ai_policy_violations',
    pass: input.ai.graded === 0 ? null : input.ai.violations === 0,
    value: input.ai.violations,
    threshold: 0,
    basis: 'ASSUMED',
  });
  criteria.push(
    {
      key: 'shadow_evaluations',
      pass: input.shadowEvaluations >= GATE_MIN_SHADOW ? true : null,
      value: input.shadowEvaluations,
      threshold: GATE_MIN_SHADOW,
      basis: 'ASSUMED',
    },
    {
      key: 'shadow_precision',
      pass:
        input.shadowEvaluations >= GATE_MIN_SHADOW && precision !== null
          ? precision >= GATE_SHADOW_PRECISION
          : null,
      value: round(precision),
      threshold: GATE_SHADOW_PRECISION,
      basis: 'ASSUMED',
    },
  );
  // Outside the database: listed so a person reads them, never decide the status.
  criteria.push(
    {
      key: 'eval_replay_violations',
      pass: null,
      value: 'not_measured',
      threshold: 0,
      basis: 'ASSUMED',
    },
    {
      key: 'redaction_eval',
      pass: null,
      value: 'not_measured',
      threshold: 'pass',
      basis: 'ASSUMED',
    },
  );

  const deciding = criteria.filter(
    (criterion) => !criterion.key.startsWith('eval_') && criterion.key !== 'redaction_eval',
  );
  const status: GateReport['status'] = deciding.some((criterion) => criterion.pass === false)
    ? 'red'
    : deciding.every((criterion) => criterion.pass === true)
      ? 'green'
      : 'insufficient_data';
  return {
    status,
    criteria,
    metrics: {
      stage: input.stage,
      daysAtStage: round(input.daysAtStage, 1),
      ai: input.ai,
      human: input.human,
      shadow: {
        evaluations: input.shadowEvaluations,
        decided: input.shadowDecided,
        accepted: input.shadowAccepted,
        precision: round(precision),
      },
      groups:
        'AI = reply was an AI draft sent as it was or edited by at most 10%, or an automatic reply; human = every other graded ticket',
    },
  };
}

interface GroupRow extends Record<string, unknown> {
  ai: boolean;
  n: string;
  verified: string;
  reopened: string;
  violations: string;
  csat_n: string;
  csat_avg: string | null;
}

const empty: GroupStats = {
  graded: 0,
  verified: 0,
  reopened: 0,
  violations: 0,
  csatN: 0,
  csatAvg: null,
};

type ReportDb = Pick<Database['db'], 'select' | 'execute' | 'insert'>;

export interface GenerateReportInput {
  readonly intentId: string;
  readonly trigger: 'weekly' | 'on_demand';
  readonly generatedBy: string | null;
  readonly now?: Date | undefined;
}

/** Reads the counts of one intent over its window; everything excludes seed data (ADR-025 section 10). */
export async function readReportInputs(
  db: Pick<Database['db'], 'select' | 'execute'>,
  intentId: string,
  now: Date,
): Promise<{ inputs: ReportInputs; windowStart: Date }> {
  const [intent] = await db
    .select({ stage: schema.intent.autonomyStage, createdAt: schema.intent.createdAt })
    .from(schema.intent)
    .where(eq(schema.intent.id, intentId))
    .limit(1);
  if (intent === undefined) throw notFound('No such intent');
  const [last] = await db
    .select({ at: sql<Date | null>`max(${schema.intentAutonomyHistory.changedAt})` })
    .from(schema.intentAutonomyHistory)
    .where(
      sql`${schema.intentAutonomyHistory.intentId} = ${intentId}
          AND ${schema.intentAutonomyHistory.change} IN ('stage', 'promotion', 'auto_rollback')`,
    );
  const since = last?.at ? new Date(last.at) : intent.createdAt;
  const daysAtStage = (now.getTime() - since.getTime()) / 86_400_000;
  // The window is the stretch spent at this stage, at most the last 28 days (a long stay is not a reason to
  // count old tickets); never empty.
  const earliest = new Date(now.getTime() - GATE_WINDOW_DAYS * 86_400_000);
  const windowStart = new Date(
    Math.min(Math.max(since.getTime(), earliest.getTime()), now.getTime() - 1000),
  );
  const from = windowStart.toISOString();
  const to = now.toISOString();
  const accepted = sql`(d.disposition = 'approved' OR (d.disposition = 'edited' AND d.edit_distance <= ${GATE_EDIT_TOLERANCE}))`;

  const groups = await db.execute<GroupRow>(sql`
    SELECT (t.ai_handled OR (d.id IS NOT NULL AND ${accepted})) AS ai,
           count(*) AS n,
           count(*) FILTER (WHERE g.resolution_class = 'verified') AS verified,
           count(*) FILTER (WHERE t.reopen_count > g.cycle) AS reopened,
           coalesce(sum(g.violation_count), 0) AS violations,
           count(g.csat_score) AS csat_n,
           avg(g.csat_score) AS csat_avg
      FROM ai_resolution_grade g
      JOIN ticket t ON t.id = g.ticket_id AND t.intent_id = ${intentId}::uuid AND t.seed_batch_id IS NULL
      LEFT JOIN ai_draft d ON d.id = g.draft_id
     WHERE g.graded_at >= ${from}::timestamptz AND g.graded_at < ${to}::timestamptz AND NOT g.mock
     GROUP BY 1
  `);
  const stat = (ai: boolean): GroupStats => {
    const row = groups.rows.find((candidate) => candidate.ai === ai);
    return row === undefined
      ? empty
      : {
          graded: Number(row.n),
          verified: Number(row.verified),
          reopened: Number(row.reopened),
          violations: Number(row.violations),
          csatN: Number(row.csat_n),
          csatAvg: row.csat_avg === null ? null : Number(row.csat_avg),
        };
  };
  const shadow = await db.execute<
    { total: string; decided: string; accepted: string } & Record<string, unknown>
  >(sql`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE e.would_auto_send AND d.disposition IS NOT NULL) AS decided,
           count(*) FILTER (WHERE e.would_auto_send AND ${accepted}) AS accepted
      FROM ai_autosend_evaluation e
      JOIN ticket t ON t.id = e.ticket_id AND t.seed_batch_id IS NULL
      LEFT JOIN ai_draft d ON d.id = e.ai_draft_id
     WHERE e.intent_id = ${intentId}::uuid AND e.mode = 'shadow'
       AND e.evaluated_at >= ${from}::timestamptz AND e.evaluated_at < ${to}::timestamptz
  `);
  const s = shadow.rows[0];
  return {
    windowStart,
    inputs: {
      stage: intent.stage,
      daysAtStage,
      ai: stat(true),
      human: stat(false),
      shadowEvaluations: Number(s?.total ?? 0),
      shadowDecided: Number(s?.decided ?? 0),
      shadowAccepted: Number(s?.accepted ?? 0),
    },
  };
}

/**
 * Writes one report row (append-only) and an audit row. A green report needs a window of 28 days (the table
 * checks it); a shorter stay at the stage can only be `insufficient_data` or `red`.
 */
export async function generateGateReport(
  db: ReportDb & Pick<Database['db'], 'transaction'>,
  ctx: Pick<DomainContext, 'actor' | 'auditMeta' | 'now'>,
  input: GenerateReportInput,
): Promise<{ readonly id: string; readonly status: GateReport['status'] }> {
  // The window is cut by the database clock: the rows it counts were stamped by it.
  const clock = await db.execute<{ now: Date } & Record<string, unknown>>(
    sql`SELECT clock_timestamp() AS now`,
  );
  const now = input.now ?? new Date(clock.rows[0]?.now ?? ctx.now());
  const { inputs, windowStart } = await readReportInputs(db, input.intentId, now);
  const built = buildReport(inputs);
  // A green report must cover 28 days at the stage (a table CHECK); a shorter window cannot be green.
  const spansWindow = now.getTime() - windowStart.getTime() >= GATE_WINDOW_DAYS * 86_400_000;
  const status = built.status === 'green' && !spansWindow ? 'insufficient_data' : built.status;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.autonomyGateReport)
      .values({
        intentId: input.intentId,
        status,
        triggerKind: input.trigger,
        windowStart,
        windowEnd: now,
        metrics: built.metrics,
        criteria: built.criteria.map((criterion) => ({
          key: criterion.key,
          pass: criterion.pass,
          value: criterion.value,
          threshold: criterion.threshold,
        })),
        seedExcluded: true,
        generatedBy: input.generatedBy,
      })
      .returning({ id: schema.autonomyGateReport.id });
    if (row === undefined) throw new DomainError('conflict', 'The report was not written');
    const actor: Actor = ctx.actor;
    await recordAuditInTx(
      tx,
      { actor, auditMeta: ctx.auditMeta },
      { audited: false },
      {
        action: AUDIT_ACTIONS.autonomyGateReportGenerated,
        targetType: 'intent',
        targetId: input.intentId,
        metadata: { reportId: row.id, status, trigger: input.trigger },
      },
    );
    return { id: row.id, status };
  });
}

type ReportRow = typeof schema.autonomyGateReport.$inferSelect;

export function toGateReport(row: ReportRow): GateReport {
  return {
    id: row.id,
    intentId: row.intentId,
    status: row.status as GateReport['status'],
    triggerKind: row.triggerKind as GateReport['triggerKind'],
    windowStart: row.windowStart.toISOString(),
    windowEnd: row.windowEnd.toISOString(),
    metrics: row.metrics,
    criteria: row.criteria.map((criterion) => ({
      key: criterion.key,
      pass: criterion.pass,
      value: criterion.value as GateCriterion['value'],
      threshold: criterion.threshold as GateCriterion['threshold'],
      basis: criterionBasis(criterion.key),
    })),
    seedExcluded: row.seedExcluded,
    generatedAt: row.generatedAt.toISOString(),
    generatedBy: row.generatedBy,
  };
}

const PRD_KEYS = new Set(['days_at_stage_2', 'verified_resolution', 'reopen_rate']);
function criterionBasis(key: string): 'PRD' | 'ASSUMED' {
  return PRD_KEYS.has(key) ? 'PRD' : 'ASSUMED';
}

/** The reports of an intent, newest first. */
export async function readGateReports(
  db: Pick<Database['db'], 'select'>,
  intentId: string,
  limit = 10,
): Promise<GateReport[]> {
  const rows = await db
    .select()
    .from(schema.autonomyGateReport)
    .where(eq(schema.autonomyGateReport.intentId, intentId))
    .orderBy(desc(schema.autonomyGateReport.generatedAt))
    .limit(Math.min(Math.max(limit, 1), 50));
  return rows.map(toGateReport);
}
