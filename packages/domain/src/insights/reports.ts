import { schema } from '@watchtower/db';
import { type InsightFact, type InsightFactsResult } from '@watchtower/shared';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';

import { readDashboardWindow } from '../dashboard/ops.js';
import { driverFacts, finishFacts, metric, type InsightBuildOptions } from './facts.js';
import { share, topDrivers, type DriverCandidate } from './primitives.js';

export interface ReportsAiCostOptions extends InsightBuildOptions {
  readonly days: number;
}

export interface ReportsCeoFiguresOptions extends InsightBuildOptions {
  /** ISO week identifier, e.g. '2026-W45' or 'w2026-45'. */
  readonly isoWeek: string;
}

/** Parses an ISO week string into UTC start (Mon 00:00Z) and end (next Mon 00:00Z). */
export function parseIsoWeek(iso: string): {
  readonly start: Date;
  readonly end: Date;
  readonly weekNumber: number;
  readonly year: number;
} {
  const match = /^w?(\d{4})(?:-?[wW]|-)?(\d{1,2})$/.exec(iso.trim());
  if (!match) throw new Error(`invalid iso week format: ${iso}`);
  const year = Number(match[1]);
  const weekNumber = Number(match[2]);
  if (weekNumber < 1 || weekNumber > 53)
    throw new Error(`invalid iso week number: ${String(weekNumber)}`);

  // Jan 4th is always in week 1 of ISO-8601
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Mon = new Date(jan4.getTime() - (jan4Day - 1) * 86_400_000);
  const start = new Date(week1Mon.getTime() + (weekNumber - 1) * 7 * 86_400_000);
  const end = new Date(start.getTime() + 7 * 86_400_000);
  return { start, end, weekNumber, year };
}

/**
 * `reports.ai_cost` (mode N, period `days`): total AI spend, token consumption,
 * and top cost drivers grouped by agent and intent.
 */
export async function buildReportsAiCostFacts(
  options: ReportsAiCostOptions,
): Promise<InsightFactsResult> {
  const { executor, days } = options;
  const window = await readDashboardWindow(executor, days);
  const now = window.now;
  const since = window.since;

  const [aiSummary, agentDriversRows, intentDriversRows] = await Promise.all([
    executor
      .select({
        totalRuns: sql<number>`count(*)::int`,
        tokens: sql<number>`coalesce(sum(${schema.aiRun.inputTokens} + ${schema.aiRun.outputTokens}), 0)::int`,
        cost: sql<string | null>`coalesce(sum(${schema.aiRun.costUsd}), 0)::numeric(10, 4)`,
      })
      .from(schema.aiRun)
      .where(sql`${schema.aiRun.createdAt} >= ${since.toISOString()}::timestamptz`),
    executor
      .select({
        agent: schema.aiRun.agent,
        n: sql<number>`count(*)::int`,
      })
      .from(schema.aiRun)
      .where(sql`${schema.aiRun.createdAt} >= ${since.toISOString()}::timestamptz`)
      .groupBy(schema.aiRun.agent)
      .orderBy(desc(sql`count(*)`))
      .limit(3),
    executor
      .select({
        id: schema.intent.id,
        name: schema.intent.name,
        n: sql<number>`count(*)::int`,
      })
      .from(schema.aiRun)
      .innerJoin(schema.intent, eq(schema.intent.key, schema.aiRun.intent))
      .where(
        and(
          sql`${schema.aiRun.createdAt} >= ${since.toISOString()}::timestamptz`,
          isNotNull(schema.aiRun.intent),
        ),
      )
      .groupBy(schema.intent.id, schema.intent.name)
      .orderBy(desc(sql`count(*)`))
      .limit(3),
  ]);

  const totalRuns = aiSummary[0]?.totalRuns ?? 0;
  const tokens = aiSummary[0]?.tokens ?? 0;
  const cost = Number(aiSummary[0]?.cost ?? 0);

  const topAgentRow = agentDriversRows[0];
  const topAgentFact =
    topAgentRow && /^[a-z0-9_]{1,40}$/.test(topAgentRow.agent)
      ? [
          metric('top_agent_runs', topAgentRow.n, {
            th: `Agent ที่รันสูงสุด (${topAgentRow.agent}): ${String(topAgentRow.n)} ครั้ง`,
            en: `Top agent (${topAgentRow.agent}): ${String(topAgentRow.n)} runs`,
          }),
        ]
      : [];

  const intentCandidates: DriverCandidate[] = intentDriversRows.map((r) => ({
    id: r.id,
    name: r.name,
    count: r.n,
  }));
  const topIntentDrivers = topDrivers('intent', intentCandidates);

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
      th: `ต้นทุนรวม $${String(cost)} USD`,
      en: `$${String(cost)} USD total cost`,
    }),
    ...topAgentFact,
    ...driverFacts(
      'cost_intent',
      { th: 'Intent ที่ประมวลผลมากที่สุด', en: 'Top intent driver' },
      topIntentDrivers,
    ),
  ];

  return finishFacts(facts, now, options.view);
}

