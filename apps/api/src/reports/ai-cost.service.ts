import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@watchtower/db';
import { formatTicketKey, type AiCost, type AiCostLine } from '@watchtower/shared';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import { forbidden } from '../auth/http-errors.js';
import type { Principal } from '../auth/principal.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';
import { reportWindow, windowDays } from './report-window.js';

const num = z.number();
const line = {
  runs: num.int(),
  input: num,
  output: num,
  cost: num,
  unpriced: num.int(),
};
const toLine = (row: {
  runs: number;
  input: number;
  output: number;
  cost: number;
  unpriced: number;
}): AiCostLine => ({
  runs: row.runs,
  inputTokens: row.input,
  outputTokens: row.output,
  costUsd: row.cost,
  unpricedRuns: row.unpriced,
});
const EMPTY: AiCostLine = { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedRuns: 0 };

/** The aggregates every group has, computed in SQL so a group of a million calls costs one row. */
const AGGREGATES = sql`count(*)::int AS runs,
  coalesce(sum(r.input_tokens), 0)::float8 AS input,
  coalesce(sum(r.output_tokens), 0)::float8 AS output,
  coalesce(sum(r.cost_usd), 0)::float8 AS cost,
  (count(*) FILTER (WHERE r.cost_usd IS NULL))::int AS unpriced`;

/**
 * What the AI cost, from `ai_run` (T-305a): per agent, per intent, per ticket (top N) and per day, against the
 * period right before. Read only. `cost_usd` is null on a call nobody priced (the mock provider, a model with
 * no price): those are counted as `unpricedRuns`, never as zero money without saying so (N5). Today's spend
 * against the caps is the budget card (`GET /v1/ai/budget`, T-142); this is its history.
 */
@Injectable()
export class AiCostService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APP_CONFIG) private readonly config: Pick<ApiConfig, 'TICKET_KEY_PREFIX'>,
  ) {}

  /** The clock; a test replaces it. */
  now: () => Date = () => new Date();

  private async rows<Row extends z.ZodType>(row: Row, query: SQL): Promise<z.output<Row>[]> {
    const result = await this.database.db.execute(query);
    return z.array(row).parse(result.rows);
  }

  async read(days: number, top: number, principal: Principal): Promise<AiCost> {
    if (principal.orgScope.kind !== 'all') throw forbidden();
    const window = reportWindow(this.now(), days);
    const range = (from: Date, to: Date) =>
      sql`r.created_at >= ${from.toISOString()}::timestamptz AND r.created_at < ${to.toISOString()}::timestamptz`;
    const current = range(window.from, window.to);
    const before = range(window.previousFrom, window.from);

    const totals = async (where: SQL) => {
      const [row] = await this.rows(
        z.object({ ...line, tickets: num.int() }),
        sql`SELECT ${AGGREGATES}, (count(DISTINCT r.ticket_id))::int AS tickets FROM ai_run r WHERE ${where}`,
      );
      if (row === undefined) throw new Error('an aggregate query returned no row');
      return { ...toLine(row), tickets: row.tickets };
    };

    const [now, previous, byAgent, byIntent, topTickets, byDay] = await Promise.all([
      totals(current),
      totals(before),
      this.rows(
        z.object({ agent: z.string(), ...line }),
        sql`SELECT r.agent, ${AGGREGATES} FROM ai_run r WHERE ${current}
          GROUP BY r.agent ORDER BY cost DESC, runs DESC, r.agent ASC`,
      ),
      this.rows(
        z.object({ intent: z.string().nullable(), ...line }),
        sql`SELECT r.intent, ${AGGREGATES} FROM ai_run r WHERE ${current}
          GROUP BY r.intent ORDER BY cost DESC, runs DESC, r.intent ASC NULLS LAST`,
      ),
      this.rows(
        z.object({
          ticket_id: z.uuid(),
          number: z.coerce.number().int(),
          org_id: z.uuid(),
          ...line,
        }),
        sql`SELECT r.ticket_id, t.number, t.org_id, ${AGGREGATES}
          FROM ai_run r JOIN ticket t ON t.id = r.ticket_id WHERE ${current}
          GROUP BY r.ticket_id, t.number, t.org_id
          ORDER BY cost DESC, (sum(r.input_tokens) + sum(r.output_tokens)) DESC, t.number DESC
          LIMIT ${top}`,
      ),
      this.rows(
        z.object({ day: z.string(), ...line }),
        sql`SELECT to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, ${AGGREGATES}
          FROM ai_run r WHERE ${current} GROUP BY 1`,
      ),
    ]);

    const listed = byIntent.slice(0, top);
    const rest = byIntent.slice(top);
    const others = rest.length === 0 ? null : rest.map(toLine).reduce(addLines, EMPTY);
    const perDay = new Map(byDay.map((row) => [row.day, toLine(row)]));

    return {
      generatedAt: window.to.toISOString(),
      window: { from: window.from.toISOString(), to: window.to.toISOString(), days },
      previous: { from: window.previousFrom.toISOString(), to: window.from.toISOString() },
      totals: now,
      previousTotals: previous,
      byAgent: byAgent.map((row) => ({ agent: row.agent, ...toLine(row) })),
      byIntent: listed.map((row) => ({ intent: row.intent, ...toLine(row) })),
      byIntentOthers: others,
      topTickets: topTickets.map((row) => ({
        ticketId: row.ticket_id,
        key: formatTicketKey(row.number, this.config.TICKET_KEY_PREFIX),
        number: row.number,
        orgId: row.org_id,
        ...toLine(row),
      })),
      byDay: windowDays(window).map((day) => ({ day, ...(perDay.get(day) ?? EMPTY) })),
    };
  }
}

function addLines(a: AiCostLine, b: AiCostLine): AiCostLine {
  return {
    runs: a.runs + b.runs,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
    unpricedRuns: a.unpricedRuns + b.unpricedRuns,
  };
}
