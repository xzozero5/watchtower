import { createHmac } from 'node:crypto';

import type { AutonomyStage, ScopedTools, ToolCallRecord, ToolSummary } from '../contract.js';
import { canonicalJson } from '../hash.js';
import { ToolBudgetError, ToolNotAllowedError } from '../tools.js';

/**
 * The budget of the tools lives outside any run's handle (SR106-R8, N2): every call, allowed or
 * not, goes through a `ToolLedger`, which counts what a run, a ticket and a tool have used. The
 * database implementation (`tool_execution`) is in `packages/domain`; `createMemoryToolLedger` is
 * the same rules over an array, for tests and for a dev run with no database.
 */

export const DENIAL_REASONS = ['not_allowed', 'run_budget', 'ticket_budget', 'tool_rate'] as const;
export type DenialReason = (typeof DENIAL_REASONS)[number];

export interface ToolBudgetLimits {
  readonly perRun: number;
  readonly perTicketPerHour: number;
  readonly perToolPerMinute: number;
}

export interface LedgerEntry {
  readonly runKey: string;
  readonly ticketId: string | null;
  readonly agent: string;
  readonly tool: string;
  readonly intent: string | null;
  readonly stage: AutonomyStage;
  /** HMAC of the canonical input (never the input). */
  readonly inputHash: string;
  readonly mock: boolean;
}

export interface LedgerFinish {
  readonly status: 'ok' | 'error';
  readonly errorCode: string | null;
  readonly latencyMs: number;
  readonly resultCount: number | null;
}

export type LedgerDecision =
  { readonly allowed: true; readonly id: string } | { readonly allowed: false; readonly reason: DenialReason };

export interface ToolLedger {
  /** Counts the call against the budgets and records it as running, or records a denial. */
  begin(entry: LedgerEntry): Promise<LedgerDecision>;
  /** Records a call the allow-list refused (it is kept as evidence, not counted). */
  deny(entry: LedgerEntry, reason: DenialReason): Promise<void>;
  finish(id: string, result: LedgerFinish): Promise<void>;
}

export interface BudgetedToolsOptions {
  readonly scoped: ScopedTools;
  readonly ledger: ToolLedger;
  /** One id per investigation or draft run. */
  readonly runKey: string;
  readonly ticketId: string | null;
  readonly agent: string;
  readonly intent: string | null;
  readonly stage: AutonomyStage;
  /** Secret that keys the input hash (`AiSettings.inputHashKey`). */
  readonly hashKey: string;
}

export interface BudgetedTools {
  list(): ToolSummary[];
  call(name: string, input: unknown): Promise<unknown>;
  calls(): readonly ToolCallRecord[];
}

/** Items in a tool answer, for the ledger's count. Content is never stored. */
export function countResult(output: unknown): number | null {
  if (typeof output !== 'object' || output === null) return null;
  const items = (output as { items?: unknown }).items;
  return Array.isArray(items) ? items.length : null;
}

/**
 * Wraps a scoped handle so that every call is counted by the ledger first. A call the allow-list
 * refuses is recorded as `denied` and throws `ToolNotAllowedError`; a call over a budget is
 * recorded as `denied` and throws `ToolBudgetError`. The model never learns more than the error's
 * class.
 */
export function withToolBudget(options: BudgetedToolsOptions): BudgetedTools {
  const { scoped, ledger } = options;
  return {
    list: () => scoped.list(),
    calls: () => scoped.calls(),
    async call(name, input) {
      const summary = scoped.list().find((tool) => tool.name === name);
      const entry: LedgerEntry = {
        runKey: options.runKey,
        ticketId: options.ticketId,
        agent: options.agent,
        tool: name,
        intent: options.intent,
        stage: options.stage,
        inputHash: createHmac('sha256', options.hashKey)
          .update(canonicalJson(input), 'utf8')
          .digest('hex'),
        mock: summary?.mock ?? false,
      };
      if (summary === undefined) {
        await ledger.deny(entry, 'not_allowed');
        // The handle records the refusal in `calls()` and throws the typed error.
        return scoped.call(name, input).catch((error: unknown) => {
          throw error instanceof ToolNotAllowedError
            ? error
            : new ToolNotAllowedError(`Tool not allowed here: ${name}`);
        });
      }
      const decision = await ledger.begin(entry);
      if (!decision.allowed) {
        throw new ToolBudgetError(`Tool budget used (${decision.reason})`);
      }
      const started = Date.now();
      try {
        const output = await scoped.call(name, input);
        await ledger.finish(decision.id, {
          status: 'ok',
          errorCode: null,
          latencyMs: Date.now() - started,
          resultCount: countResult(output),
        });
        return output;
      } catch (error) {
        await ledger.finish(decision.id, {
          status: 'error',
          errorCode: error instanceof Error ? error.name : 'UnknownError',
          latencyMs: Date.now() - started,
          resultCount: null,
        });
        throw error;
      }
    },
  };
}

interface MemoryRow {
  readonly id: string;
  readonly at: number;
  readonly entry: LedgerEntry;
  status: 'running' | 'ok' | 'error' | 'denied';
  reason?: DenialReason;
}

/** The ledger rules over an array. `rows()` shows what was recorded. */
export function createMemoryToolLedger(
  limits: ToolBudgetLimits,
  now: () => number = Date.now,
): ToolLedger & { rows(): readonly MemoryRow[] } {
  const rows: MemoryRow[] = [];
  let next = 0;
  const counted = (row: MemoryRow): boolean => row.status !== 'denied';
  return {
    rows: () => rows,
    begin(entry) {
      const at = now();
      const inRun = rows.filter((row) => counted(row) && row.entry.runKey === entry.runKey).length;
      const forTicket =
        entry.ticketId === null
          ? 0
          : rows.filter(
              (row) =>
                counted(row) && row.entry.ticketId === entry.ticketId && at - row.at < 3_600_000,
            ).length;
      const forTool = rows.filter(
        (row) => counted(row) && row.entry.tool === entry.tool && at - row.at < 60_000,
      ).length;
      let reason: DenialReason | undefined;
      if (inRun >= limits.perRun) reason = 'run_budget';
      else if (forTicket >= limits.perTicketPerHour) reason = 'ticket_budget';
      else if (forTool >= limits.perToolPerMinute) reason = 'tool_rate';
      next += 1;
      const id = `mem-${String(next)}`;
      if (reason !== undefined) {
        rows.push({ id, at, entry, status: 'denied', reason });
        return Promise.resolve({ allowed: false, reason });
      }
      rows.push({ id, at, entry, status: 'running' });
      return Promise.resolve({ allowed: true, id });
    },
    deny(entry, reason) {
      next += 1;
      rows.push({ id: `mem-${String(next)}`, at: now(), entry, status: 'denied', reason });
      return Promise.resolve();
    },
    finish(id, result) {
      const row = rows.find((candidate) => candidate.id === id);
      if (row !== undefined) row.status = result.status;
      return Promise.resolve();
    },
  };
}
