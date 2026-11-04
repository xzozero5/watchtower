import { DomainError } from './errors.js';
import type { Actor, DomainContext } from './types.js';

/**
 * What a send is, for the gate (ADR-011, ADR-010 section 5). The origin and the actor must agree;
 * a mismatch is refused.
 * - `human`: a person wrote and sent it.
 * - `ai_approved`: the AI drafted it and a person approved and sent it (`approvedBy`).
 * - `system_template`: an automatic acknowledgment from a safe template; no AI text.
 * - `ai_auto`: the AI sends on its own. Stage 3 only, and only with `AI_AUTOSEND_ENABLED`, a promotion and the
 *   twelve conditions of ADR-025 section 4; the gate loads the facts itself (`autoSend`).
 * - `ai_internal`: not customer-facing at all (classification, summary, investigation, note).
 */
export const SEND_ORIGINS = [
  'human',
  'ai_approved',
  'system_template',
  'ai_auto',
  'ai_internal',
] as const;
export type SendOrigin = (typeof SEND_ORIGINS)[number];

/** Where a request came from, so a denial audit row carries the same source as the request. */
export interface GateAuditMeta {
  readonly ip: string | null;
  readonly requestId: string | null;
}

/** What the gate is asked about: something is about to be created that goes to a customer. */
export interface CustomerSendRequest {
  readonly ticketId: string;
  readonly channel: string;
  /** The intent the ticket is filed under, when it has one: autonomy is per intent (N3). */
  readonly intentId: string | null;
  readonly actor: Actor;
  /** Default: from the actor (user: `human`, ai: `ai_auto`, system: `system_template`). */
  readonly origin?: SendOrigin | undefined;
  /** Key of the template for `system_template`; must be on the safe allow-list. */
  readonly templateKey?: string | null | undefined;
  /** The person who approved an AI draft (`ai_approved`); must be the acting user. */
  readonly approvedBy?: string | null | undefined;
  /** `ai_auto` only: which draft, which grade and which exact text. The gate reads the rest from the tables. */
  readonly autoSend?: AutoSendRequestInfo | undefined;
  readonly auditMeta?: GateAuditMeta | undefined;
}

/** What a caller names for an automatic send; the gate checks every claim against the rows. */
export interface AutoSendRequestInfo {
  readonly aiDraftId: string;
  readonly aiGradeId: string;
  /** The exact text: the composed body (before a message exists) or the stored message body (at claim time). */
  readonly text: string;
  readonly attachmentCount: number;
  readonly hasHtml: boolean;
  /** The delivery being claimed (its own row is not counted against the daily cap or the streak). */
  readonly excludeDeliveryId?: string | undefined;
}

/** An AI action that does not reach a customer: classify, summarize, investigate, write a note. */
export interface AiActionRequest {
  readonly ticketId: string | null;
  readonly intentId: string | null;
  readonly actor: Actor;
  /** Free label for the audit row, for example `classify` or `investigate`. */
  readonly action: string;
  readonly auditMeta?: GateAuditMeta | undefined;
}

/** Every decision says why: `reason` is a stable code (see `GATE_REASONS`), never prose. */
export type PolicyDecision =
  | { readonly allowed: true; readonly reason: string }
  | { readonly allowed: false; readonly reason: string };

/**
 * The policy gate (N3, PRD section 6.4, ADR-011). `createPolicyGate` is the real implementation:
 * it reads the intent's stage and the global switches from the database, decides, and audits every
 * denial. A gate that throws is a refusal (fail closed).
 */
export interface PolicyGate {
  check(request: CustomerSendRequest): Promise<PolicyDecision>;
  checkAiAction(request: AiActionRequest): Promise<PolicyDecision>;
  /**
   * Every condition of ADR-025 section 4 that stands in the way of an automatic send, for the evaluation
   * record (T-304c). `live`: the real decision, nothing waived. `shadow`: asks what would still stand in
   * the way if the intent were promoted (the flag, the cap switch and the stage are taken as given), and
   * is never a permission. Absent on a gate that cannot do it: the caller then records nothing.
   */
  evaluateAutoSend?(request: CustomerSendRequest, mode: 'live' | 'shadow'): Promise<AutoSendEvaluation>;
}

/** The answer of `evaluateAutoSend`. Counts and codes only; never customer text. */
export interface AutoSendEvaluation {
  readonly mode: 'live' | 'shadow';
  readonly decision: PolicyDecision;
  /** Failed conditions, in the order of ADR-025 section 4. Empty = would send. */
  readonly failed: readonly string[];
  /** The stage the system acts on for this intent right now (`min(stage, 2)` while the flag is off). */
  readonly effectiveStage: number;
  readonly intentId: string | null;
  readonly summary: Readonly<Record<string, unknown>>;
}

type GateContext = Pick<DomainContext, 'policyGate'> & Partial<Pick<DomainContext, 'auditMeta'>>;

/**
 * Throws unless the gate exists and allows the send. With no gate configured the answer is no
 * (fail closed): a missing gate must never turn into an AI that answers customers.
 */
export async function requireCustomerSend(
  ctx: GateContext,
  request: CustomerSendRequest,
): Promise<void> {
  const gate = ctx.policyGate;
  if (gate === undefined) {
    throw new DomainError('policy_denied', 'No policy gate is configured; refusing to send', {
      reason: 'no_policy_gate',
    });
  }
  const decision = await gate.check({
    ...request,
    auditMeta: request.auditMeta ?? ctx.auditMeta,
  });
  if (!decision.allowed) {
    throw new DomainError('policy_denied', 'The policy gate refused this send', {
      reason: decision.reason,
    });
  }
}

/** Same for an AI action that stays inside (classification, summary, investigation, note). */
export async function requireAiAction(ctx: GateContext, request: AiActionRequest): Promise<void> {
  const gate = ctx.policyGate;
  if (gate === undefined) {
    throw new DomainError('policy_denied', 'No policy gate is configured; refusing the AI action', {
      reason: 'no_policy_gate',
    });
  }
  const decision = await gate.checkAiAction({
    ...request,
    auditMeta: request.auditMeta ?? ctx.auditMeta,
  });
  if (!decision.allowed) {
    throw new DomainError('policy_denied', 'The policy gate refused this AI action', {
      reason: decision.reason,
    });
  }
}
