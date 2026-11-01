import { schema, type Database } from '@watchtower/db';
import { and, count, eq, gt, ne, sql } from 'drizzle-orm';

/**
 * The tool budget and audit in the database (T-108a, N2, SR106-R8). It has the same shape as
 * `ToolLedger` of `@watchtower/ai` (this package may not import it, see `recorder.ts`); a test in
 * `apps/worker` pins that the two fit.
 *
 * Every call, allowed or not, is a row in `tool_execution`. The budget is counted from the rows, so
 * it holds across handles, runs and processes: a caller that builds a new scope gets no new budget.
 * The count and the insert happen under one advisory lock per ticket, so two jobs for the same
 * ticket cannot both pass the last free slot.
 */

export interface ToolLedgerLimits {
  readonly perRun: number;
  readonly perTicketPerHour: number;
  readonly perToolPerMinute: number;
}

export type ToolDenialReason = 'not_allowed' | 'run_budget' | 'ticket_budget' | 'tool_rate';

export interface ToolLedgerEntry {
  readonly runKey: string;
  readonly ticketId: string | null;
  readonly agent: string;
  readonly tool: string;
  readonly intent: string | null;
  readonly stage: number;
  readonly inputHash: string;
  readonly mock: boolean;
}

export interface ToolLedgerFinish {
  readonly status: 'ok' | 'error';
  readonly errorCode: string | null;
  readonly latencyMs: number;
  readonly resultCount: number | null;
}

export type ToolLedgerDecision =
  | { readonly allowed: true; readonly id: string }
  | { readonly allowed: false; readonly reason: ToolDenialReason };

export interface DbToolLedger {
  begin(entry: ToolLedgerEntry): Promise<ToolLedgerDecision>;
  deny(entry: ToolLedgerEntry, reason: ToolDenialReason): Promise<void>;
  finish(id: string, result: ToolLedgerFinish): Promise<void>;
}

export interface DbToolLedgerOptions {
  readonly db: Pick<Database['db'], 'insert' | 'update' | 'select' | 'transaction'>;
  readonly limits: ToolLedgerLimits;
}

const HOUR_SECONDS = 3600;
const MINUTE_SECONDS = 60;

/** Error codes are class names; keep the column to that and nothing a message could carry. */
const safeCode = (code: string | null): string | null =>
  code === null ? null : code.replaceAll(/[^A-Za-z0-9_]/g, '').slice(0, 60) || 'Error';

export function createDbToolLedger(options: DbToolLedgerOptions): DbToolLedger {
  const { db, limits } = options;
  const row = (entry: ToolLedgerEntry) => ({
    ticketId: entry.ticketId,
    runKey: entry.runKey,
    agent: entry.agent,
    tool: entry.tool,
    intent: entry.intent,
    stage: entry.stage,
    inputHash: entry.inputHash,
    mock: entry.mock,
  });

  return {
    async begin(entry) {
      return db.transaction(async (tx): Promise<ToolLedgerDecision> => {
        // One writer per ticket at a time (a tool call with no ticket locks on its run instead).
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${entry.ticketId ?? entry.runKey}, 0))`,
        );
        const counted = ne(schema.toolExecution.status, 'denied');
        const [inRun] = await tx
          .select({ n: count() })
          .from(schema.toolExecution)
          .where(and(eq(schema.toolExecution.runKey, entry.runKey), counted));
        const [forTicket] =
          entry.ticketId === null
            ? [{ n: 0 }]
            : await tx
                .select({ n: count() })
                .from(schema.toolExecution)
                .where(
                  and(
                    eq(schema.toolExecution.ticketId, entry.ticketId),
                    counted,
                    gt(
                      schema.toolExecution.createdAt,
                      sql`now() - make_interval(secs => ${HOUR_SECONDS})`,
                    ),
                  ),
                );
        const [forTool] = await tx
          .select({ n: count() })
          .from(schema.toolExecution)
          .where(
            and(
              eq(schema.toolExecution.tool, entry.tool),
              counted,
              gt(
                schema.toolExecution.createdAt,
                sql`now() - make_interval(secs => ${MINUTE_SECONDS})`,
              ),
            ),
          );
        let reason: ToolDenialReason | undefined;
        if ((inRun?.n ?? 0) >= limits.perRun) reason = 'run_budget';
        else if ((forTicket?.n ?? 0) >= limits.perTicketPerHour) reason = 'ticket_budget';
        else if ((forTool?.n ?? 0) >= limits.perToolPerMinute) reason = 'tool_rate';

        if (reason !== undefined) {
          await tx.insert(schema.toolExecution).values({
            ...row(entry),
            status: 'denied',
            errorCode: reason,
            finishedAt: sql`now()`,
          });
          return { allowed: false, reason };
        }
        const [created] = await tx
          .insert(schema.toolExecution)
          .values({ ...row(entry), status: 'running' })
          .returning({ id: schema.toolExecution.id });
        if (created === undefined) throw new Error('tool_execution insert returned no row');
        return { allowed: true, id: created.id };
      });
    },

    async deny(entry, reason) {
      await db.insert(schema.toolExecution).values({
        ...row(entry),
        status: 'denied',
        errorCode: reason,
        finishedAt: sql`now()`,
      });
    },

    async finish(id, result) {
      await db
        .update(schema.toolExecution)
        .set({
          status: result.status,
          errorCode: safeCode(result.errorCode),
          latencyMs: Math.max(0, Math.trunc(result.latencyMs)),
          resultCount: result.resultCount,
          finishedAt: sql`now()`,
        })
        .where(and(eq(schema.toolExecution.id, id), eq(schema.toolExecution.status, 'running')));
    },
  };
}
