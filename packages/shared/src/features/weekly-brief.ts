/**
 * The AI-drafted weekly brief of the CEO view (T-305c, PRD section 9.2). Browser-safe (no Node imports).
 *
 * A worker job writes a draft once a week from the real figures of the CEO view and the facts of the week;
 * a head edits it and publishes it; the page shows the published one and the recipients get it by email.
 *
 * Honesty rule (N5, T-135): every claim is the shape of `claims.ts` (a sentence and the pages behind it); a
 * sentence with no evidence says so (`uncited`). The model never writes a link: the evidence is built from
 * the facts the code read. A head may reword a claim and drop or add one, but may not attach evidence that
 * the model's own draft did not have (`evidenceWithinDraft`).
 */
import { z } from 'zod';

import { claimEvidenceSchema, claimSchema, type Claim, type ClaimEvidence } from './claims.js';
import { ceoViewSchema } from './reports.js';

export const WEEKLY_BRIEF_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type WeeklyBriefDay = (typeof WEEKLY_BRIEF_DAYS)[number];
/** The window of a weekly brief, in whole UTC days (today included), as the CEO view reads it. */
export const WEEKLY_BRIEF_WINDOW_DAYS = 7;
export const WEEKLY_BRIEF_MAX_ROOT_CAUSES = 5;
export const WEEKLY_BRIEF_MAX_RECIPIENTS = 50;
/** After this long without an AI that works, the draft is made from the figures alone (the head writes the words). */
export const WEEKLY_BRIEF_AI_GIVE_UP_HOURS = 24;

/** `HH:MM` on a 24-hour clock to minutes since midnight; null when it is not a time of day. */
export function parseWeeklyBriefTime(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match === null ? null : Number(match[1]) * 60 + Number(match[2]);
}

export const weeklyBriefStatusSchema = z.enum(['draft', 'published']);
export const weeklyBriefSourceSchema = z.enum(['ai', 'data_only']);
export const weeklyBriefLocaleSchema = z.enum(['th', 'en']);
export type WeeklyBriefLocale = z.infer<typeof weeklyBriefLocaleSchema>;

/** A recurring cause the week showed, with the claims (and so the evidence) that support it. */
export const weeklyBriefRootCauseSchema = z.object({
  title: z.string().trim().min(1).max(160),
  claims: z.array(claimSchema).min(1).max(3),
  /** A suggested product or engineering ask. A suggestion for the head to confirm, never a fact. */
  ask: z.string().trim().max(300).nullable(),
});
export type WeeklyBriefRootCause = z.infer<typeof weeklyBriefRootCauseSchema>;

export const weeklyBriefContentSchema = z.object({
  /** Are customers OK, is the platform stable, how is the AI doing: what the figures and the week say. */
  summary: z.array(claimSchema).max(8),
  rootCauses: z.array(weeklyBriefRootCauseSchema).max(WEEKLY_BRIEF_MAX_ROOT_CAUSES),
  /** What the head has to decide, drawn from the facts. */
  decisions: z.array(claimSchema).max(5),
});
export type WeeklyBriefContent = z.infer<typeof weeklyBriefContentSchema>;

