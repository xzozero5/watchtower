import { schema, type Database } from '@watchtower/db';
import type { AiInsightReason } from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import { GATE_REASONS } from '../autonomy/decide.js';
import type { PolicyGate } from '../policy.js';
import type { BudgetMonitor } from './budget.js';

/** What an agent asks before it calls a model. Same shape as `AiCallGuard` in `@watchtower/ai`. */
export interface AiGuardRequest {
  readonly agent: string;
  readonly ticketId: string | null;
  readonly action: string;
}

export type AiGuardDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: AiInsightReason };

export interface AiGuardOptions {
  /** The policy gate (T-112). Absent: every AI call is refused (fail closed). */
  readonly policyGate: PolicyGate | undefined;
  readonly db: Pick<Database['db'], 'select'>;
  readonly budget: BudgetMonitor;
}

/**
 * The check before every model call (N2, N3, PRD section 6.4):
 *  1. the policy gate's `checkAiAction` for the ticket's intent: the kill switch ("stop all AI")
 *     answers `kill_switch_on`, anything else it refuses is `policy_denied`; the gate writes an
 *     audit row for each denial;
 *  2. the daily budget: at the cap the answer is `budget_stop`.
 * Any error is a refusal. The caller then does no model call and falls back to rules or a person.
 */
export function createAiGuard(options: AiGuardOptions) {
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

        const budget = await options.budget.check();
        if (budget.level === 'stop') return { allowed: false, reason: 'budget_stop' };
        return { allowed: true };
      } catch {
        return { allowed: false, reason: 'policy_denied' };
      }
    },
  };
}
