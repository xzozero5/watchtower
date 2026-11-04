import type { AiInsightReason } from '@watchtower/shared';

import type { AgentName } from './contract.js';

/**
 * Asked before every model call (N2, N3, PRD section 6.4): the kill switch through the policy gate
 * (`checkAiAction`, T-112) and the daily budget. The composition root builds it from the domain; a
 * guard that throws counts as a refusal. There is no default: nothing reaches a model without one.
 */
export interface GuardRequest {
  readonly agent: AgentName;
  readonly ticketId: string | null;
  /** Free label for the audit row of a denial, for example `classify`. */
  readonly action: string;
  /**
   * The model call itself (`createAuditedLlm`) asks with `reserve`: the guard then counts the call
   * as in flight until `release` runs, so concurrent calls cannot all pass a nearly full budget
   * (T-114a C-6). An agent's early check does not reserve.
   */
  readonly reserve?: boolean;
}

export type GuardDecision =
  | { readonly allowed: true; readonly release?: () => void }
  | { readonly allowed: false; readonly reason: AiInsightReason };

export interface AiCallGuard {
  check(request: GuardRequest): Promise<GuardDecision>;
}

/** The model call was refused by the guard (kill switch, policy or budget); nothing was sent. */
export class AiCallDeniedError extends Error {
  override readonly name = 'AiCallDeniedError';
  readonly reason: AiInsightReason;

  constructor(reason: AiInsightReason) {
    super(`The AI call was refused: ${reason}`);
    this.reason = reason;
  }
}
