import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import type { CeoExternalTile, CeoPoint, CeoTile, CeoView } from '@watchtower/shared';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import { forbidden, notFound } from '../auth/http-errors.js';
import type { Principal } from '../auth/principal.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';
import { reportWindow } from './report-window.js';
import { SeedFilter } from './seed-filter.js';

type Config = Pick<ApiConfig, 'CEO_MINUTES_SAVED_PER_AI_TICKET' | 'CEO_STAFF_COST_USD_PER_HOUR'>;
type Figure = CeoView['kpis']['volume'];

const ok = (value: number, previous: number | null, samples: number): Figure => ({
  status: 'ok',
  data: { value, previous, samples } satisfies CeoTile,
});
const missing = (reason: 'no_data' | 'needs_grader'): Figure => ({
  status: 'not_available',
  reason,
});

const count = z.number().int();
const maybe = z.number().nullable();

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

/**
 * The CEO view (PRD 9.2, T-305b): eight KPIs over a window and over the period right before it, and the
 * pluggable tiles. Read only. Rules:
 * - a KPI with nothing behind it is `not_available`, never a zero (N5); the verified-resolution rate waits for
 *   the grader and ignores mock grades, which measure nothing;
 * - no figure counts a ticket of a seed batch (`SeedFilter`, one place);
 * - "AI-assisted" = a resolved ticket with at least one AI draft a person approved or edited and sent; "no touch"
 *   = approved unchanged. It is not "the AI answered alone": that is a stage 3 notion the grader will measure;
 * - the savings formula is an assumption with two settings, returned with the figure so the page prints it.
 */
