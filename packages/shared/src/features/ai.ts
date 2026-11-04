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

import { ticketPrioritySchema } from '../sla.js';
import { claimSchema } from './claims.js';

/** Audit `action` strings written by this feature. */
export const AI_AUDIT_ACTIONS = {
  /** A daily AI cap reached its alert level (once per UTC day and cap). */
  aiBudgetAlert: 'ai.budget_alert',
  /** A daily AI cap was reached: model calls stop for the rest of the UTC day (fail closed to rules). */
  aiBudgetStop: 'ai.budget_stop',
  /** A person rejected an AI draft, with one reason code (T-108). */
  aiDraftReject: 'ai.draft_reject',
  /** A person edited an AI draft and sent their own version (T-108). */
  aiDraftEdited: 'ai.draft_edited',
  /** A person asked for a draft (stage 1) or a new investigation (T-108). */
  aiRequest: 'ai.request',
  /** The AI wrote a draft article for review after a ticket was resolved without a citation (T-108e). */
  aiKbDraft: 'ai.kb_draft',
  /** A person sent a message to the assistant. Metadata: tool names, run ids, counts; never the text (T-134). */
  assistantMessage: 'assistant.message',
  /** A person pressed an assistant proposal: written in the same transaction as the change it ran (T-134). */
  assistantProposalConfirm: 'assistant.proposal.confirm',
  /** The assistant ran an investigation template by itself: actor `ai`, on behalf of a person, nothing pinned (N2). */
  assistantToolRun: 'assistant.tool_run',
  /** A person declined an assistant proposal without running it. */
  assistantProposalReject: 'assistant.proposal.reject',
  /** A person deleted a conversation with the assistant. */
  assistantConversationDelete: 'assistant.conversation.delete',
} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const AI_TICKET_EVENTS = {} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (producer: api, consumer: worker). */
export const AI_QUEUES = {
  /** Jobs of the AI layer: the first one is the ticket brief (classify + summarize), T-106e. */
  ai: 'ai',
} as const satisfies Record<string, string>;

export const AI_JOBS = {
  /** Classify and summarize one ticket and upsert its `ai_ticket_insight`. `jobId` is per ticket. */
  summarize: 'summarize',
  /** Investigate one ticket (runbook tools, evidence, report) and draft a reply when the stage allows (T-108). */
  investigate: 'investigate',
  /** Draft a reply from the latest investigation, on request (stage 1) or again after a reject (T-108). */
  draft: 'draft',
  /** Write a draft article for review from a resolved ticket that cited nothing (T-108e, AC-4). */
  kbAuthor: 'kb_author',
} as const;

/** Payload of an `ai` `investigate` job. `requestedBy` is the person who asked, or null when the system did. */
export const aiInvestigateJobSchema = z.object({
  ticketId: z.uuid(),
  requestedBy: z.uuid().nullable().default(null),
  /**
   * True when a developer asked (T-137): the run investigates and writes no draft reply, whatever the
   * stage of the intent. A developer neither sees nor approves a draft (N3), so none is made on their request.
   */
  noDraft: z.boolean().default(false),
});
export type AiInvestigateJob = z.infer<typeof aiInvestigateJobSchema>;

export const aiDraftJobSchema = z.object({
  ticketId: z.uuid(),
  requestedBy: z.uuid().nullable().default(null),
  /** A note from the person for `regenerate with note`. Redacted before it reaches a model. */
  note: z.string().trim().max(500).optional(),
});
export type AiDraftJob = z.infer<typeof aiDraftJobSchema>;

export const aiKbAuthorJobSchema = z.object({
  ticketId: z.uuid(),
  /** The person who resolved the ticket: they may not approve the article the AI writes. */
  requestedBy: z.uuid().nullable().default(null),
});
export type AiKbAuthorJob = z.infer<typeof aiKbAuthorJobSchema>;

/**
 * [ASSUMED] The KB author waits this long after a resolve, so a quick reopen cancels it (the job checks the
 * status). AC-4 wants the draft article within 5 minutes; the job itself takes seconds.
 */
export const KB_AUTHOR_DELAY_MS = 30_000;

