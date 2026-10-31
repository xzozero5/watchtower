import { DomainError } from './errors.js';
import type { Actor, DomainContext } from './types.js';

/** What the gate is asked about: something is about to be created that goes to a customer. */
export interface CustomerSendRequest {
  readonly ticketId: string;
  readonly channel: string;
  /** The intent the ticket is filed under, when it has one: autonomy is per intent (N3). */
  readonly intentId: string | null;
  readonly actor: Actor;
}

export type PolicyDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/**
 * The policy gate (N3, PRD section 6.4). The real implementation is T-112: it reads the autonomy
 * stage of the intent and the gate results from the database. Only the interface lives here.
 */
export interface PolicyGate {
  check(request: CustomerSendRequest): Promise<PolicyDecision>;
}

/**
 * Throws unless the gate exists and allows the send. With no gate configured the answer is no
 * (fail closed): a missing gate must never turn into an AI that answers customers.
 */
export async function requireCustomerSend(
  ctx: Pick<DomainContext, 'policyGate'>,
  request: CustomerSendRequest,
): Promise<void> {
  const gate = ctx.policyGate;
  if (gate === undefined) {
    throw new DomainError('policy_denied', 'No policy gate is configured; refusing to send', {
      reason: 'no_policy_gate',
    });
  }
  const decision = await gate.check(request);
  if (!decision.allowed) {
    throw new DomainError('policy_denied', 'The policy gate refused this send', {
      reason: decision.reason,
    });
  }
}