@Injectable()
export class CeoViewService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(SeedFilter) private readonly seed: SeedFilter,
  ) {}

  /** The clock; a test replaces it. */
  now: () => Date = () => new Date();

  private async one<Row extends z.ZodType>(row: Row, query: SQL): Promise<z.output<Row>> {
    const result = await this.database.db.execute(query);
    const [first] = z.array(row).parse(result.rows);
    if (first === undefined) throw new Error('an aggregate query returned no row');
    return first;
  }

  private async period(from: Date, to: Date, seedOnTicket: SQL): Promise<Period> {
    const a = from.toISOString();
    const b = to.toISOString();
    const inRange = (column: SQL) =>
      sql`${column} >= ${a}::timestamptz AND ${column} < ${b}::timestamptz`;
    const [tickets, csat, handled, grades, cost] = await Promise.all([
      this.one(
        z.object({
          created: count,
          frt_n: count,
          frt_median: maybe,
          ttr_n: count,
          ttr_median: maybe,
          sla_evaluated: count,
          sla_breached: count,
        }),
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
      this.one(
        z.object({ answered: count, average: maybe }),
        sql`SELECT count(*) FILTER (WHERE s.status = 'answered')::int AS answered,
          avg(s.score) FILTER (WHERE s.status = 'answered')::float8 AS average
        FROM csat_survey s JOIN ticket t ON t.id = s.ticket_id
        WHERE ${inRange(sql`s.sent_at`)} AND ${seedOnTicket}`,
      ),
      this.one(
        z.object({ resolved: count, assisted: count, no_touch: count }),
        sql`SELECT count(*)::int AS resolved,
          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ai_draft d WHERE d.ticket_id = t.id
            AND d.disposition IN ('approved', 'edited')))::int AS assisted,
          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ai_draft d WHERE d.ticket_id = t.id AND d.disposition = 'approved')
            AND NOT EXISTS (SELECT 1 FROM ai_draft d WHERE d.ticket_id = t.id AND d.disposition = 'edited'))::int AS no_touch
        FROM ticket t WHERE ${inRange(sql`t.resolved_at`)} AND t.status <> 'merged' AND ${seedOnTicket}`,
      ),
      this.one(
        z.object({ graded: count, verified: count }),
        sql`SELECT count(*)::int AS graded,
          count(*) FILTER (WHERE g.resolution_class = 'verified')::int AS verified
        FROM (
          SELECT DISTINCT ON (ticket_id) ticket_id, resolution_class
          FROM ai_resolution_grade
          WHERE NOT mock AND ${inRange(sql`graded_at`)}
          ORDER BY ticket_id, cycle DESC
        ) g JOIN ticket t ON t.id = g.ticket_id WHERE ${seedOnTicket}`,
      ),
      this.one(
        z.object({ total: z.number() }),
        sql`SELECT coalesce(sum(r.cost_usd), 0)::float8 AS total
        FROM ai_run r LEFT JOIN ticket t ON t.id = r.ticket_id
        WHERE ${inRange(sql`r.created_at`)} AND (r.ticket_id IS NULL OR ${seedOnTicket})`,
      ),
    ]);
    return {
      created: tickets.created,
      frtN: tickets.frt_n,
      frtMedian: tickets.frt_median,
      ttrN: tickets.ttr_n,
      ttrMedian: tickets.ttr_median,
      slaEvaluated: tickets.sla_evaluated,
      slaBreached: tickets.sla_breached,
      csatAnswered: csat.answered,
      csatAverage: csat.average,
      resolved: handled.resolved,
      assisted: handled.assisted,
      noTouch: handled.no_touch,
      graded: grades.graded,
      verified: grades.verified,
      aiCostUsd: cost.total,
    };
  }

  async read(days: number, principal: Principal): Promise<CeoView> {
    if (principal.orgScope.kind !== 'all') throw forbidden();
    const window = reportWindow(this.now(), days);
    const seedOnTicket = await this.seed.exclude('t');
    const [now, before, externalTiles] = await Promise.all([
      this.period(window.from, window.to, seedOnTicket),
      this.period(window.previousFrom, window.from, seedOnTicket),
      this.externalTiles(),
    ]);

    const minutes = this.config.CEO_MINUTES_SAVED_PER_AI_TICKET;
    const hourly = this.config.CEO_STAFF_COST_USD_PER_HOUR ?? null;
    const hoursOf = (period: Period) => (period.assisted * minutes) / 60;
    const hours = hoursOf(now);
    const savedUsd = hourly === null ? null : hours * hourly;
    const perTicket = (period: Period) =>
      period.resolved === 0 ? null : period.aiCostUsd / period.resolved;
    const rate = (part: number, whole: number) => (whole === 0 ? null : ratio(part, whole));

    return {
      generatedAt: window.to.toISOString(),
      window: { from: window.from.toISOString(), to: window.to.toISOString(), days },
      previous: { from: window.previousFrom.toISOString(), to: window.from.toISOString() },
      seedExcluded: await this.seed.active(),
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
                before.slaEvaluated === 0
                  ? null
                  : 1 - ratio(before.slaBreached, before.slaEvaluated),
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

  /** The newest point of each pluggable tile and the one before it. */
  async externalTiles(): Promise<CeoExternalTile[]> {
    const result = await this.database.db.execute(
      sql`SELECT metric_key, label, unit, higher_is_better, value, observed_at, rn FROM (
          SELECT p.*, row_number() OVER (PARTITION BY metric_key ORDER BY observed_at DESC) AS rn
          FROM ceo_external_point p
        ) ranked WHERE rn <= 2 ORDER BY metric_key ASC, rn ASC`,
    );
    const rows = z
      .array(
        z.object({
          metric_key: z.string(),
          label: z.string(),
          unit: z.string(),
          higher_is_better: z.boolean(),
          value: z.number(),
          observed_at: z.coerce.date(),
          rn: z.coerce.number(),
        }),
      )
      .parse(result.rows);
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

  /** Records points (a repeat of a metric and instant replaces the value). Returns how many were written. */
  async recordPoints(
    points: readonly CeoPoint[],
    source: 'api' | 'csv',
    userId: string,
  ): Promise<number> {
    await this.database.db.transaction(async (tx) => {
      for (const point of points) {
        await tx
          .insert(schema.ceoExternalPoint)
          .values({
            metricKey: point.key,
            label: point.label,
            unit: point.unit,
            higherIsBetter: point.higherIsBetter,
            value: point.value,
            observedAt: new Date(point.observedAt),
            source,
            createdBy: userId,
          })
          .onConflictDoUpdate({
            target: [schema.ceoExternalPoint.metricKey, schema.ceoExternalPoint.observedAt],
            set: {
              label: point.label,
              unit: point.unit,
              higherIsBetter: point.higherIsBetter,
              value: point.value,
              source,
              createdBy: userId,
            },
          });
      }
    });
    return points.length;
  }

  async deleteMetric(key: string): Promise<void> {
    const removed = await this.database.db
      .delete(schema.ceoExternalPoint)
      .where(and(eq(schema.ceoExternalPoint.metricKey, key)))
      .returning({ id: schema.ceoExternalPoint.id });
    if (removed.length === 0) throw notFound('No such tile');
  }
}