/**
 * `reports.ceo.figures` (mode F, period `isoWeek`): high-level weekly executive figures:
 * ticket volume, resolutions, AI verification share, and incident counts.
 */
export async function buildReportsCeoFiguresFacts(
  options: ReportsCeoFiguresOptions,
): Promise<InsightFactsResult> {
  const { executor, isoWeek } = options;
  const now = options.now ?? new Date();
  const { start, end, weekNumber, year } = parseIsoWeek(isoWeek);

  const [ticketRows, gradeRows, incidentRows] = await Promise.all([
    executor
      .select({
        created: sql<number>`count(*)::int`,
        resolved: sql<number>`count(*) FILTER (WHERE ${schema.ticket.resolvedAt} >= ${start.toISOString()}::timestamptz AND ${schema.ticket.resolvedAt} < ${end.toISOString()}::timestamptz)::int`,
      })
      .from(schema.ticket)
      .where(
        sql`${schema.ticket.createdAt} >= ${start.toISOString()}::timestamptz AND ${schema.ticket.createdAt} < ${end.toISOString()}::timestamptz`,
      ),
    executor
      .select({
        total: sql<number>`count(*)::int`,
        verified: sql<number>`count(*) FILTER (WHERE ${schema.aiResolutionGrade.resolutionClass} = 'verified')::int`,
      })
      .from(schema.aiResolutionGrade)
      .where(
        and(
          sql`${schema.aiResolutionGrade.gradedAt} >= ${start.toISOString()}::timestamptz AND ${schema.aiResolutionGrade.gradedAt} < ${end.toISOString()}::timestamptz`,
          eq(schema.aiResolutionGrade.mock, false),
        ),
      ),
    executor
      .select({
        total: sql<number>`count(*)::int`,
      })
      .from(schema.incident)
      .where(
        sql`${schema.incident.startedAt} >= ${start.toISOString()}::timestamptz AND ${schema.incident.startedAt} < ${end.toISOString()}::timestamptz`,
      ),
  ]);

  const ticketsCreated = ticketRows[0]?.created ?? 0;
  const ticketsResolved = ticketRows[0]?.resolved ?? 0;
  const gradeTotal = gradeRows[0]?.total ?? 0;
  const gradeVerified = gradeRows[0]?.verified ?? 0;
  const verifiedAiShare = gradeTotal > 0 ? (share(gradeVerified, gradeTotal) ?? 0) : 0;
  const incidentsCount = incidentRows[0]?.total ?? 0;

  const facts: InsightFact[] = [
    metric('week_number', weekNumber, {
      th: `สัปดาห์ที่ ${String(weekNumber)} ของปี ${String(year)}`,
      en: `Week ${String(weekNumber)} of ${String(year)}`,
    }),
    metric('total_tickets', ticketsCreated, {
      th: `Ticket ทั้งหมด ${String(ticketsCreated)} รายการ`,
      en: `${String(ticketsCreated)} total tickets`,
    }),
    metric('resolved_tickets', ticketsResolved, {
      th: `ปิดแล้ว ${String(ticketsResolved)} รายการ`,
      en: `${String(ticketsResolved)} resolved tickets`,
    }),
    metric('verified_ai_share', verifiedAiShare, {
      th: `สัดส่วน AI ตอบถูกต้อง ${String(verifiedAiShare)}%`,
      en: `${String(verifiedAiShare)}% verified AI resolution share`,
    }),
    metric('incidents_count', incidentsCount, {
      th: `Incident ทั้งหมด ${String(incidentsCount)} รายการ`,
      en: `${String(incidentsCount)} incidents occurred`,
    }),
  ];

  return finishFacts(facts, now, options.view);
}