/**
 * Budgets of the tools (N2, PRD R-5.1). Counted from `tool_execution`, outside any run's handle.
 * `[ASSUMED]` values: the Logging API allows 60 reads a minute per project and a person must keep
 * room to run the same query, so the AI may use half of that.
 */
export const AI_TOOL_BUDGETS = {
  /** Calls one investigation or draft run may make. */
  perRun: 12,
  /** Calls all runs together may make for one ticket in an hour. */
  perTicketPerHour: 40,
  /** Calls of one tool, by all tickets, in a minute (AI share of the shared bucket). */
  perToolPerMinute: 30,
} as const;
/**
 * `[ASSUMED]` 0.75: the classifier's confidence an intent needs before its tools (logs, data, repo)
 * may run. Below it, or with no intent, only the generic tools run. A person who set the intent on
 * the ticket needs no threshold (SR106-R8: the intent that scopes tools is not the model's word alone).
 */
export const AI_INTENT_SCOPE_MIN_CONFIDENCE = 0.75;

/**
 * `[ASSUMED]` 110 s: the investigation job (tools, report, draft) stops before the 120 s p95 target
 * of the plan; a model call that is still running is aborted and the job retries.
 */
export const AI_INVESTIGATION_DEADLINE_MS = 110_000;

/**
 * `[ASSUMED]` How often a person may ask the AI for a draft or a new investigation (`POST .../ai/requests`).
 * A draft on request makes a model call without a tool call, so the tool budget does not bound it.
 */
export const AI_REQUEST_LIMITS = { perUserPerHour: 30, perTicketPerHour: 6 } as const;

export type AiToolBudgets = { -readonly [K in keyof typeof AI_TOOL_BUDGETS]: number };

/** Payload of an `ai` `summarize` job: only the id; the worker loads the ticket. */
export const aiSummarizeJobSchema = z.object({ ticketId: z.uuid() });
export type AiSummarizeJob = z.infer<typeof aiSummarizeJobSchema>;

/** Retry with backoff; the insight row is the record, so a finished job is dropped. */
export const AI_OUTBOX_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

/**
 * Why a ticket is `needs_human` or `failed` in `ai_ticket_insight.reason_code`: a stable code, never
 * prose from a model. The first three are the gate and the budget saying no before any model call.
 */
export const AI_INSIGHT_REASONS = [
  'kill_switch_on',
  'policy_denied',
  'budget_stop',
  'name_match_limit',
  'model_output_invalid',
  'provider_error',
  'provider_unavailable',
  'provider_offline',
  'audit_failed',
] as const;
export type AiInsightReason = (typeof AI_INSIGHT_REASONS)[number];

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
  /**
   * The score or the content comes from mock embeddings or a fixture, not from the real system (N5).
   * The web shows a `Demo` chip and no number, so `1.00` is never read as certainty.
   */
  mock: z.boolean().optional(),
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
  /** Language of the body (`th` or `en`). Absent on a draft written before T-108. */
  language: z.string().max(10).optional(),
  /** The text holds a placeholder that is not the customer's own, or is in another language: read it first. */
  needsReview: z.boolean().optional(),
  /** `restricted`: the contact is not verified, the disclosure policy removed `removedSentences`. */
  disclosure: z
    .object({
      level: z.enum(['verified', 'restricted']),
      removedSentences: z.number().int().min(0),
    })
    .optional(),
});
export type AiDraft = z.infer<typeof aiDraftSchema>;

/** The autonomy stage in force for the ticket's intent. Phase 1 renders 0 to 2 only (N3). */
export const aiStageSchema = z.number().int().min(0).max(4);

/**
 * Why the AI offers no customer reply on a ticket (T-147, QA-29): `no_outbound_channel` is a ticket on a
 * channel nothing is delivered on (internal, phone, walk-in, chat, other); `channel_not_connected` is a
 * channel whose account is missing or switched off. The web shows the reason where the A/E/R buttons would be.
 */
