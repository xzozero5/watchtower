import { PHASE_MAX_AUTONOMY_STAGE, type AuditActorType } from '@watchtower/shared';

import type { PolicyDecision, SendOrigin } from '../policy.js';

/**
 * The pure decision of the policy gate (ADR-011): no database, no clock. It takes who acts, what
 * kind of message it is, the stage of the intent and the two switches, and answers allow or deny
 * with a reason code. `createPolicyGate` loads the state and calls this; the tests walk the whole
 * truth table through it.
 *
 * Phase 1 in one sentence: nothing an AI wrote reaches a customer unless a person approved and sent
 * it, and automatic acknowledgments are limited to templates on the safe list.
 */

/** Reason codes. Stable strings: the UI maps them to copy, the audit log stores them. */
export const GATE_REASONS = {
  // allowed
  humanStaff: 'human_staff',
  aiDraftHumanApproved: 'ai_draft_human_approved',
  safeTemplateAutoAck: 'safe_template_auto_ack',
  aiInternalAllowed: 'ai_internal_allowed',
  // denied
  noPolicyGate: 'no_policy_gate',
  actorOriginMismatch: 'actor_origin_mismatch',
  approvalMissing: 'approval_missing',
  intentUnknown: 'intent_unknown',
  intentNotFound: 'intent_not_found',
  invalidStage: 'invalid_stage',
  stageZeroNoCustomerDraft: 'stage_0_no_customer_draft',
  templateMissing: 'template_missing',
  templateNotAllowlisted: 'template_not_allowlisted',
  aiAutoSendDisabledPhase1: 'ai_auto_send_disabled_phase1',
  killSwitchOn: 'kill_switch_on',
} as const;
export type GateReason = (typeof GATE_REASONS)[keyof typeof GATE_REASONS];

/** What the gate knows about the intent a request names. */
export type IntentStanding =
  | { readonly kind: 'none' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'found'; readonly stage: number };

export interface SwitchState {
  /** "Limit all intents to Stage 2 or lower" (po 23): caps and pins; never raises a stage. */
  readonly stageCapPinned: boolean;
  /** "Stop all AI runs" (po 23, PRD section 6.6). */
  readonly killSwitch: boolean;
}

export interface DecisionInput {
  readonly origin: SendOrigin;
  readonly actorType: AuditActorType;
  readonly actorId: string | null;
  readonly templateKey: string | null;
  readonly approvedBy: string | null;
  readonly intent: IntentStanding;
  readonly switches: SwitchState;
}

/** The actor type each origin requires. */
export const ORIGIN_ACTOR: Readonly<Record<SendOrigin, AuditActorType>> = {
  human: 'user',
  ai_approved: 'user',
  system_template: 'system',
  ai_auto: 'ai',
  ai_internal: 'ai',
};

const allow = (reason: GateReason): PolicyDecision => ({ allowed: true, reason });
const deny = (reason: GateReason): PolicyDecision => ({ allowed: false, reason });

/**
 * The stage the system acts on: `min(stage, ceiling)`. Phase 1 never acts on more than 2, so a
 * stored value above it (the CHECK should make that impossible) cannot widen anything. The cap
 * switch ("limit all intents to stage 2 or lower") applies this same `min`; while the ceiling is 2
 * it changes nothing here, and it is what keeps working after a later phase lifts the ceiling.
 */
export function effectiveStage(stage: number): number {
  return Math.min(stage, PHASE_MAX_AUTONOMY_STAGE);
}

const isStage = (stage: number): boolean => Number.isInteger(stage) && stage >= 0 && stage <= 4;

export function decide(input: DecisionInput, safeTemplates: ReadonlySet<string>): PolicyDecision {
  if (ORIGIN_ACTOR[input.origin] !== input.actorType) return deny(GATE_REASONS.actorOriginMismatch);
  // A person's own message and a safe template do not depend on the stage; the AI paths do, and a
  // stored value outside 0-4 (the CHECK should make that impossible) is never trusted.
  const stageInvalid = input.intent.kind === 'found' && !isStage(input.intent.stage);

  switch (input.origin) {
    case 'human':
      // A person's own message: the stage and the switches are about the AI, not about staff.
      return allow(GATE_REASONS.humanStaff);

    case 'ai_approved': {
      // The draft is the AI's, the decision to send it is a person's. That person is the actor.
      if (
        input.approvedBy === null ||
        input.approvedBy === '' ||
        input.approvedBy !== input.actorId
      ) {
        return deny(GATE_REASONS.approvalMissing);
      }
      if (input.intent.kind === 'none') return deny(GATE_REASONS.intentUnknown);
      if (input.intent.kind === 'missing') return deny(GATE_REASONS.intentNotFound);
      if (stageInvalid) return deny(GATE_REASONS.invalidStage);
      // Stage 0 (Observe) produces no customer-facing draft at all (PRD section 6.4).
      if (effectiveStage(input.intent.stage) < 1) {
        return deny(GATE_REASONS.stageZeroNoCustomerDraft);
      }
      return allow(GATE_REASONS.aiDraftHumanApproved);
    }

    case 'system_template': {
      // Auto-ack is allowed at every stage, but only a template on the safe list, and no AI text.
      // [ASSUMED] the kill switch does not stop it (po 23: "auto-ack templates continue").
      if (input.templateKey === null || input.templateKey === '') {
        return deny(GATE_REASONS.templateMissing);
      }
      if (!safeTemplates.has(input.templateKey)) return deny(GATE_REASONS.templateNotAllowlisted);
      return allow(GATE_REASONS.safeTemplateAutoAck);
    }

    case 'ai_auto':
      // Stage 3 is the owner's decision (N3) and Phase 1 has a CHECK at 2. No input allows it.
      return deny(GATE_REASONS.aiAutoSendDisabledPhase1);

    case 'ai_internal': {
      if (input.switches.killSwitch) return deny(GATE_REASONS.killSwitchOn);
      // An unclassified ticket has no intent yet: classification is how it gets one.
      if (input.intent.kind === 'missing') return deny(GATE_REASONS.intentNotFound);
      if (stageInvalid) return deny(GATE_REASONS.invalidStage);
      return allow(GATE_REASONS.aiInternalAllowed);
    }
  }
}
