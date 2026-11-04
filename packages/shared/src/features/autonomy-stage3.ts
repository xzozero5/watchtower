/**
 * Stage 3 contracts (ADR-025, T-304c-f): the allow-list of an automatic reply, the disclosure footer, gate
 * reports and promotions. Re-exported by `./autonomy.ts`.
 */
import { z } from 'zod';

const reasonSchema = z.string().trim().min(3).max(500);

/** The channels a first-round automatic reply may use (LINE is a later feature, owner decision 5). */
export const AUTOSEND_CHANNELS = ['gmail', 'portal'] as const;
export type AutosendChannel = (typeof AUTOSEND_CHANNELS)[number];

/**
 * `intent.autosend_policy`: what an automatic reply of this intent may do. Strict, so an unknown key is an
 * error, not a silent widening. The default (`{}`) allows NO channel: a head opts each channel in, so a
 * promoted intent with no policy sends nothing.
 */
export const autosendPolicySchema = z.strictObject({
  channels: z.array(z.enum(AUTOSEND_CHANNELS)).max(AUTOSEND_CHANNELS.length).default([]),
  /** A reply is the only action: no status change, no assignment, no other tool (ADR-025 condition 9). */
  action: z.literal('reply').default('reply'),
  /** Longest reply, footer included, in characters. */
  maxChars: z.number().int().min(100).max(4000).default(1200),
});
export type AutosendPolicy = z.infer<typeof autosendPolicySchema>;

/** The stored policy, or undefined when it does not parse (the gate then denies: `policy_invalid`). */
export function parseAutosendPolicy(raw: unknown): AutosendPolicy | undefined {
  const parsed = autosendPolicySchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : undefined;
}

/** The auto-send settings of one intent, as the api and the UI show them. */
export const intentAutosendSchema = z.object({
  shadow: z.boolean(),
  minScore: z.number().min(0.7).max(1),
  dailyCap: z.number().int().min(0).max(1000),
  policy: autosendPolicySchema,
});
export type IntentAutosend = z.infer<typeof intentAutosendSchema>;

export const setIntentAutosendSchema = z
  .object({
    shadow: z.boolean().optional(),
    minScore: z.number().min(0.7).max(1).optional(),
    dailyCap: z.number().int().min(0).max(1000).optional(),
    policy: autosendPolicySchema.optional(),
    reason: reasonSchema,
  })
  .refine(
    (body) =>
      body.shadow !== undefined ||
      body.minScore !== undefined ||
      body.dailyCap !== undefined ||
      body.policy !== undefined,
    { message: 'Give at least one setting' },
  );
export type SetIntentAutosend = z.infer<typeof setIntentAutosendSchema>;

/** `instance_setting` key of the footer that tells the customer a reply was sent automatically (ADR-025 section 8). */
export const AUTOSEND_DISCLOSURE_KEY = 'autosend.disclosure';
export const AUTOSEND_DISCLOSURE_DEFAULT = {
  enabled: true,
  text: {
    th: 'ข้อความนี้ส่งโดยระบบอัตโนมัติ (AI) หากต้องการคุยกับเจ้าหน้าที่ ตอบกลับข้อความนี้ได้เลย',
    en: 'This reply was sent automatically by our AI assistant. If you would like to speak to a person, just reply to this message.',
  },
} as const;
export const autosendDisclosureSchema = z.strictObject({
  /** On by default (owner decision 3); a head may turn it off, with an audit row. */
  enabled: z.boolean(),
  text: z.strictObject({
    th: z.string().trim().min(1).max(400),
    en: z.string().trim().min(1).max(400),
  }),
});
export type AutosendDisclosure = z.infer<typeof autosendDisclosureSchema>;
export const setAutosendDisclosureSchema = autosendDisclosureSchema.extend({
  reason: reasonSchema,
});
export type SetAutosendDisclosure = z.infer<typeof setAutosendDisclosureSchema>;

/**
 * `instance_setting` key of how many automatic replies are graded again after they were sent (the `sampled` grade,
 * T-306e C-4). The first `initialCount` replies after a promotion are graded at `initialPercent`, the rest at `percent`
 * `[ASSUMED]` (owner: 100% for the first 20, then 20%). A violation in a sampled grade rolls the intent back at once.
 */