export const AI_REPLY_BLOCK_REASONS = ['no_outbound_channel', 'channel_not_connected'] as const;
export const aiReplyBlockReasonSchema = z.enum(AI_REPLY_BLOCK_REASONS);
export type AiReplyBlockReason = z.infer<typeof aiReplyBlockReasonSchema>;

/**
 * A priority the AI proposes for the ticket (T-147). It is a suggestion: a person accepts it, and only
 * then does the ticket change, through the same update as any edit (N2, N3).
 */
export const aiPrioritySuggestionSchema = z.object({
  priority: ticketPrioritySchema,
  /** Why, in the language of the ticket. */
  reason: z.string().max(300),
  /** 0 to 1. */
  confidence: z.number().min(0).max(1),
});
export type AiPrioritySuggestion = z.infer<typeof aiPrioritySuggestionSchema>;

/** The investigation report (T-108b): what the tools found, and what they could not. */
export const aiReportSchema = z.object({
  /** One claim, and the evidence cards it rests on. A finding with no evidence is shown as `Uncited`. */
  findings: z
    .array(
      z.object({ text: z.string().max(600), evidenceIds: z.array(z.string().max(100)).max(10) }),
    )
    .max(12),
  /**
   * The same findings in the one claim shape (T-135): each with the pages that support it, links
   * the viewer may open. Made when the brief is read, from the evidence cards of the ticket. A
   * finding no card supports is `uncited`.
   */
  claims: z.array(claimSchema).max(12).optional(),
  likelyCause: z.string().max(600).nullable(),
  confidence: z.number().min(0).max(1),
  openQuestions: z.array(z.string().max(300)).max(8),
  /** Which tools ran. A denied or failed one is listed, so a gap is visible. */
  tools: z
    .array(
      z.object({
        name: z.string().max(64),
        status: z.enum(['ok', 'error', 'denied']),
        mock: z.boolean(),
      }),
    )
    .max(20),
  promptVersion: z.string().max(40),
  /** The intent the tools were scoped to, and why it was trusted. Null: only the generic tools ran. */
  scope: z
    .object({
      intent: z.string().max(100).nullable(),
      basis: z.enum(['human_confirmed', 'confidence', 'none']),
    })
    .optional(),
  /** A proposed priority (T-147). Absent when the model had no view. */
  suggestedPriority: aiPrioritySuggestionSchema.optional(),
  /** Set when no customer reply is offered on this ticket, and why (T-147). */
  replyBlocked: aiReplyBlockReasonSchema.optional(),
});
export type AiReport = z.infer<typeof aiReportSchema>;

/** Where a running job is. Sent with the insight so the web can show a step, not a spinner. */
export const aiProgressSchema = z.object({
  phase: z.enum(['queued', 'investigating', 'drafting']),
  step: z.number().int().min(0),
  steps: z.number().int().min(1),
});
export type AiProgress = z.infer<typeof aiProgressSchema>;

export const ticketAiInsightSchema = z.object({
  state: aiStateSchema,
  /** Why the AI did not finish (`failed`) or did not read the ticket (`needs_human`); absent until the api sends it. */
  reasonCode: z.enum(AI_INSIGHT_REASONS).optional().catch(undefined),
  summary: z.string().max(1000).optional(),
  intent: z
    .object({
      key: z.string().max(100),
      /** The name of the intent, so the web shows it next to (not instead of) the key. Absent when the intent is gone. */
      name: z.string().max(200).optional(),
      /** 0 to 1. */
      confidence: z.number().min(0).max(1),
      reason: z.string().max(500),
    })
    .optional(),
  nextStep: z.object({ kind: aiNextStepKindSchema, label: z.string().max(120) }).optional(),
  evidence: z.array(aiEvidenceSchema),
  draft: aiDraftSchema.optional(),
  report: aiReportSchema.optional(),
  progress: aiProgressSchema.optional(),
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

/** Body of `POST /v1/tickets/:id/ai/requests`: ask for a draft (stage 1) or a fresh investigation. */
export const aiRequestSchema = z.object({
  kind: z.enum(['draft', 'investigate']),
  note: z.string().trim().max(500).optional(),
});
export type AiRequest = z.infer<typeof aiRequestSchema>;
