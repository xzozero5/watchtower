/**
 * Autonomy stages and emergency switch (T-112): this feature's own audit actions, ticket event types and queue names (T-123a).
 *
 * The task that owns this feature adds entries here and nowhere else in `packages/shared`. The
 * global `AUDIT_ACTIONS`, `TICKET_EVENT_TYPES` and `QUEUE_NAMES` are composed from these records
 * (see `./index.ts`), and importing `@watchtower/shared` throws if two features use the same key
 * or the same value. Keys are camelCase; values are lowercase strings (dotted for audit actions and
 * ticket events, the BullMQ queue name for queues). Start a value with the feature name so
 * collisions are unlikely.
 */
import { z } from 'zod';

import { cursorSchema, pageLimit } from '../common.js';
import { intentAutosendSchema } from './autonomy-stage3.js';

export * from './autonomy-stage3.js';

/** Audit `action` strings written by this feature. */
export const AUTONOMY_AUDIT_ACTIONS = {
  /** A global switch was turned on or off (reason required both ways). */
  autonomySwitchSet: 'autonomy.switch_set',
  /** An intent's autonomy stage changed (history row written in the same transaction). */
  autonomyStageSet: 'autonomy.stage_set',
  /** An intent's stage was pinned or unpinned by the head. */
  autonomyPinSet: 'autonomy.pin_set',
  /** The policy gate refused something an AI or a system sender tried (N3, ADR-011). */
  autonomyPolicyDenied: 'autonomy.policy_denied',
  // Stage 3 (ADR-025, migration 0096).
  /** A head asked for a promotion to stage 3 with a green gate report. */
  autonomyPromotionRequested: 'autonomy.promotion_requested',
  /** The owner approved, rejected or withdrew a promotion (metadata carries `selfApproved`). */
  autonomyPromotionDecided: 'autonomy.promotion_decided',
  /** An approved promotion was applied: the intent is at stage 3. */
  autonomyPromoted: 'autonomy.promoted',
  /** The system moved an intent from stage 3 back to 2. */
  autonomyAutoRollback: 'autonomy.auto_rollback',
  /** A head changed the auto-send rules of an intent. */
  autonomyAutosendConfigSet: 'autonomy.autosend_config_set',
  /** The schema owner gave (or took away) `ai.autonomy.owner_approve` to a person, from the command line. */
  autonomyOwnerApprovalSet: 'autonomy.owner_approval_set',
  // Stage 3 runtime (T-304c-f).
  /** A process booted with `AI_AUTOSEND_ENABLED=true` (one row per boot of the api or the worker). */
  autonomyAutosendFlagBoot: 'autonomy.autosend_flag_boot',
  /** The AI meant to send on its own and was held back (the first failed condition is in the metadata). */
  autonomyAutosendHeld: 'autonomy.autosend_held',
  /** An automatic send was scheduled (the grade and the hold are in the metadata). */
  autonomyAutosendScheduled: 'autonomy.autosend_scheduled',
  /** A gate report was written (weekly or on demand). */
  autonomyGateReportGenerated: 'autonomy.gate_report_generated',
  /** A head changed the customer-facing disclosure footer of automatic replies. */
  autonomyDisclosureSet: 'autonomy.disclosure_set',
} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const AUTONOMY_TICKET_EVENTS = {
  /** Internal note on the timeline: "AI meant to send but was held: <reason>" (ADR-025 section 4). */
  autosendHeld: 'autonomy.autosend_held',
} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (producer: api, worker; consumer: worker). */
export const AUTONOMY_QUEUES = {
  autonomy: 'autonomy',
} as const satisfies Record<string, string>;

export const AUTONOMY_JOBS = {
  /** Look at the intents at stage 3 for a rollback condition (an event, or every 15 minutes). */
  watch: 'autonomy.watch',
  /** The weekly gate report of every intent at stage 2 or 3. */
  weeklyReports: 'autonomy.weekly_reports',
} as const satisfies Record<string, string>;
export const AUTONOMY_WATCH_EVERY_MS = 15 * 60_000;

/**
 * `AI_AUTOSEND_ENABLED` (ADR-025 section 2). ON only for the string `true`, exactly: not `TRUE`, not `1`, not
 * ` true`. Anything else, including unset, is OFF. Read once at boot by the api and by the worker.
 */
export function parseAutosendFlag(raw: string | undefined): boolean {
  return raw === 'true';
}
export const autosendFlagSchema = z.string().optional().transform(parseAutosendFlag);

// --- vocabulary shared by the gate, the api and the UI (ADR-011) ---

/**
 * The highest autonomy stage the schema and the domain know (ADR-025, migration 0096). Stage 3 (auto-send) is
 * the owner's decision (N3, PRD section 6.4) and is reached only through a promotion: a head asks, the owner
 * approves with a fresh sign-in and the typed key. Even then the system acts on `min(stage, 2)` unless the
 * instance runs with `AI_AUTOSEND_ENABLED=true`.
 */
export const PHASE_MAX_AUTONOMY_STAGE = 3;
/** The highest stage a person can set by hand (`POST /v1/intents/:id/autonomy`): 3 is never set, only promoted. */
export const MANUAL_MAX_AUTONOMY_STAGE = 2;

export const AUTONOMY_STAGE_NAMES = {
  0: 'observe',
  1: 'suggest',
  2: 'draft_for_approval',
  3: 'auto_send',
} as const;