export const weeklyBriefSchema = z.strictObject({
  id: z.uuid(),
  slotDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodFrom: z.iso.datetime(),
  periodTo: z.iso.datetime(),
  status: weeklyBriefStatusSchema,
  locale: weeklyBriefLocaleSchema,
  source: weeklyBriefSourceSchema,
  /** Why the draft has no AI text (`data_only`), as a code. */
  reasonCode: z.string().nullable(),
  /** The CEO view as it was when the brief was made. */
  figures: ceoViewSchema,
  content: weeklyBriefContentSchema,
  /** What the model wrote, for the head to compare with (never changes). Only a head who may edit gets it. */
  aiContent: weeklyBriefContentSchema.nullable(),
  /** Written by the mock provider or from fixtures: the page says `Demo`. */
  mock: z.boolean(),
  aiRunId: z.uuid().nullable(),
  promptVersion: z.number().int().nullable(),
  editedAt: z.iso.datetime().nullable(),
  recipients: z.array(z.string()),
  publishedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type WeeklyBrief = z.infer<typeof weeklyBriefSchema>;

/** `GET /v1/reports/ceo/brief`: what the CEO page shows. */
export const weeklyBriefPublishedSchema = z.strictObject({ brief: weeklyBriefSchema.nullable() });
export type WeeklyBriefPublished = z.infer<typeof weeklyBriefPublishedSchema>;

/** `GET /v1/reports/ceo/brief/draft`: the newest draft, and who a publish would email by default. */
export const weeklyBriefDraftSchema = z.strictObject({
  draft: weeklyBriefSchema.nullable(),
  defaultRecipients: z.array(z.string()),
});
export type WeeklyBriefDraft = z.infer<typeof weeklyBriefDraftSchema>;

export const weeklyBriefIdParamSchema = z.object({ id: z.uuid() });
export type WeeklyBriefIdParam = z.infer<typeof weeklyBriefIdParamSchema>;

export const weeklyBriefEditBodySchema = z.strictObject({ content: weeklyBriefContentSchema });
export type WeeklyBriefEditBody = z.infer<typeof weeklyBriefEditBodySchema>;

export const weeklyBriefRecipientSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const weeklyBriefPublishBodySchema = z.strictObject({
  /** Absent: the instance default (`WEEKLY_BRIEF_RECIPIENTS`). An empty list publishes without sending email. */
  recipients: z.array(weeklyBriefRecipientSchema).max(WEEKLY_BRIEF_MAX_RECIPIENTS).optional(),
});
export type WeeklyBriefPublishBody = z.infer<typeof weeklyBriefPublishBodySchema>;

export const weeklyBriefPublishResultSchema = z.strictObject({
  brief: weeklyBriefSchema,
  /** Emails queued. They leave through the outbox, so this is "queued", not "delivered". */
  queued: z.number().int().min(0),
});
export type WeeklyBriefPublishResult = z.infer<typeof weeklyBriefPublishResultSchema>;

// --- rules -----------------------------------------------------------------------------------------------

const evidenceKey = (item: ClaimEvidence): string =>
  `${item.kind}\u0000${item.label}\u0000${item.href ?? ''}`;

/** Every evidence chip the content holds, in reading order. */
export function evidenceOf(content: WeeklyBriefContent): ClaimEvidence[] {
  const claims: Claim[] = [
    ...content.summary,
    ...content.rootCauses.flatMap((cause) => cause.claims),
    ...content.decisions,
  ];
  return claims.flatMap((claim) => claim.evidence);
}

/**
 * The evidence of `edited` that the model's `draft` did not have. A head edits words; a link that the draft
 * never had would put a fact in the head's name that nothing read (N5), so the api refuses it.
 */
export function evidenceOutsideDraft(
  draft: WeeklyBriefContent,
  edited: WeeklyBriefContent,
): ClaimEvidence[] {
  const known = new Set(evidenceOf(draft).map(evidenceKey));
  return evidenceOf(edited).filter((item) => !known.has(evidenceKey(item)));
}

/** A claim a person wrote: no evidence, and says so. */
export const humanClaim = (text: string): Claim => ({ text, evidence: [], uncited: true });

export { claimEvidenceSchema };

/** The text of one claim for an email: the sentence and the names of what it rests on. */
const claimLine = (claim: Claim): string => {
  const names = claim.evidence.map((item) => item.label);
  const text = claim.text.slice(0, 600);
  return (names.length === 0 ? `${text} (no evidence)` : `${text} [${names.join(', ')}]`).slice(
    0,
    880,
  );
};

/** What the weekly brief email carries (plain strings: an email job holds no objects of the app). */
export interface WeeklyBriefEmailParts {
  readonly summary: string[];
  readonly rootCauses: { title: string; text: string; ask: string | null }[];
  readonly decisions: string[];
}

export function weeklyBriefEmailParts(content: WeeklyBriefContent): WeeklyBriefEmailParts {
  return {
    summary: content.summary.map(claimLine),
    rootCauses: content.rootCauses.map((cause) => ({
      title: cause.title,
      text: cause.claims.map(claimLine).join(' ').slice(0, 1500),
      ask: cause.ask,
    })),
    decisions: content.decisions.map(claimLine),
  };
}
