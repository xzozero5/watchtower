import type { Database } from '@watchtower/db';
import type { CeoExternalTile, CeoTile, CeoView } from '@watchtower/shared';
import { sql, type SQL } from 'drizzle-orm';

import type { SeedPort } from './seed-filter.js';
import { reportWindow } from './window.js';

type Db = Database['db'];
type Figure = CeoView['kpis']['volume'];

const ok = (value: number, previous: number | null, samples: number): Figure => ({
  status: 'ok',
  data: { value, previous, samples } satisfies CeoTile,
});
const missing = (reason: 'no_data' | 'needs_grader'): Figure => ({
  status: 'not_available',
  reason,
});

type Row = Record<string, unknown>;

/** A column that must be a number (an aggregate cast in SQL); anything else is a bug, not a zero. */
function num(row: Row, column: string): number {
  const value = row[column];
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new Error(`aggregate column ${column} is not a number`);
  }
  return parsed;
}
const maybe = (row: Row, column: string): number | null =>
  row[column] === null ? null : num(row, column);

interface Period {
  readonly created: number;
  readonly frtN: number;
  readonly frtMedian: number | null;
  readonly ttrN: number;
  readonly ttrMedian: number | null;
  readonly slaEvaluated: number;
  readonly slaBreached: number;
  readonly csatAnswered: number;
  readonly csatAverage: number | null;
  readonly resolved: number;
  readonly assisted: number;
  readonly noTouch: number;
  readonly graded: number;
  readonly verified: number;
  readonly aiCostUsd: number;
}

const ratio = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);

async function one(db: Db, query: SQL): Promise<Row> {
  const result = await db.execute(query);
  const [first] = result.rows as Row[];
  if (first === undefined) throw new Error('an aggregate query returned no row');
  return first;
}