export const AUTOSEND_SAMPLING_KEY = 'autosend.sampling';
export const AUTOSEND_SAMPLING_DEFAULT = {
  initialCount: 20,
  initialPercent: 100,
  percent: 20,
} as const;
export const autosendSamplingSchema = z.strictObject({
  initialCount: z.number().int().min(0).max(1000),
  initialPercent: z.number().int().min(0).max(100),
  percent: z.number().int().min(0).max(100),
});
export type AutosendSampling = z.infer<typeof autosendSamplingSchema>;

export const GATE_REPORT_STATUSES = ['green', 'red', 'insufficient_data'] as const;
export const gateCriterionSchema = z.object({
  /** For example `verified_resolution`, `reopen_rate`, `csat_parity`, `shadow_precision`, `window_days`. */
  key: z.string(),
  /** True, false, or null when there is not enough data to say. */
  pass: z.boolean().nullable(),
  value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  threshold: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  /** `PRD` (written in the PRD) or `ASSUMED` (a default the owner can change). */
  basis: z.enum(['PRD', 'ASSUMED']).optional(),
});
export type GateCriterion = z.infer<typeof gateCriterionSchema>;

export const gateReportSchema = z.object({
  id: z.uuid(),
  intentId: z.uuid(),
  status: z.enum(GATE_REPORT_STATUSES),
  triggerKind: z.enum(['weekly', 'on_demand']),
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  /** The numbers behind the criteria (counts, rates, means). Never customer text. */
  metrics: z.record(z.string(), z.unknown()),
  criteria: z.array(gateCriterionSchema),
  /** Always true for a green report: seed data is never counted. */
  seedExcluded: z.boolean(),
  generatedAt: z.iso.datetime(),
  generatedBy: z.uuid().nullable(),
});
export type GateReport = z.infer<typeof gateReportSchema>;

export const gateReportListSchema = z.object({ items: z.array(gateReportSchema) });
export type GateReportList = z.infer<typeof gateReportListSchema>;

export const PROMOTION_STATUSES = [
  'requested',
  'approved',
  'rejected',
  'applied',
  'expired',
  'cancelled',
] as const;
export const promotionSchema = z.object({
  id: z.uuid(),
  intentId: z.uuid(),
  gateReportId: z.uuid(),
  status: z.enum(PROMOTION_STATUSES),
  requestedBy: z.uuid(),
  requestedByName: z.string().nullable(),
  requestedAt: z.iso.datetime(),
  requestReason: z.string(),
  decidedBy: z.uuid().nullable(),
  decidedByName: z.string().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  decisionReason: z.string().nullable(),
  selfApproved: z.boolean(),
  appliedAt: z.iso.datetime().nullable(),
});
export type Promotion = z.infer<typeof promotionSchema>;
export const promotionListSchema = z.object({ items: z.array(promotionSchema) });

export const requestPromotionSchema = z.object({
  gateReportId: z.uuid(),
  reason: reasonSchema,
});
export type RequestPromotion = z.infer<typeof requestPromotionSchema>;

export const decidePromotionSchema = z.discriminatedUnion('approve', [
  z.object({
    approve: z.literal(true),
    reason: reasonSchema,
    /** The key of the intent, typed by the owner. */
    confirmKey: z.string().trim().min(1).max(120),
  }),
  z.object({ approve: z.literal(false), reason: reasonSchema }),
]);
export type DecidePromotion = z.infer<typeof decidePromotionSchema>;

export const decidePromotionResultSchema = z.object({
  status: z.enum(['approved', 'rejected', 'cancelled', 'expired']),
  selfApproved: z.boolean(),
});
export const applyPromotionResultSchema = z.object({ status: z.enum(['applied', 'expired']) });

/** How fresh a sign-in must be for the owner to approve a promotion (ADR-025 section 6). */
export const PROMOTION_REAUTH_SECONDS = 300;

/** What a head sees for the promotion door of one intent. */
export const autonomyPromotionStateSchema = z.object({
  intentId: z.uuid(),
  autosendFlag: z.boolean(),
  latestReport: gateReportSchema.nullable(),
  openPromotion: promotionSchema.nullable(),
});
export type AutonomyPromotionState = z.infer<typeof autonomyPromotionStateSchema>;
