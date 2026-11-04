import type { AutonomyPromotionState, GateCriterion, GateReport } from '@watchtower/shared';

import type { MessageKey } from '@/i18n';

/**
 * Why the "ask for stage 3" button is off, or null when it is on (ADR-025, T-304g). The api decides in the end
 * (it checks the whole chain again); this only says in words what the person can see before pressing.
 *
 * The order is the order a person fixes things: the instance switch first (nobody in the app can change it),
 * then the report, then the intent itself.
 */
export type PromotionBlock =
  | 'flag_off'
  | 'no_report'
  | 'insufficient_data'
  | 'not_green'
  | 'already_stage3'
  | 'below_stage_2'
  | 'pinned'
  | 'request_open';

export function promotionBlock(input: {
  /** `autosendFlag` of `GET /v1/autonomy` (the instance setting `AI_AUTOSEND_ENABLED`). */
  autosendFlag: boolean;
  stage: number;
  pinned: boolean;
  latestReport: GateReport | null;
  openPromotion: AutonomyPromotionState['openPromotion'];
}): PromotionBlock | null {
  if (!input.autosendFlag) return 'flag_off';
  if (input.stage >= 3) return 'already_stage3';
  if (input.openPromotion) return 'request_open';
  if (input.pinned) return 'pinned';
  if (input.stage < 2) return 'below_stage_2';
  if (!input.latestReport) return 'no_report';
  if (input.latestReport.status === 'insufficient_data') return 'insufficient_data';
  if (input.latestReport.status !== 'green') return 'not_green';
  return null;
}

export const PROMOTION_BLOCK_KEYS: Record<PromotionBlock, MessageKey> = {
  flag_off: 'stage3.block.flagOff',
  no_report: 'stage3.block.noReport',
  insufficient_data: 'stage3.block.insufficientData',
  not_green: 'stage3.block.notGreen',
  already_stage3: 'stage3.block.alreadyStage3',
  below_stage_2: 'stage3.block.belowStage2',
  pinned: 'stage3.block.pinned',
  request_open: 'stage3.block.requestOpen',
};

/** The name of a gate criterion for people. An unknown key shows as it is (a newer api than this screen). */
export const CRITERION_KEYS: Readonly<Record<string, MessageKey>> = {
  days_at_stage_2: 'stage3.criteria.daysAtStage2',
  graded_sample: 'stage3.criteria.gradedSample',
  verified_resolution: 'stage3.criteria.verifiedResolution',
  reopen_rate: 'stage3.criteria.reopenRate',
  csat_parity: 'stage3.criteria.csatParity',
  ai_policy_violations: 'stage3.criteria.aiPolicyViolations',
  shadow_evaluations: 'stage3.criteria.shadowEvaluations',
  shadow_precision: 'stage3.criteria.shadowPrecision',
  eval_replay_violations: 'stage3.criteria.evalReplay',
  redaction_eval: 'stage3.criteria.redactionEval',
};

export type CriterionState = 'pass' | 'fail' | 'unknown';
export function criterionState(criterion: GateCriterion): CriterionState {
  return criterion.pass === true ? 'pass' : criterion.pass === false ? 'fail' : 'unknown';
}

/** The numbers the "Shadow" block shows, read from the report's metrics (the api gives `unknown`). */
export function shadowMetrics(
  report: GateReport | null,
): { evaluations: number; decided: number; accepted: number; precision: number | null } | null {
  const raw = report?.metrics.shadow;
  if (typeof raw !== 'object' || raw === null) return null;
  const shadow = raw as Record<string, unknown>;
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return {
    evaluations: num(shadow.evaluations),
    decided: num(shadow.decided),
    accepted: num(shadow.accepted),
    precision: typeof shadow.precision === 'number' ? shadow.precision : null,
  };
}

/**
 * The reason codes of "AI meant to send but was held" (`GATE_REASONS` in the domain), each as a sentence.
 * The ticket event carries the code only, never text (ADR-025 section 4).
 */
const HELD_REASON_KEYS: Readonly<Record<string, MessageKey>> = {
  autosend_flag_off: 'stage3.held.autosend_flag_off',
  kill_switch_on: 'stage3.held.kill_switch_on',
  stage_cap_on: 'stage3.held.stage_cap_on',
  stage_below_3: 'stage3.held.stage_below_3',
  grade_missing: 'stage3.held.grade_missing',
  grade_hash_mismatch: 'stage3.held.grade_hash_mismatch',
  grade_stale: 'stage3.held.grade_stale',
  grade_failed: 'stage3.held.grade_failed',
  grade_violations: 'stage3.held.grade_violations',
  grade_score_low: 'stage3.held.grade_score_low',
  grade_mock: 'stage3.held.grade_mock',
  grader_not_independent: 'stage3.held.grader_not_independent',
  disclosure_unknown: 'stage3.held.disclosure_unknown',
  contact_unverified: 'stage3.held.contact_unverified',
  sender_unauthenticated: 'stage3.held.sender_unauthenticated',
  policy_invalid: 'stage3.held.policy_invalid',
  channel_not_allowed: 'stage3.held.channel_not_allowed',
  no_customer_kb_citation: 'stage3.held.no_customer_kb_citation',
  uncited_claims: 'stage3.held.uncited_claims',
  link_not_allowed: 'stage3.held.link_not_allowed',
  has_attachment: 'stage3.held.has_attachment',
  has_placeholder: 'stage3.held.has_placeholder',
  too_long: 'stage3.held.too_long',
  ticket_facts_missing: 'stage3.held.ticket_facts_missing',
  priority_blocked: 'stage3.held.priority_blocked',
  incident_open: 'stage3.held.incident_open',
  customer_wants_human: 'stage3.held.customer_wants_human',
  auto_streak_limit: 'stage3.held.auto_streak_limit',
  reopened_after_auto: 'stage3.held.reopened_after_auto',
  procedure_unknown: 'stage3.held.procedure_unknown',
  procedure_not_autosend: 'stage3.held.procedure_not_autosend',
  procedure_stale: 'stage3.held.procedure_stale',
  budget_unknown: 'stage3.held.budget_unknown',
  daily_cap_reached: 'stage3.held.daily_cap_reached',
  ai_budget_exceeded: 'stage3.held.ai_budget_exceeded',
  intent_unknown: 'stage3.held.intent_unknown',
  intent_not_found: 'stage3.held.intent_not_found',
  invalid_stage: 'stage3.held.invalid_stage',
};

/** The sentence for a hold reason code, or null when this screen does not know the code. */
export function heldReasonKey(code: string): MessageKey | null {
  return Object.hasOwn(HELD_REASON_KEYS, code) ? (HELD_REASON_KEYS[code] ?? null) : null;
}

/** The held reason of an `autonomy.autosend_held` event payload: `reason`, else the first of `failed`. */
export function heldReasonCode(payload: Record<string, unknown>): string | null {
  const one = payload.reason;
  if (typeof one === 'string' && one !== '') return one;
  const many = payload.failed;
  if (Array.isArray(many)) {
    const first: unknown = many[0];
    if (typeof first === 'string' && first !== '') return first;
  }
  return null;
}

/** Where the owner comes back to after signing in again: the intent, the Stage 3 tab, the request to approve. */
export function approveReturnPath(intentId: string, promotionId: string): string {
  return `/admin/intents/${encodeURIComponent(intentId)}?tab=stage3&approve=${encodeURIComponent(promotionId)}`;
}