async function period(db: Db, from: Date, to: Date, seedOnTicket: SQL): Promise<Period> {
  const a = from.toISOString();
  const b = to.toISOString();
  const inRange = (column: SQL) =>
    sql`${column} >= ${a}::timestamptz AND ${column} < ${b}::timestamptz`;
  const [tickets, csat, handled, grades, cost] = await Promise.all([
    one(
      db,
      sql`SELECT count(*)::int AS created,
          count(*) FILTER (WHERE t.status <> 'merged' AND t.first_responded_at IS NOT NULL)::int AS frt_n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM t.first_responded_at - t.created_at)::float8)
            FILTER (WHERE t.status <> 'merged' AND t.first_responded_at IS NOT NULL) AS frt_median,
          count(*) FILTER (WHERE t.status <> 'merged' AND t.resolved_at IS NOT NULL)::int AS ttr_n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM t.resolved_at - t.created_at)::float8)
            FILTER (WHERE t.status <> 'merged' AND t.resolved_at IS NOT NULL) AS ttr_median,
          count(*) FILTER (WHERE t.status <> 'merged' AND (
            (t.first_response_due_at IS NOT NULL AND (t.first_responded_at IS NOT NULL
              OR (t.first_response_due_at < now() AND t.sla_paused_at IS NULL)))
            OR (t.resolution_due_at IS NOT NULL AND (t.resolved_at IS NOT NULL
              OR (t.resolution_due_at < now() AND t.sla_paused_at IS NULL)))))::int AS sla_evaluated,
          count(*) FILTER (WHERE t.status <> 'merged' AND (
            (t.first_response_due_at IS NOT NULL AND (
              (t.first_responded_at IS NOT NULL AND t.first_responded_at > t.first_response_due_at)
              OR (t.first_responded_at IS NULL AND t.first_response_due_at < now() AND t.sla_paused_at IS NULL)))
            OR (t.resolution_due_at IS NOT NULL AND (
              (t.resolved_at IS NOT NULL AND t.resolved_at > t.resolution_due_at)
              OR (t.resolved_at IS NULL AND t.resolution_due_at < now() AND t.sla_paused_at IS NULL)))))::int AS sla_breached
        FROM ticket t WHERE ${inRange(sql`t.created_at`)} AND ${seedOnTicket}`,
    ),
    one(
      db,
      sql`SELECT count(*) FILTER (WHERE s.status = 'answered')::int AS answered,
          avg(s.score) FILTER (WHERE s.status = 'answered')::float8 AS average
        FROM csat_survey s JOIN ticket t ON t.id = s.ticket_id
        WHERE ${inRange(sql`s.sent_at`)} AND ${seedOnTicket}`,
    ),
    one(
      db,
      sql`SELECT count(*)::int AS resolved,
          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ai_draft d WHERE d.ticket_id = t.id
            AND d.disposition IN ('approved', 'edited')))::int AS assisted,
          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ai_draft d WHERE d.ticket_id = t.id AND d.disposition = 'approved')
            AND NOT EXISTS (SELECT 1 FROM ai_draft d WHERE d.ticket_id = t.id AND d.disposition = 'edited'))::int AS no_touch
        FROM ticket t WHERE ${inRange(sql`t.resolved_at`)} AND t.status <> 'merged' AND ${seedOnTicket}`,
    ),
    one(
      db,
      sql`SELECT count(*)::int AS graded,
          count(*) FILTER (WHERE g.resolution_class = 'verified')::int AS verified
        FROM (
          SELECT DISTINCT ON (ticket_id) ticket_id, resolution_class
          FROM ai_resolution_grade
          WHERE NOT mock AND ${inRange(sql`graded_at`)}
          ORDER BY ticket_id, cycle DESC
        ) g JOIN ticket t ON t.id = g.ticket_id WHERE ${seedOnTicket}`,
    ),
    one(
      db,
      sql`SELECT coalesce(sum(r.cost_usd), 0)::float8 AS total
        FROM ai_run r LEFT JOIN ticket t ON t.id = r.ticket_id
        WHERE ${inRange(sql`r.created_at`)} AND (r.ticket_id IS NULL OR ${seedOnTicket})`,
    ),
  ]);
  return {
    created: num(tickets, 'created'),
    frtN: num(tickets, 'frt_n'),
    frtMedian: maybe(tickets, 'frt_median'),
    ttrN: num(tickets, 'ttr_n'),
    ttrMedian: maybe(tickets, 'ttr_median'),
    slaEvaluated: num(tickets, 'sla_evaluated'),
    slaBreached: num(tickets, 'sla_breached'),
    csatAnswered: num(csat, 'answered'),
    csatAverage: maybe(csat, 'average'),
    resolved: num(handled, 'resolved'),
    assisted: num(handled, 'assisted'),
    noTouch: num(handled, 'no_touch'),
    graded: num(grades, 'graded'),
    verified: num(grades, 'verified'),
    aiCostUsd: num(cost, 'total'),
  };
}

/** The newest point of each pluggable tile and the one before it. */
export async function readCeoExternalTiles(db: Db): Promise<CeoExternalTile[]> {
  const result = await db.execute(
    sql`SELECT metric_key, label, unit, higher_is_better, value, observed_at, rn FROM (
          SELECT p.*, row_number() OVER (PARTITION BY metric_key ORDER BY observed_at DESC) AS rn
          FROM ceo_external_point p
        ) ranked WHERE rn <= 2 ORDER BY metric_key ASC, rn ASC`,
  );
  const rows = (result.rows as Row[]).map((row) => ({
    metric_key: String(row.metric_key),
    label: String(row.label),
    unit: String(row.unit),
    higher_is_better: row.higher_is_better === true,
    value: num(row, 'value'),
    observed_at: new Date(row.observed_at as string | Date),
    rn: num(row, 'rn'),
  }));
  const tiles: CeoExternalTile[] = [];
  for (const row of rows) {
    if (row.rn === 1) {
      tiles.push({
        key: row.metric_key,
        label: row.label,
        unit: row.unit,
        higherIsBetter: row.higher_is_better,
        value: row.value,
        previous: null,
        observedAt: row.observed_at.toISOString(),
      });
    } else {
      const tile = tiles[tiles.length - 1];
      if (tile !== undefined && tile.key === row.metric_key)
        tiles[tiles.length - 1] = { ...tile, previous: row.value };
    }
  }
  return tiles;
}

export interface CeoViewOptions {
  readonly now: Date;
  readonly days: number;
  /** `[ASSUMED]` minutes a person would have spent on one AI-assisted ticket (`CEO_MINUTES_SAVED_PER_AI_TICKET`). */
  readonly minutesPerTicket: number;
  /** Hourly staff cost; null while the instance has not set one. */
  readonly staffCostUsdPerHour: number | null;
  readonly seed: SeedPort;
}

