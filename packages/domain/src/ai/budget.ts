import { schema, type Database } from '@watchtower/db';
import { AUDIT_ACTIONS } from '@watchtower/shared';
import { and, eq, gte, ne, sql } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import type { Actor } from '../types.js';

/**
 * Daily caps on what the app itself spends on AI (PRD section 6.4, `config/budgets.yaml`
 * `app_ai_daily`). Defaults mirror that file; `AI_DAILY_COST_CAP_USD` / `AI_DAILY_TOKEN_CAP`
 * override them and `AI_BUDGET_ALERT_PERCENT` sets the alert level.
 */
export const DEFAULT_AI_DAILY_COST_CAP_USD = 1;
export const DEFAULT_AI_DAILY_TOKEN_CAP = 500_000;
/**
 * Embedding tokens have their own daily cap (T-435, ADR-030). The local embedder is free and sends
 * nothing out, so its tokens must not eat the LLM's `AI_DAILY_TOKEN_CAP`: a full re-embed would
 * otherwise stop triage, drafts and the assistant. `[ASSUMED]` 5 M: a few hundred Thai articles
 * re-embedded once, with room for staff and customer search queries.
 */
export const DEFAULT_EMBEDDING_DAILY_TOKEN_CAP = 5_000_000;
/** The `ai_run.agent` of every embedding call (`@watchtower/ai` audited embedder). */
export const EMBEDDER_AGENT = 'embedder';
export const DEFAULT_AI_BUDGET_ALERT_PERCENT = 80;

export interface AiCaps {
  readonly dailyCostUsd: number;
  /** LLM tokens per UTC day. Embedding tokens are not counted here. */
  readonly dailyTokens: number;
  /** Embedding tokens per UTC day (agent `embedder`), a cap of its own. */
  readonly dailyEmbeddingTokens: number;
  readonly alertPercent: number;
}

export function resolveAiCaps(env: {
  readonly AI_DAILY_COST_CAP_USD?: number | undefined;
  readonly AI_DAILY_TOKEN_CAP?: number | undefined;
  readonly EMBEDDING_DAILY_TOKEN_CAP?: number | undefined;
  readonly AI_BUDGET_ALERT_PERCENT?: number | undefined;
}): AiCaps {
  return {
    dailyCostUsd: env.AI_DAILY_COST_CAP_USD ?? DEFAULT_AI_DAILY_COST_CAP_USD,
    dailyTokens: env.AI_DAILY_TOKEN_CAP ?? DEFAULT_AI_DAILY_TOKEN_CAP,
    dailyEmbeddingTokens: env.EMBEDDING_DAILY_TOKEN_CAP ?? DEFAULT_EMBEDDING_DAILY_TOKEN_CAP,
    alertPercent: env.AI_BUDGET_ALERT_PERCENT ?? DEFAULT_AI_BUDGET_ALERT_PERCENT,
  };
}

export type BudgetDimension = 'cost' | 'tokens';
export type BudgetLevel = 'ok' | 'alert' | 'stop';

export interface AiUsage {
  /** USD of the priced runs of this UTC day. A run whose model has no price counts in tokens only. */
  readonly costUsd: number;
  readonly tokens: number;
}

export interface BudgetFinding {
  readonly dimension: BudgetDimension;
  readonly level: Exclude<BudgetLevel, 'ok'>;
  readonly spent: number;
  readonly cap: number;
}

export interface BudgetStatus {
  readonly level: BudgetLevel;
  readonly usage: AiUsage;
  /** Every dimension at or over its alert level or its cap. */
  readonly findings: readonly BudgetFinding[];
}

/** Pure: where `usage` stands against the caps. `stop` wins over `alert`. */
export function evaluateBudget(caps: AiCaps, usage: AiUsage): BudgetStatus {
  const findings: BudgetFinding[] = [];
  const dimensions: readonly [BudgetDimension, number, number][] = [
    ['cost', usage.costUsd, caps.dailyCostUsd],
    ['tokens', usage.tokens, caps.dailyTokens],
  ];
  for (const [dimension, spent, cap] of dimensions) {
    if (spent >= cap) findings.push({ dimension, level: 'stop', spent, cap });
    else if (spent >= (cap * caps.alertPercent) / 100) {
      findings.push({ dimension, level: 'alert', spent, cap });
    }
  }
  const level: BudgetLevel = findings.some((finding) => finding.level === 'stop')
    ? 'stop'
    : findings.length > 0
      ? 'alert'
      : 'ok';
  return { level, usage, findings };
}

