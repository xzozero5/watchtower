/**
 * AI layer (T-106, T-108): this feature's own audit actions, ticket event types and queue names (T-123a).
 *
 * The task that owns this feature adds entries here and nowhere else in `packages/shared`. The
 * global `AUDIT_ACTIONS`, `TICKET_EVENT_TYPES` and `QUEUE_NAMES` are composed from these records
 * (see `./index.ts`), and importing `@watchtower/shared` throws if two features use the same key
 * or the same value. Keys are camelCase; values are lowercase strings (dotted for audit actions and
 * ticket events, the BullMQ queue name for queues). Start a value with the feature name so
 * collisions are unlikely.
 */
import { z } from 'zod';

/** Audit `action` strings written by this feature. */
export const AI_AUDIT_ACTIONS = {} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const AI_TICKET_EVENTS = {} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (producer: api, consumer: worker). */
export const AI_QUEUES = {} as const satisfies Record<string, string>;

// --- AI-first workspace contract (T-128, docs/design/ai-first-workspace.md section 6) ---
//
// `GET /v1/tickets/:id/ai` returns a `TicketAiInsight`; a ticket list row carries `ai` (`TicketAiRow`).
// Producers: T-106e (classifier + summarizer) and T-108 (investigator + drafter). Until they land
// the api answers 404 and the web shows "AI brief unavailable" (N5: the UI never invents AI content).

/** Where the AI is with a ticket. The queue groups rows by this (plus SLA and status). */
export const AI_STATES = [
  'none',
  'classified',
  'investigating',
  'draft_ready',
  'needs_human',
  'failed',
] as const;
export const aiStateSchema = z.enum(AI_STATES);
export type AiState = z.infer<typeof aiStateSchema>;

/** What the list row carries: just enough for the two-line triage row. */
export const ticketAiRowSchema = z.object({
  state: aiStateSchema,
  /** One line, at most 80 characters. Absent: the row shows the subject instead. */
  summary: z.string().max(200).optional(),
});
export type TicketAiRow = z.infer<typeof ticketAiRowSchema>;

/** The kind of the one step the AI suggests next. The web maps each kind to one button. */
export const AI_NEXT_STEP_KINDS = [
  'approve_draft',
  'reply',
  'escalate_dev',
  'wait_customer',
  'resolve',
  'other',
] as const;
export const aiNextStepKindSchema = z.enum(AI_NEXT_STEP_KINDS);
export type AiNextStepKind = z.infer<typeof aiNextStepKindSchema>;

export const AI_EVIDENCE_KINDS = ['kb', 'ticket', 'log', 'data', 'repo'] as const;
export const aiEvidenceKindSchema = z.enum(AI_EVIDENCE_KINDS);
export type AiEvidenceKind = z.infer<typeof aiEvidenceKindSchema>;

export const aiEvidenceSchema = z.object({
  id: z.string().min(1).max(100),
  kind: aiEvidenceKindSchema,
  title: z.string().max(300),
  snippet: z.string().max(1000),
  /** 0 to 1: how well this supports the claim it is cited for. */
  confidence: z.number().min(0).max(1),
  /** A link to the source: a path inside Watchtower or an http(s) URL. */
  href: z.string().max(2000).optional(),
});
export type AiEvidence = z.infer<typeof aiEvidenceSchema>;

export const aiDraftSchema = z.object({
  id: z.string().min(1).max(100),
  body: z.string().min(1).max(20_000),
  /** Ids of the evidence the draft cites. */
  citations: z.array(z.string()),
  /** Sentences in the draft that no evidence supports. Approving still needs a second look. */
  uncitedClaims: z.number().int().min(0),
  /** Shown as `prompt {promptVersion}`, for example `v3`. */
  promptVersion: z.string().min(1).max(40),
  createdAt: z.iso.datetime(),
});
export type AiDraft = z.infer<typeof aiDraftSchema>;

/** The autonomy stage in force for the ticket's intent. Phase 1 renders 0 to 2 only (N3). */
export const aiStageSchema = z.number().int().min(0).max(4);

export const ticketAiInsightSchema = z.object({
  state: aiStateSchema,
  summary: z.string().max(1000).optional(),
  intent: z
    .object({
      key: z.string().max(100),
      /** 0 to 1. */
      confidence: z.number().min(0).max(1),
      reason: z.string().max(500),
    })
    .optional(),
  nextStep: z.object({ kind: aiNextStepKindSchema, label: z.string().max(120) }).optional(),
  evidence: z.array(aiEvidenceSchema),
  draft: aiDraftSchema.optional(),
  stage: aiStageSchema,
  generatedAt: z.iso.datetime(),
});
export type TicketAiInsight = z.infer<typeof ticketAiInsightSchema>;

/** Why a person rejected a draft (docs/06-UI-SPEC.md section 6.3). Stored as `ai_draft.reject_reason`. */
export const AI_REJECT_REASONS = [
  'wrong_intent',
  'factually_wrong',
  'missing_info',
  'not_grounded',
  'disclosure_risk',
  'tone_style',
  'wrong_language',
  'no_reply_needed',
  'other',
] as const;
export const aiRejectReasonSchema = z.enum(AI_REJECT_REASONS);
export type AiRejectReason = z.infer<typeof aiRejectReasonSchema>;

/** Body of `POST /v1/tickets/:id/ai/drafts/:draftId/reject`. A comment is required for `other`. */
export const rejectAiDraftSchema = z
  .object({
    reason: aiRejectReasonSchema,
    comment: z.string().trim().max(1000).optional(),
  })
  .refine((value) => value.reason !== 'other' || (value.comment ?? '') !== '', {
    path: ['comment'],
    message: 'A comment is required when the reason is "other"',
  });
export type RejectAiDraft = z.infer<typeof rejectAiDraftSchema>;