/**
 * The CEO view (PRD 9.2, T-305b): eight KPIs over a window and over the period right before it, and the
 * pluggable tiles. Read only. It lives here so the api (the page) and the worker (the weekly brief, T-305c)
 * read the same numbers by the same code. Rules:
 * - a KPI with nothing behind it is `not_available`, never a zero (N5); the verified-resolution rate waits for
 *   the grader and ignores mock grades, which measure nothing;
 * - no figure counts a ticket of a seed batch (`SeedPort`, one place);
 * - "AI-assisted" = a resolved ticket with at least one AI draft a person approved or edited and sent; "no touch"
 *   = approved unchanged. It is not "the AI answered alone": that is a stage 3 notion the grader will measure;
 * - the savings formula is an assumption with two settings, returned with the figure so the page prints it.
 */
export async function readCeoView(db: Db, options: CeoViewOptions): Promise<CeoView> {
  const window = reportWindow(options.now, options.days);
  const seedOnTicket = await options.seed.exclude('t');
  const [now, before, externalTiles] = await Promise.all([
    period(db, window.from, window.to, seedOnTicket),
    period(db, window.previousFrom, window.from, seedOnTicket),
    readCeoExternalTiles(db),
  ]);

  const minutes = options.minutesPerTicket;
  const hourly = options.staffCostUsdPerHour;
  const hoursOf = (value: Period) => (value.assisted * minutes) / 60;
  const hours = hoursOf(now);
  const savedUsd = hourly === null ? null : hours * hourly;
  const perTicket = (value: Period) =>
    value.resolved === 0 ? null : value.aiCostUsd / value.resolved;
  const rate = (part: number, whole: number) => (whole === 0 ? null : ratio(part, whole));

  return {
    generatedAt: window.to.toISOString(),
    window: { from: window.from.toISOString(), to: window.to.toISOString(), days: options.days },
    previous: { from: window.previousFrom.toISOString(), to: window.from.toISOString() },
    seedExcluded: await options.seed.active(),
    kpis: {
      volume: ok(now.created, before.created, now.created),
      firstResponse:
        now.frtN === 0 || now.frtMedian === null
          ? missing('no_data')
          : ok(now.frtMedian, before.frtN === 0 ? null : before.frtMedian, now.frtN),
      resolution:
        now.ttrN === 0 || now.ttrMedian === null
          ? missing('no_data')
          : ok(now.ttrMedian, before.ttrN === 0 ? null : before.ttrMedian, now.ttrN),
      sla:
        now.slaEvaluated === 0
          ? missing('no_data')
          : ok(
              1 - ratio(now.slaBreached, now.slaEvaluated),
              before.slaEvaluated === 0 ? null : 1 - ratio(before.slaBreached, before.slaEvaluated),
              now.slaEvaluated,
            ),
      csat:
        now.csatAnswered === 0 || now.csatAverage === null
          ? missing('no_data')
          : ok(
              now.csatAverage,
              before.csatAnswered === 0 ? null : before.csatAverage,
              now.csatAnswered,
            ),
      aiHandled:
        now.resolved === 0
          ? missing('no_data')
          : ok(
              ratio(now.assisted, now.resolved),
              rate(before.assisted, before.resolved),
              now.resolved,
            ),
      verifiedResolution:
        now.graded === 0
          ? missing('needs_grader')
          : ok(ratio(now.verified, now.graded), rate(before.verified, before.graded), now.graded),
      automationSavings:
        now.resolved === 0
          ? missing('no_data')
          : ok(hours, before.resolved === 0 ? null : hoursOf(before), now.assisted),
    },
    formula: {
      assumed: true,
      minutesPerTicket: minutes,
      staffCostUsdPerHour: hourly,
      aiHandledTickets: now.assisted,
      noTouchTickets: now.noTouch,
      hours,
      savedUsd,
      aiCostUsd: now.aiCostUsd,
      netUsd: savedUsd === null ? null : savedUsd - now.aiCostUsd,
      aiCostPerResolvedTicketUsd: perTicket(now),
      previousAiCostPerResolvedTicketUsd: perTicket(before),
    },
    externalTiles,
  };
}