/** The two global switches (po decision 23). Keys are the primary key of table `ai_switch`. */
export const AI_SWITCH_KEYS = ['ai_stage_cap_pinned', 'ai_kill_switch'] as const;
export const aiSwitchKeySchema = z.enum(AI_SWITCH_KEYS);
export type AiSwitchKey = z.infer<typeof aiSwitchKeySchema>;

const reasonSchema = z.string().trim().min(3).max(500);

export const aiSwitchSchema = z.object({
  key: aiSwitchKeySchema,
  on: z.boolean(),
  /** The reason given when it was last flipped (either direction); empty if never flipped. */
  reason: z.string(),
  changedBy: z.uuid().nullable(),
  /**
   * First word of the display name of whoever flipped it, for every staff reader (agents need it for
   * the "AI paused by ..." banner; they cannot list users). Null if never flipped or the account is
   * gone. Never an email address.
   */
  changedByName: z.string().nullable(),
  changedAt: z.iso.datetime(),
});
export type AiSwitch = z.infer<typeof aiSwitchSchema>;

export const setAiSwitchSchema = z.object({
  switch: aiSwitchKeySchema,
  on: z.boolean(),
  /** Required both ways: turning a switch on and turning it off are each confirmed with a reason. */
  reason: reasonSchema,
});
export type SetAiSwitch = z.infer<typeof setAiSwitchSchema>;

export const autonomyIntentSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  isActive: z.boolean(),
  /** The stage stored on the intent (0-3; 3 only through a promotion). */
  stage: z.number().int().min(0).max(PHASE_MAX_AUTONOMY_STAGE),
  /** The stage the system acts on: `min(stage, 2)` while `autosendFlag` is off, else `min(stage, 3)`. */
  effectiveStage: z.number().int().min(0).max(PHASE_MAX_AUTONOMY_STAGE),
  /** True when the head pinned the stage: nobody changes it until it is unpinned. */
  pinned: z.boolean(),
  /** The auto-send settings (shadow mode, score, daily cap, allow-list). Absent in older clients' fixtures. */
  autosend: intentAutosendSchema.optional(),
  updatedAt: z.iso.datetime(),
});
export type AutonomyIntent = z.infer<typeof autonomyIntentSchema>;

export const autonomyStateSchema = z.object({
  /** Highest stage a person can set by hand (2): stage 3 is reached only by a promotion. */
  stageCeiling: z.literal(MANUAL_MAX_AUTONOMY_STAGE),
  /**
   * `AI_AUTOSEND_ENABLED` of the api process, read once at boot. Read-only here: it is not in the database and
   * no endpoint changes it. With it off, `effectiveStage` never exceeds 2 and a promotion answers 409.
   */
  autosendFlag: z.boolean().default(false),
  switches: z.array(aiSwitchSchema),
  intents: z.array(autonomyIntentSchema),
});
export type AutonomyState = z.infer<typeof autonomyStateSchema>;

export const setAiSwitchResultSchema = z.object({
  /** False when the switch already had the requested value (nothing was written or audited). */
  changed: z.boolean(),
  switches: z.array(aiSwitchSchema),
});
export type SetAiSwitchResult = z.infer<typeof setAiSwitchResultSchema>;

export const setIntentAutonomySchema = z
  .object({
    /** New stage, 0-2. 3 and above are refused with `autonomy_stage_requires_owner`: they are reached by a promotion. */
    stage: z.number().int().min(0).max(100).optional(),
    /** Pin or unpin the stage (head only). */
    pinned: z.boolean().optional(),
    reason: reasonSchema,
  })
  .refine((body) => body.stage !== undefined || body.pinned !== undefined, {
    message: 'Give a stage, pinned, or both',
  });
export type SetIntentAutonomy = z.infer<typeof setIntentAutonomySchema>;

export const intentAutonomyChangeSchema = z.object({
  intent: autonomyIntentSchema,
  /** False when the request asked for what the intent already had. */
  changed: z.boolean(),
});
export type IntentAutonomyChange = z.infer<typeof intentAutonomyChangeSchema>;

// --- autonomy history (T-127, UI spec 18.9 H6) ---

export const AUTONOMY_HISTORY_CHANGES = [
  'stage',
  'pin',
  'unpin',
  // Stage 3 (ADR-025, migration 0096).
  'promotion',
  'auto_rollback',
  'autosend',
] as const;

export const autonomyHistoryEntrySchema = z.object({
  id: z.uuid(),
  intentId: z.uuid(),
  change: z.enum(AUTONOMY_HISTORY_CHANGES),
  fromStage: z.number().int().min(0),
  toStage: z.number().int().min(0),
  /** The pin state after this change. */
  pinned: z.boolean(),
  reason: z.string(),
  changedBy: z.uuid().nullable(),
  /** Display name of the person; null if the account no longer exists. */
  changedByName: z.string().nullable(),
  changedAt: z.iso.datetime(),
});
export type AutonomyHistoryEntry = z.infer<typeof autonomyHistoryEntrySchema>;

export const autonomyHistoryQuerySchema = z.object({
  limit: pageLimit(50, 200),
  cursor: cursorSchema.optional(),
});
export type AutonomyHistoryQuery = z.infer<typeof autonomyHistoryQuerySchema>;

export const autonomyHistoryPageSchema = z.object({
  /** Newest first. */
  items: z.array(autonomyHistoryEntrySchema),
  nextCursor: z.string().nullable(),
});
export type AutonomyHistoryPage = z.infer<typeof autonomyHistoryPageSchema>;
