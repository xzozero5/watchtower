import { schema, type Database } from '@watchtower/db';
import type { AiInsightReason } from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import { GATE_REASONS } from '../autonomy/decide.js';
import type { PolicyGate } from '../policy.js';
import {
  DEFAULT_EMBEDDING_DAILY_TOKEN_CAP,
  EMBEDDER_AGENT,
  evaluateBudget,
  readEmbeddingTokens,
  type AiCaps,
  type BudgetMonitor,
} from './budget.js';

/** What an agent asks before it calls a model. Same shape as `AiCallGuard` in `@watchtower/ai`. */
export interface AiGuardRequest {
  readonly agent: string;
  readonly ticketId: string | null;
  readonly action: string;
  /** The model call itself: count it as in flight until `release` runs (T-114a C-6). */
  readonly reserve?: boolean;
}

/** Tokens counted for one call in flight. [ASSUMED] a typical ticket call; a cap check, not a bill. */
export const IN_FLIGHT_TOKEN_RESERVE = 4000;

export type AiGuardDecision =
  | { readonly allowed: true; readonly release?: () => void }
  | { readonly allowed: false; readonly reason: AiInsightReason };

export interface AiGuardOptions {
  /** The policy gate (T-112). Absent: every AI call is refused (fail closed). */
  readonly policyGate: PolicyGate | undefined;
  readonly db: Pick<Database['db'], 'select'>;
  readonly budget: BudgetMonitor;
  /**
   * The caps behind `budget`. With them, calls that reserve count `IN_FLIGHT_TOKEN_RESERVE` tokens
   * each while they run, so concurrent calls cannot all pass a nearly full budget. Without them the
   * check is the plain read of the day's usage.
   */
  readonly caps?: AiCaps | undefined;
  /** Clock for the embedding cap's UTC day. Tests pass one. */
  readonly now?: () => Date;
}

/**
 * The check before every model call (N2, N3, PRD section 6.4):
 *  1. the policy gate's `checkAiAction` for the ticket's intent: the kill switch ("stop all AI")
 *     answers `kill_switch_on`, anything else it refuses is `policy_denied`; the gate writes an
 *     audit row for each denial;
 *  2. the daily budget: at the cap the answer is `budget_stop`. An embedding call (agent
 *     `embedder`) is checked against the embedding token cap only, never the LLM budget, and the
 *     LLM budget is not charged for it (T-435 C-1).
 * Any error is a refusal. The caller then does no model call and falls back to rules or a person.
 */
export function createAiGuard(options: AiGuardOptions) {
  // Calls past the check and not yet finished, in this process.
  let inFlight = 0;
  return {
    async check(request: AiGuardRequest): Promise<AiGuardDecision> {
      try {
        const gate = options.policyGate;
        if (gate === undefined) return { allowed: false, reason: 'policy_denied' };

        let intentId: string | null = null;
        if (request.ticketId !== null) {
          const [row] = await options.db
            .select({ intentId: schema.ticket.intentId })
            .from(schema.ticket)
            .where(eq(schema.ticket.id, request.ticketId))
            .limit(1);
          intentId = row?.intentId ?? null;
        }
        const decision = await gate.checkAiAction({
          ticketId: request.ticketId,
          intentId,
          actor: { type: 'ai', id: null },
          action: request.action,
        });
        if (!decision.allowed) {
          return {
            allowed: false,
            reason:
              decision.reason === GATE_REASONS.killSwitchOn ? 'kill_switch_on' : 'policy_denied',
          };
        }

        if (request.agent === EMBEDDER_AGENT) {
          const cap = options.caps?.dailyEmbeddingTokens ?? DEFAULT_EMBEDDING_DAILY_TOKEN_CAP;
          const used = await readEmbeddingTokens(options.db, (options.now ?? (() => new Date()))());
          return used >= cap ? { allowed: false, reason: 'budget_stop' } : { allowed: true };
        }

        const budget = await options.budget.check();
        if (budget.level === 'stop') return { allowed: false, reason: 'budget_stop' };
        if (request.reserve !== true) return { allowed: true };
        if (options.caps !== undefined) {
          const withReserve = evaluateBudget(options.caps, {
            costUsd: budget.usage.costUsd,
            tokens: budget.usage.tokens + (inFlight + 1) * IN_FLIGHT_TOKEN_RESERVE,
          });
          if (withReserve.level === 'stop') return { allowed: false, reason: 'budget_stop' };
        }
        inFlight += 1;
        let released = false;
        return {
          allowed: true,
          release: () => {
            if (released) return;
            released = true;
            inFlight -= 1;
          },
        };
      } catch {
        return { allowed: false, reason: 'policy_denied' };
      }
    },
  };
}
