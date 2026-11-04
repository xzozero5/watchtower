import { schema, type Database } from '@watchtower/db';
import type { DraftVerdict, IntentGradeMetrics, ResolutionClass } from '@watchtower/shared';
import { and, eq, sql } from 'drizzle-orm';

/**
 * The grader's side of the domain (T-301, PRD 6.2, 6.4). It stores verdicts and reads numbers back; it
 * has no opinion about stages. The gate and the "ready for promotion" report (T-304) read
 * `intentGradeMetrics` and decide there.
 */

export interface NewResolutionGrade {
  readonly ticketId: string;
  /** `ticket.reopen_count` of the resolve that was graded. */
  readonly cycle: number;
  readonly intentKey: string | null;
  readonly resolutionClass: ResolutionClass;
  readonly modelClass: ResolutionClass | null;
  readonly draftId: string | null;
  readonly draftVerdict: DraftVerdict;
  readonly draftQuality: number | null;
  readonly policyViolations: readonly unknown[];
  readonly kbGap: boolean;
  readonly reasoning: readonly unknown[];
  readonly csatScore: number | null;
  readonly csatResolved: boolean | null;
  readonly aiRunId: string | null;
  readonly promptVersion: number;
  readonly mock: boolean;
  readonly gradedAt?: Date | undefined;
}

type GradeDb = Pick<Database['db'], 'insert' | 'select'>;

/**
 * Stores a verdict once per (ticket, resolution). A second job for the same resolution changes nothing,
 * which is what makes the worker job safe to run twice. Returns whether this call wrote the row.
 */
export async function recordResolutionGrade(
  db: GradeDb,
  input: NewResolutionGrade,
): Promise<{ readonly inserted: boolean }> {
  const written = await db
    .insert(schema.aiResolutionGrade)
    .values({
      ticketId: input.ticketId,
      cycle: input.cycle,
      intentKey: input.intentKey,
      resolutionClass: input.resolutionClass,
      modelClass: input.modelClass,
      draftId: input.draftId,
      draftVerdict: input.draftVerdict,
      draftQuality: input.draftQuality,
      policyViolations: [...input.policyViolations],
      violationCount: input.policyViolations.length,
      kbGap: input.kbGap,
      reasoning: [...input.reasoning],
      csatScore: input.csatScore,
      csatResolved: input.csatResolved,
      aiRunId: input.aiRunId,
      promptVersion: input.promptVersion,
      mock: input.mock,
      ...(input.gradedAt === undefined ? {} : { gradedAt: input.gradedAt }),
    })
    .onConflictDoNothing({
      target: [schema.aiResolutionGrade.ticketId, schema.aiResolutionGrade.cycle],
    })
    .returning({ id: schema.aiResolutionGrade.id });
  return { inserted: written.length > 0 };
}

export async function hasResolutionGrade(
  db: Pick<Database['db'], 'select'>,
  ticketId: string,
  cycle: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.aiResolutionGrade.id })
    .from(schema.aiResolutionGrade)
    .where(
      and(
        eq(schema.aiResolutionGrade.ticketId, ticketId),
        eq(schema.aiResolutionGrade.cycle, cycle),
      ),
    )
    .limit(1);
  return row !== undefined;
}

interface GradeAggregate extends Record<string, unknown> {
  intent_key: string | null;
  graded: string;
  verified: string;
  contained: string;
  assumed: string;
  quality_n: string;
  quality_avg: string | null;
  violations: string;
  kb_gaps: string;
  reopened: string;
  csat_n: string;
  csat_avg: string | null;
  mock: boolean;
}

interface DraftAggregate extends Record<string, unknown> {
  intent_key: string | null;
  approved: string;
  edited: string;
  rejected: string;
  edit_avg: string | null;
}

const num = (value: string | null | undefined): number => (value == null ? 0 : Number(value));
const rate = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);

/**
 * Per intent, over resolutions graded in `[from, to)`, plus the drafts people acted on in the same
 * window. Reopened means the ticket was reopened after the graded resolution (`reopen_count > cycle`).
 * CSAT is the mean score of answered surveys of the graded tickets. Intents with no grade and no draft do not
 * appear; a ticket with no intent is the row whose `intentKey` is null. Counts only, no verdict.
 */