export type BudgetDatabase = Pick<Database['db'], 'select' | 'transaction'>;

/** The start of the UTC day of `now`; the budget day. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * What has been spent today (UTC) on a real provider. The mock provider is free and offline, so
 * its runs do not count against a cap that exists to bound a bill. Embedding runs (agent
 * `embedder`) count in USD but not in tokens: their tokens have their own cap
 * (`readEmbeddingTokens`), so a re-embed cannot stop the LLM (T-435 C-1).
 */
export async function readAiUsage(db: Pick<Database['db'], 'select'>, now: Date): Promise<AiUsage> {
  const { aiRun } = schema;
  const [row] = await db
    .select({
      cost: sql<string>`coalesce(sum(${aiRun.costUsd}), 0)`,
      tokens: sql<string>`coalesce(sum(${aiRun.inputTokens} + ${aiRun.outputTokens}) filter (where ${aiRun.agent} <> ${EMBEDDER_AGENT}), 0)`,
    })
    .from(aiRun)
    .where(and(gte(aiRun.createdAt, utcDayStart(now)), ne(aiRun.provider, 'mock')));
  return { costUsd: Number(row?.cost ?? 0), tokens: Number(row?.tokens ?? 0) };
}

/** Embedding tokens spent today (UTC) by a real (non-mock) embedding provider. */
export async function readEmbeddingTokens(
  db: Pick<Database['db'], 'select'>,
  now: Date,
): Promise<number> {
  const { aiRun } = schema;
  const [row] = await db
    .select({
      tokens: sql<string>`coalesce(sum(${aiRun.inputTokens} + ${aiRun.outputTokens}), 0)`,
    })
    .from(aiRun)
    .where(
      and(
        gte(aiRun.createdAt, utcDayStart(now)),
        ne(aiRun.provider, 'mock'),
        eq(aiRun.agent, EMBEDDER_AGENT),
      ),
    );
  return Number(row?.tokens ?? 0);
}

export interface BudgetEventNotice extends BudgetFinding {
  readonly day: string;
}

export interface BudgetMonitorOptions {
  readonly db: BudgetDatabase;
  readonly caps: AiCaps;
  readonly now?: () => Date;
  /** Called once per UTC day and finding the first time it is seen (the app logs it). */
  readonly onEvent?: (notice: BudgetEventNotice) => void;
}

export interface BudgetMonitor {
  check(): Promise<BudgetStatus>;
}

const SYSTEM_ACTOR: Actor = { type: 'system', id: null };

/**
 * Reads the day's usage and reports the level. The first time a cap reaches its alert level or its
 * limit on a UTC day it also writes an `ai_budget_event` row and an audit row (`ai.budget_alert` /
 * `ai.budget_stop`) in one transaction, and calls `onEvent`; later checks the same day do not repeat
 * it. A concurrent call can overshoot a cap by the cost of the calls already in flight.
 */
export function createBudgetMonitor(options: BudgetMonitorOptions): BudgetMonitor {
  const now = options.now ?? ((): Date => new Date());
  return {
    async check() {
      const at = now();
      const status = evaluateBudget(options.caps, await readAiUsage(options.db, at));
      if (status.findings.length === 0) return status;
      const day = utcDayStart(at).toISOString().slice(0, 10);
      for (const finding of status.findings) {
        const isNew = await options.db.transaction(async (tx) => {
          const inserted = await tx
            .insert(schema.aiBudgetEvent)
            .values({
              day,
              level: finding.level,
              dimension: finding.dimension,
              spent: String(finding.spent),
              cap: String(finding.cap),
            })
            .onConflictDoNothing()
            .returning({ day: schema.aiBudgetEvent.day });
          if (inserted.length === 0) return false;
          await recordAuditInTx(
            tx,
            { actor: SYSTEM_ACTOR, auditMeta: { ip: null, requestId: null } },
            { audited: false },
            {
              action:
                finding.level === 'stop' ? AUDIT_ACTIONS.aiBudgetStop : AUDIT_ACTIONS.aiBudgetAlert,
              outcome: finding.level === 'stop' ? 'denied' : 'success',
              targetType: 'ai_budget',
              targetId: null,
              metadata: {
                day,
                dimension: finding.dimension,
                spent: finding.spent,
                cap: finding.cap,
                alertPercent: options.caps.alertPercent,
              },
            },
          );
          return true;
        });
        if (isNew) options.onEvent?.({ ...finding, day });
      }
      return status;
    },
  };
}
