import {
  MANUAL_MAX_AUTONOMY_STAGE,
  PHASE_MAX_AUTONOMY_STAGE,
  type AuditActorType,
} from '@watchtower/shared';

import type { PolicyDecision, SendOrigin } from '../policy.js';

/**
 * The pure decision of the policy gate (ADR-011, ADR-025): no database, no clock. It takes who acts, what
 * kind of message it is, the stage of the intent, the two switches and (for `ai_auto`) the facts the loader
 * read, and answers allow or deny with a reason code. `createPolicyGate` loads the state and calls this; the
 * tests walk the whole truth table through it.
 *
 * In one sentence: nothing an AI wrote reaches a customer unless a person approved and sent it, automatic
 * acknowledgments are limited to templates on the safe list, and `ai_auto` needs all twelve conditions of
 * ADR-025 section 4, the first of which is the environment flag `AI_AUTOSEND_ENABLED`.
 */

/** Reason codes. Stable strings: the UI maps them to copy, the audit log stores them. */
export const GATE_REASONS = {
  // allowed
  humanStaff: 'human_staff',
  aiDraftHumanApproved: 'ai_draft_human_approved',
  safeTemplateAutoAck: 'safe_template_auto_ack',
  aiInternalAllowed: 'ai_internal_allowed',
  aiAutoSendAllowed: 'ai_auto_send_allowed',
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
  /**
   * Legacy name, kept stable: `ai_auto` asked without any auto-send facts. Every caller that does not load
   * the facts (and every instance before stage 3) gets this: there is no path to `ai_auto` without them.
   */
  aiAutoSendDisabledPhase1: 'ai_auto_send_disabled_phase1',
  killSwitchOn: 'kill_switch_on',
  // ai_auto, in the order of ADR-025 section 4 (T-304c)
  /** 1. `AI_AUTOSEND_ENABLED` is not `true` in this process. */
  autosendFlagOff: 'autosend_flag_off',
  /** 4. "Limit all intents to stage 2" is on. */
  stageCapOn: 'stage_cap_on',
  /** 5. The intent, after `effectiveStage`, is below stage 3. */
  stageBelow3: 'stage_below_3',
  /** 6. Grade facts. */
  gradeMissing: 'grade_missing',
  gradeHashMismatch: 'grade_hash_mismatch',
  gradeStale: 'grade_stale',
  gradeFailed: 'grade_failed',
  gradeViolations: 'grade_violations',
  gradeScoreLow: 'grade_score_low',
  gradeMock: 'grade_mock',
  /** 7. The grader's model is the drafter's model. */
  graderNotIndependent: 'grader_not_independent',
  /** 7b. T-306e C-11: the drafter's or the grader's `ai_run` row is missing, so the models cannot be vouched for. */
  aiRunMissing: 'ai_run_missing',
  /** 8. Who the customer is. */
  disclosureUnknown: 'disclosure_unknown',
  contactUnverified: 'contact_unverified',
  senderUnauthenticated: 'sender_unauthenticated',
  /** 9. The allow-list of the intent. */
  policyInvalid: 'policy_invalid',
  channelNotAllowed: 'channel_not_allowed',
  noCustomerKbCitation: 'no_customer_kb_citation',
  uncitedClaims: 'uncited_claims',
  linkNotAllowed: 'link_not_allowed',
  hasAttachment: 'has_attachment',
  hasPlaceholder: 'has_placeholder',
  tooLong: 'too_long',
  /** 10. The ticket. */
  ticketFactsMissing: 'ticket_facts_missing',
  priorityBlocked: 'priority_blocked',
  incidentOpen: 'incident_open',
  customerWantsHuman: 'customer_wants_human',
  autoStreakLimit: 'auto_streak_limit',
  reopenedAfterAuto: 'reopened_after_auto',
  /** 11. The procedure. */
  procedureUnknown: 'procedure_unknown',
  procedureNotAutosend: 'procedure_not_autosend',
  procedureStale: 'procedure_stale',
  /** 11b. T-306e C-1: a `require_human` step matched, or an escalation card is still waiting for a person. */
  procedureRequiresHuman: 'procedure_requires_human',
  escalationPending: 'escalation_pending',
  /** 11c. T-306e C-4: no passing replay of the current drafter, grader, prompts and procedure (suspends, no rollback). */
  replayMissing: 'replay_missing',
  /** 12. Budgets. */
  budgetUnknown: 'budget_unknown',
  dailyCapReached: 'daily_cap_reached',
  aiBudgetExceeded: 'ai_budget_exceeded',
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

// --- the facts of an automatic send (ADR-025 section 4) ---
// Every group is `null` when it could not be loaded: an unknown fact is a denial, never a pass.

/** Condition 6 and 7: the pre-send grade of the exact text that would go out. */
export interface AutoSendGradeFacts {
  /** The grade's hash is the hash of the message body that is about to be sent. */
  readonly hashMatches: boolean;
  /** Seconds since the grade was made, by the database clock. */
  readonly ageSeconds: number;
  readonly passed: boolean;
  readonly violationCount: number;
  readonly score: number;
  readonly minScore: number;
  readonly mock: boolean;
  /** Grader model id differs from the drafter's (owner decision 2). */
  readonly independent: boolean;
  /** T-306e C-11: both the drafter's and the grader's `ai_run` rows exist (so the model ids are the ones that ran). */
  readonly runsKnown: boolean;
}

/** Condition 8: who is asking (`disclosureFor()` and the sender authentication of every inbound email). */
export interface AutoSendDisclosureFacts {
  readonly contactVerified: boolean;
  /** Email tickets: every inbound message was authenticated (`pass`). `null`: not an email ticket. */
  readonly senderAuthenticated: boolean | null;
}

/** Condition 9: the allow-list of the intent applied to the text that would go out. */
export interface AutoSendContentFacts {
  readonly channel: string;
  /** `null` when the stored policy does not parse. */
  readonly allowedChannels: readonly string[] | null;
  readonly customerKbCitations: number;
  readonly uncitedClaims: number;
  /** Every link in the text is a portal or knowledge base address of this instance (no links is fine). */
  readonly linksAllowed: boolean;
  readonly attachments: number;
  readonly placeholders: number;
  readonly length: number;
  readonly maxChars: number;
}

/** Condition 10. */
export interface AutoSendTicketFacts {
  readonly priority: string;
  readonly openIncident: boolean;
  readonly customerWantsHuman: boolean;
  /** Automatic replies already sent (or scheduled) on this ticket. */
  readonly autoStreak: number;
  readonly reopenedAfterAuto: boolean;
}

/** Condition 11. */
export interface AutoSendProcedureFacts {
  /** The published procedure of the intent says `autosend: 'allowed'`. */
  readonly autosendAllowed: boolean;
  /** The draft is from a version that is no longer the published one. */
  readonly stale: boolean;
  /** T-306e C-1: a `require_human` step of the procedure matched this ticket (`ticketRequiresHuman`). */
  readonly requiresHuman: boolean;
  /** T-306e C-1: an escalation card (`procedure.escalation_proposed`) is neither applied nor expired. */
  readonly escalationPending: boolean;
  /**
   * T-306e C-4: a replay (eval or simulation) that passed exists for the current set of drafter model, grader
   * model, drafter prompt version, grader prompt version and procedure version of the intent.
   */
  readonly replayPassed: boolean;
}

/** Condition 12. */
export interface AutoSendBudgetFacts {
  /** Automatic sends of this intent in the last 24 hours, not counting this one. */
  readonly autoSentToday: number;
  readonly dailyCap: number;
  readonly aiBudgetExceeded: boolean;
}

export interface AutoSendFacts {
  /** `AI_AUTOSEND_ENABLED` of this process. */
  readonly flagOn: boolean;
  readonly grade: AutoSendGradeFacts | null;
  readonly disclosure: AutoSendDisclosureFacts | null;
  readonly content: AutoSendContentFacts | null;
  readonly ticket: AutoSendTicketFacts | null;
  readonly procedure: AutoSendProcedureFacts | null;
  readonly budget: AutoSendBudgetFacts | null;
}

/** How old a pre-send grade may be, in seconds (ADR-025 condition 6, `[ASSUMED]` 10 minutes). */
export const AUTOSEND_GRADE_MAX_AGE_SECONDS = 600;
/** An automatic reply waits this long so a person can step in (ADR-025 section 4, `[ASSUMED]` 120 s). */
export const AUTOSEND_HOLD_SECONDS = 120;
/** Automatic replies in a row on one ticket (condition 10, `[ASSUMED]` 2). */
export const AUTOSEND_MAX_STREAK = 2;

export interface DecisionInput {
  readonly origin: SendOrigin;
  readonly actorType: AuditActorType;
  readonly actorId: string | null;
  readonly templateKey: string | null;
  readonly approvedBy: string | null;
  readonly intent: IntentStanding;
  readonly switches: SwitchState;
  /** Only read for `ai_auto`. Absent = the Phase 1 refusal. */
  readonly autosend?: AutoSendFacts | undefined;
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
 * The stage the system acts on. Without the environment flag it never exceeds 2, whatever is stored (a
 * stage 3 in the database acts as stage 2: drafts wait for a person); with it, at most 3. The cap switch
 * ("limit all intents to stage 2 or lower") applies the same `min` in `evaluateAutoSend`. A value below 0 or
 * above 4 is not a stage: the callers that can see one (`decide`) deny it before calling this.
 */
export function effectiveStage(stage: number, autosendEnabled = false): number {
  return Math.min(stage, autosendEnabled ? PHASE_MAX_AUTONOMY_STAGE : MANUAL_MAX_AUTONOMY_STAGE);
}

const isStage = (stage: number): boolean => Number.isInteger(stage) && stage >= 0 && stage <= 4;

/** Which conditions a shadow evaluation takes as given: it asks "would it send if the intent were promoted". */
export type AutoSendWaiver = 'flag' | 'stage_cap' | 'stage';
export const SHADOW_WAIVERS: ReadonlySet<AutoSendWaiver> = new Set(['flag', 'stage_cap', 'stage']);

export interface AutoSendEvaluationInput {
  readonly actorType: AuditActorType;
  readonly intent: IntentStanding;
  readonly switches: SwitchState;
  readonly autosend: AutoSendFacts | undefined;
}

/**
 * Every condition of ADR-025 section 4 that fails, in the order of the ADR. Empty = would send. The live
 * path asks `decideAutoSend` (the first failure, with no waiver); the shadow path asks this with
 * `SHADOW_WAIVERS`, which only skips conditions 1, 4 and 5 (the ones a promotion changes), so the list it
 * stores is what would still stand in the way after a promotion.
 */
export function evaluateAutoSend(
  input: AutoSendEvaluationInput,
  waive: ReadonlySet<AutoSendWaiver> = new Set(),
): GateReason[] {
  const failed: GateReason[] = [];
  const facts = input.autosend;
  if (facts === undefined) return [GATE_REASONS.aiAutoSendDisabledPhase1];
  // 1
  if (!facts.flagOn && !waive.has('flag')) failed.push(GATE_REASONS.autosendFlagOff);
  // 2
  if (input.actorType !== 'ai') failed.push(GATE_REASONS.actorOriginMismatch);
  // 3
  if (input.switches.killSwitch) failed.push(GATE_REASONS.killSwitchOn);
  // 4
  if (input.switches.stageCapPinned && !waive.has('stage_cap'))
    failed.push(GATE_REASONS.stageCapOn);
  // 5
  if (input.intent.kind === 'none') failed.push(GATE_REASONS.intentUnknown);
  else if (input.intent.kind === 'missing') failed.push(GATE_REASONS.intentNotFound);
  else if (!isStage(input.intent.stage)) failed.push(GATE_REASONS.invalidStage);
  else if (!waive.has('stage') && effectiveStage(input.intent.stage, facts.flagOn) < 3) {
    failed.push(GATE_REASONS.stageBelow3);
  }
  // 6, 7
  const grade = facts.grade;
  if (grade === null) failed.push(GATE_REASONS.gradeMissing);
  else {
    if (!grade.hashMatches) failed.push(GATE_REASONS.gradeHashMismatch);
    if (!(grade.ageSeconds >= -5 && grade.ageSeconds <= AUTOSEND_GRADE_MAX_AGE_SECONDS)) {
      failed.push(GATE_REASONS.gradeStale);
    }
    if (!grade.passed) failed.push(GATE_REASONS.gradeFailed);
    if (grade.violationCount !== 0) failed.push(GATE_REASONS.gradeViolations);
    if (!(grade.score >= grade.minScore)) failed.push(GATE_REASONS.gradeScoreLow);
    if (grade.mock) failed.push(GATE_REASONS.gradeMock);
    if (!grade.independent) failed.push(GATE_REASONS.graderNotIndependent);
    if (!Object.is(grade.runsKnown, true)) failed.push(GATE_REASONS.aiRunMissing);
  }
  // 8
  const disclosure = facts.disclosure;
  if (disclosure === null) failed.push(GATE_REASONS.disclosureUnknown);
  else {
    if (!disclosure.contactVerified) failed.push(GATE_REASONS.contactUnverified);
    if (disclosure.senderAuthenticated === false) failed.push(GATE_REASONS.senderUnauthenticated);
  }
  // 9
  const content = facts.content;
  if (content === null) failed.push(GATE_REASONS.policyInvalid);
  else {
    if (content.allowedChannels === null) failed.push(GATE_REASONS.policyInvalid);
    else if (!content.allowedChannels.includes(content.channel)) {
      failed.push(GATE_REASONS.channelNotAllowed);
    }
    if (!(content.customerKbCitations >= 1)) failed.push(GATE_REASONS.noCustomerKbCitation);
    if (content.uncitedClaims !== 0) failed.push(GATE_REASONS.uncitedClaims);
    if (!content.linksAllowed) failed.push(GATE_REASONS.linkNotAllowed);
    if (content.attachments !== 0) failed.push(GATE_REASONS.hasAttachment);
    if (content.placeholders !== 0) failed.push(GATE_REASONS.hasPlaceholder);
    if (!(content.length >= 1 && content.length <= content.maxChars))
      failed.push(GATE_REASONS.tooLong);
  }
  // 10
  const ticket = facts.ticket;
  if (ticket === null) failed.push(GATE_REASONS.ticketFactsMissing);
  else {
    if (ticket.priority === 'P1' || ticket.priority === 'P2')
      failed.push(GATE_REASONS.priorityBlocked);
    if (ticket.openIncident) failed.push(GATE_REASONS.incidentOpen);
    if (ticket.customerWantsHuman) failed.push(GATE_REASONS.customerWantsHuman);
    if (ticket.autoStreak >= AUTOSEND_MAX_STREAK) failed.push(GATE_REASONS.autoStreakLimit);
    if (ticket.reopenedAfterAuto) failed.push(GATE_REASONS.reopenedAfterAuto);
  }
  // 11
  const procedure = facts.procedure;
  if (procedure === null) failed.push(GATE_REASONS.procedureUnknown);
  else {
    if (!procedure.autosendAllowed) failed.push(GATE_REASONS.procedureNotAutosend);
    if (procedure.stale) failed.push(GATE_REASONS.procedureStale);
    // Strict comparisons: a value that is not exactly the good one (a fact that did not load) denies.
    if (!Object.is(procedure.requiresHuman, false))
      failed.push(GATE_REASONS.procedureRequiresHuman);
    if (!Object.is(procedure.escalationPending, false)) failed.push(GATE_REASONS.escalationPending);
    if (!Object.is(procedure.replayPassed, true)) failed.push(GATE_REASONS.replayMissing);
  }
  // 12
  const budget = facts.budget;
  if (budget === null) failed.push(GATE_REASONS.budgetUnknown);
  else {
    if (!(budget.autoSentToday < budget.dailyCap)) failed.push(GATE_REASONS.dailyCapReached);
    if (budget.aiBudgetExceeded) failed.push(GATE_REASONS.aiBudgetExceeded);
  }
  return failed;
}

/** The live decision: allowed only when no condition fails (no waiver), else the first failure. */
export function decideAutoSend(input: AutoSendEvaluationInput): PolicyDecision {
  const failed = evaluateAutoSend(input);
  const first = failed[0];
  return first === undefined ? allow(GATE_REASONS.aiAutoSendAllowed) : deny(first);
}

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
      // A person's approval does not depend on the flag: min(stage, 2) is enough to be above 0.
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
      // Stage 3 is the owner's decision (N3): the flag, a promotion and eleven more conditions. With no facts
      // (a caller that does not load them) there is nothing to decide on.
      return decideAutoSend({
        actorType: input.actorType,
        intent: input.intent,
        switches: input.switches,
        autosend: input.autosend,
      });

    case 'ai_internal': {
      if (input.switches.killSwitch) return deny(GATE_REASONS.killSwitchOn);
      // An unclassified ticket has no intent yet: classification is how it gets one.
      if (input.intent.kind === 'missing') return deny(GATE_REASONS.intentNotFound);
      if (stageInvalid) return deny(GATE_REASONS.invalidStage);
      return allow(GATE_REASONS.aiInternalAllowed);
    }
  }
}