export async function intentGradeMetrics(
  db: Pick<Database['db'], 'execute'>,
  window: { readonly from: Date; readonly to: Date },
): Promise<IntentGradeMetrics[]> {
  const from = window.from.toISOString();
  const to = window.to.toISOString();
  const grades = await db.execute<GradeAggregate>(sql`
    SELECT g.intent_key,
           count(*) AS graded,
           count(*) FILTER (WHERE g.resolution_class = 'verified') AS verified,
           count(*) FILTER (WHERE g.resolution_class = 'contained') AS contained,
           count(*) FILTER (WHERE g.resolution_class = 'assumed') AS assumed,
           count(g.draft_quality) AS quality_n,
           avg(g.draft_quality) AS quality_avg,
           coalesce(sum(g.violation_count), 0) AS violations,
           count(*) FILTER (WHERE g.kb_gap) AS kb_gaps,
           count(*) FILTER (WHERE t.reopen_count > g.cycle) AS reopened,
           count(c.score) AS csat_n,
           avg(c.score) AS csat_avg,
           bool_or(g.mock) AS mock
      FROM ai_resolution_grade g
      JOIN ticket t ON t.id = g.ticket_id
      LEFT JOIN LATERAL (
        SELECT s.score FROM csat_survey s
         WHERE s.ticket_id = g.ticket_id AND s.status = 'answered' AND s.score IS NOT NULL
         ORDER BY s.answered_at DESC LIMIT 1
      ) c ON true
     WHERE g.graded_at >= ${from}::timestamptz AND g.graded_at < ${to}::timestamptz
     GROUP BY g.intent_key
  `);
  const drafts = await db.execute<DraftAggregate>(sql`
    SELECT i.key AS intent_key,
           count(*) FILTER (WHERE d.disposition = 'approved') AS approved,
           count(*) FILTER (WHERE d.disposition = 'edited') AS edited,
           count(*) FILTER (WHERE d.disposition = 'rejected') AS rejected,
           avg(d.edit_distance) FILTER (WHERE d.disposition IN ('approved', 'edited')) AS edit_avg
      FROM ai_draft d
      JOIN ticket t ON t.id = d.ticket_id
      LEFT JOIN intent i ON i.id = t.intent_id
     WHERE d.disposition IS NOT NULL
       AND d.resolved_at >= ${from}::timestamptz AND d.resolved_at < ${to}::timestamptz
     GROUP BY i.key
  `);

  const byKey = new Map<string | null, IntentGradeMetrics>();
  const blank = (intentKey: string | null): IntentGradeMetrics => ({
    intentKey,
    graded: 0,
    verified: 0,
    contained: 0,
    assumed: 0,
    verifiedRate: 0,
    containedRate: 0,
    assumedRate: 0,
    avgDraftQuality: null,
    draftsCompared: 0,
    policyViolations: 0,
    kbGaps: 0,
    reopened: 0,
    reopenRate: 0,
    csatAnswered: 0,
    csatAvg: null,
    draftsApproved: 0,
    draftsEdited: 0,
    draftsRejected: 0,
    avgEditDistance: null,
    mock: false,
  });
  for (const row of grades.rows) {
    const graded = num(row.graded);
    const verified = num(row.verified);
    const contained = num(row.contained);
    const assumed = num(row.assumed);
    const reopened = num(row.reopened);
    byKey.set(row.intent_key, {
      ...blank(row.intent_key),
      graded,
      verified,
      contained,
      assumed,
      verifiedRate: rate(verified, graded),
      containedRate: rate(contained, graded),
      assumedRate: rate(assumed, graded),
      avgDraftQuality: row.quality_avg === null ? null : Number(row.quality_avg),
      draftsCompared: num(row.quality_n),
      policyViolations: num(row.violations),
      kbGaps: num(row.kb_gaps),
      reopened,
      reopenRate: rate(reopened, graded),
      csatAnswered: num(row.csat_n),
      csatAvg: row.csat_avg === null ? null : Number(row.csat_avg),
      mock: row.mock,
    });
  }
  for (const row of drafts.rows) {
    const current = byKey.get(row.intent_key) ?? blank(row.intent_key);
    byKey.set(row.intent_key, {
      ...current,
      draftsApproved: num(row.approved),
      draftsEdited: num(row.edited),
      draftsRejected: num(row.rejected),
      avgEditDistance: row.edit_avg === null ? null : Number(row.edit_avg),
    });
  }
  return [...byKey.values()].toSorted((a, b) =>
    (a.intentKey ?? '￿').localeCompare(b.intentKey ?? '￿'),
  );
}
