/**
 * AI assistant contract (T-134, ADR-023): the routes `/v1/assistant/*`.
 *
 * The assistant is the signed-in person's hands, not a user of its own. A read tool answers at once;
 * a write is a `ProposalCard` built from server values that the person presses once; a reply to a
 * customer is never written here, it opens the existing draft review (N3).
 */
import { z } from 'zod';

import { claimHrefSchema, claimSchema } from './claims.js';

/** `[ASSUMED]` limits. The first three can be overridden by environment (see `config.ts`). */
export const ASSISTANT_LIMITS = {
  messagesPerHour: 30,
  userDailyTokens: 200_000,
  retentionDays: 30,
  /** Characters of one message from the person. */
  maxTextChars: 2000,
  /** Tool calls the model may ask for in one message. */
  maxToolCalls: 4,
  /** Proposals one message may leave on the screen. */
  maxProposals: 3,
  /** Earlier turns sent back to the model. */
  historyTurns: 6,
  /** Claims in one answer (design section 2.5: at most five bullets). */
  maxClaims: 5,
  proposalTtlMinutes: 10,
} as const;

export const ASSISTANT_PAGES = [
  'queue',
  'ticket',
  'conversations',
  'incident',
  'alert',
  'statuspage',
  'kb',
  'shift',
  'brief',
  'handoff',
  'roster',
  'dashboard',
  'reports',
  'autonomy',
  'admin',
  'other',
] as const;
export const assistantPageSchema = z.enum(ASSISTANT_PAGES);
export type AssistantPage = z.infer<typeof assistantPageSchema>;

export const ASSISTANT_LOCALES = ['th', 'en'] as const;
export const assistantLocaleSchema = z.enum(ASSISTANT_LOCALES);
export type AssistantLocale = z.infer<typeof assistantLocaleSchema>;

/** What a chip can point at (ADR-029 section 1). Every kind is resolved with the reader of its own module. */
export const ASSISTANT_ENTITY_KINDS = [
  'ticket',
  'conversation',
  'incident',
  'alert',
  'kb_article',
  'handoff',
  'intent',
  'org',
  'service',
] as const;
export const assistantEntityKindSchema = z.enum(ASSISTANT_ENTITY_KINDS);
export type AssistantEntityKind = z.infer<typeof assistantEntityKindSchema>;

/** An id, a number (`OPS-1234`) or a slug. A hint only: the server resolves it with the caller's own access. */
export const assistantEntityRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'expected an id, a number or a slug');

/** Chips picked on a list; the server keeps the ones the person may read (ADR-029 section 1). */
export const ASSISTANT_MAX_SELECTION = 20;

export const assistantEntitySchema = z.object({
  kind: assistantEntityKindSchema,
  ref: assistantEntityRefSchema,
});
export type AssistantEntity = z.infer<typeof assistantEntitySchema>;

export const assistantSelectionSchema = z.object({
  kind: assistantEntityKindSchema,
  refs: z.array(assistantEntityRefSchema).min(1).max(ASSISTANT_MAX_SELECTION),
});
export type AssistantSelection = z.infer<typeof assistantSelectionSchema>;

/** The element an "Ask AI about this" button sits on (ADR-029 section 9.3). `scope`: `instance`, `user` or `org:<id>`. */
export const assistantElementSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(
      /^[a-z][a-z0-9_]*(\.[a-z0-9_*]+)*$/,
      'expected an element key such as dashboard.ops.sla',
    ),
  scope: z.string().regex(/^(instance|user|[a-z_]{1,24}:[A-Za-z0-9-]{1,64})$/),
  /** `d7`, `d30` ... days. */
  period: z
    .string()
    .regex(/^d\d{1,3}$/)
    .optional(),
});
export type AssistantElement = z.infer<typeof assistantElementSchema>;

/** The `ticket` of the first release: an id or a ticket number such as `OPS-1234`. */
export const assistantTicketRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (value) =>
      z.uuid().safeParse(value).success || /^[A-Za-z][A-Za-z0-9]{1,9}-\d{1,15}$/.test(value),
    { message: 'expected a ticket id or a ticket number such as OPS-1234' },
  );

/** What the chips above the input send. The person removes a chip: it is not sent. No hidden context. */
export const assistantContextSchema = z.object({
  page: assistantPageSchema.optional(),
  /** A ticket id or number (`OPS-1234`) the person is looking at. Same as `entity: { kind: 'ticket' }`. */
  ticket: assistantTicketRefSchema.optional(),
  entity: assistantEntitySchema.optional(),
  selection: assistantSelectionSchema.optional(),
  element: assistantElementSchema.optional(),
});
export type AssistantContext = z.infer<typeof assistantContextSchema>;

export const assistantMessageRequestSchema = z.object({
  text: z.string().trim().min(1).max(ASSISTANT_LIMITS.maxTextChars),
  /** Omit to start a new conversation. Someone else's conversation is a 404. */
  conversationId: z.uuid().optional(),
  /** The language of the app. Absent: the language of `text`. */
  locale: assistantLocaleSchema.optional(),
  context: assistantContextSchema.optional(),
});
export type AssistantMessageRequest = z.infer<typeof assistantMessageRequestSchema>;

/**
 * `ok`: answered. `paused`: the kill switch is on. `budget`: the AI budget of the day (or of this
 * person) is used up. `unavailable`: no provider is wired. The web closes the input in the last three.
 */
export const ASSISTANT_STATES = ['ok', 'paused', 'budget', 'unavailable'] as const;
export const assistantStateSchema = z.enum(ASSISTANT_STATES);
export type AssistantState = z.infer<typeof assistantStateSchema>;

export const assistantToolRunSchema = z.object({
  name: z.string().max(64),
  status: z.enum(['ok', 'error', 'denied']),
  /** The tool answered from a fake or a sandbox. */
  mock: z.boolean(),
});
export type AssistantToolRun = z.infer<typeof assistantToolRunSchema>;

// --- proposals -------------------------------------------------------------------------------------

export const PROPOSAL_KINDS = [
  'assign',
  'status',
  'tag',
  'note',
  'create_ticket',
  'kb_draft',
  'reply_draft',
] as const;
export const proposalKindSchema = z.enum(PROPOSAL_KINDS);
export type ProposalKind = z.infer<typeof proposalKindSchema>;

export const PROPOSAL_STATUSES = ['pending', 'confirmed', 'rejected', 'expired', 'failed'] as const;
export const proposalStatusSchema = z.enum(PROPOSAL_STATUSES);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

export const proposalChangeSchema = z.object({
  /** A stable key the web turns into an icon and a word: `assignee`, `status`, `tags`, `subject`, `priority`. */
  field: z.string().max(40),
  /** The value now, read by the server; null when there is none. */
  from: z.string().max(300).nullable(),
  /** The value after the press. */
  to: z.string().max(300).nullable(),
});
export type ProposalChange = z.infer<typeof proposalChangeSchema>;

/**
 * Everything on the card comes from the server. The model contributed only the intent (which kind,
 * which ticket, which value) and, for `note` / `kb_draft`, the text a person reads before pressing.
 */
export const proposalCardSchema = z.object({
  id: z.uuid(),
  kind: proposalKindSchema,
  status: proposalStatusSchema,
  /** The thing acted on. Null for `create_ticket` and `kb_draft`, which make a new one. */
  target: z
    .object({ key: z.string().max(80), label: z.string().max(300), href: z.string().max(500) })
    .nullable(),
  changes: z.array(proposalChangeSchema).max(12),
  /** The note, the article body or the instruction for the draft: shown in full before the press. */
  text: z.string().max(20_000).optional(),
  expiresAt: z.iso.datetime(),
});
export type ProposalCard = z.infer<typeof proposalCardSchema>;

export const assistantReplySchema = z.object({
  /** Present on stage-1 replies; older persisted replies may omit these fields. */
  path: z.enum(['facts_only', 'llm1', 'llm2']).optional(),
  hadCustomerContent: z.boolean().optional(),
  conversationId: z.uuid(),
  messageId: z.uuid(),
  state: assistantStateSchema,
  /** A stable reason when `state` is not `ok` (`kill_switch_on`, `budget_stop`, `provider_unavailable` ...). */
  reason: z.string().max(60).nullable(),
  locale: assistantLocaleSchema,
  claims: z.array(claimSchema).max(ASSISTANT_LIMITS.maxClaims),
  tools: z.array(assistantToolRunSchema).max(ASSISTANT_LIMITS.maxToolCalls + 4),
  proposals: z.array(proposalCardSchema).max(ASSISTANT_LIMITS.maxProposals),
});
export type AssistantReply = z.infer<typeof assistantReplySchema>;

export const proposalParamSchema = z.object({ id: z.uuid() });
export type ProposalParam = z.infer<typeof proposalParamSchema>;

export const conversationParamSchema = z.object({ id: z.uuid() });
export type ConversationParam = z.infer<typeof conversationParamSchema>;

/**
 * `done`: it ran, `result.href` is where to look. `stale`: the target changed after the card was
 * made, nothing ran, and `proposal` shows the current values with status `expired`.
 */
export const confirmProposalResponseSchema = z.object({
  outcome: z.enum(['done', 'stale']),
  proposal: proposalCardSchema,
  result: z
    .object({ key: z.string().max(80).nullable(), href: z.string().max(500).nullable() })
    .nullable(),
});
export type ConfirmProposalResponse = z.infer<typeof confirmProposalResponseSchema>;

export const rejectProposalResponseSchema = z.object({ proposal: proposalCardSchema });
export type RejectProposalResponse = z.infer<typeof rejectProposalResponseSchema>;

export const deleteConversationResponseSchema = z.object({ deleted: z.literal(true) });

// --- starters --------------------------------------------------------------------------------------

export const assistantStartersQuerySchema = z.object({
  locale: assistantLocaleSchema.default('en'),
  /** Where the person is. */
  page: assistantPageSchema.optional(),
  /** Set when a ticket chip is on: prompts about "this" ticket appear only then. */
  ticket: assistantContextSchema.shape.ticket,
});
export type AssistantStartersQuery = z.infer<typeof assistantStartersQuerySchema>;

export const assistantStarterSchema = z.object({
  /** Stable, for analytics and tests. */
  id: z.string().max(40),
  /** The text to put in the input, in the asked language. */
  text: z.string().max(200),
});
export type AssistantStarter = z.infer<typeof assistantStarterSchema>;

export const assistantStartersSchema = z.object({
  state: assistantStateSchema,
  reason: z.string().max(60).nullable(),
  /** At most three. Prompts the person has no permission for are not offered. */
  starters: z.array(assistantStarterSchema).max(3),
  limits: z.object({
    messagesPerHour: z.number().int().positive(),
    remainingThisHour: z.number().int().min(0),
  }),
});
export type AssistantStarters = z.infer<typeof assistantStartersSchema>;

// --- phase events (SSE, ADR-029 section 4) -------------------------------------------------------------

/**
 * `POST /v1/assistant/messages` with `Accept: text/event-stream` answers with these events in order:
 * `queued`, `context`, any number of `tool`, `answering`, then `reply` or `error`. Phases, not tokens: the reply
 * is checked (citations, links, masking) before anybody sees a word of it.
 */
export const ASSISTANT_PHASES = [
  'queued',
  'context',
  'tool',
  'answering',
  'reply',
  'error',
] as const;
export const assistantPhaseSchema = z.enum(ASSISTANT_PHASES);
export type AssistantPhase = z.infer<typeof assistantPhaseSchema>;

/** One ref of the context: it is a chip (`resolved`) or it was left out (`dropped`, which never says why). */
export const assistantContextChipSchema = z.object({
  kind: assistantEntityKindSchema,
  /** Present only when resolved. */
  label: z.string().max(200).optional(),
  href: claimHrefSchema.optional(),
  status: z.enum(['resolved', 'dropped']),
});
export type AssistantContextChip = z.infer<typeof assistantContextChipSchema>;

export const assistantPhaseEventSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('queued'), position: z.number().int().min(0).max(100) }),
  z.object({
    phase: z.literal('context'),
    chips: z.array(assistantContextChipSchema).max(ASSISTANT_MAX_SELECTION + 2),
  }),
  z.object({
    phase: z.literal('tool'),
    name: z.string().max(64),
    status: z.enum(['running', 'ok', 'error', 'denied']),
  }),
  z.object({ phase: z.literal('answering') }),
  z.object({ phase: z.literal('reply'), reply: assistantReplySchema }),
  z.object({
    phase: z.literal('error'),
    state: assistantStateSchema,
    /** A stable code (`assistant_queue_full`, `assistant_busy`, `kill_switch_on` ...). */
    reason: z.string().max(60),
  }),
]);
export type AssistantPhaseEvent = z.infer<typeof assistantPhaseEventSchema>;

// --- memory (ADR-029 section 3) --------------------------------------------------------------------------

export const ASSISTANT_MEMORY_LIMITS = {
  maxBodyChars: 300,
  maxRefs: 5,
  /** Rows one person may keep. */
  maxPerUser: 20,
  /** Rows put in a prompt. */
  maxInPrompt: 10,
  /** Days after `created_at` (use does not extend it, T-400 C-7). `[ASSUMED]` */
  ttlDays: 90,
} as const;

export const assistantMemoryRefSchema = z.object({
  kind: assistantEntityKindSchema,
  id: z.string().min(1).max(64),
});
export type AssistantMemoryRef = z.infer<typeof assistantMemoryRefSchema>;

/**
 * The one way to make a memory in stage 1 (T-400 C-7): press "remember" on a claim of an answer. The server takes the
 * text from the redacted text of that turn and the refs from its evidence; nothing the person types is stored, so
 * there is no body here. A memory typed by hand is not in stage 1.
 */
export const createAssistantMemorySchema = z.object({
  messageId: z.uuid(),
  /** Which claim of that answer (0-based). */
  claim: z
    .number()
    .int()
    .min(0)
    .max(ASSISTANT_LIMITS.maxClaims - 1),
});
export type CreateAssistantMemory = z.infer<typeof createAssistantMemorySchema>;

export const assistantMemorySchema = z.object({
  /** False means an unavailable tombstone: empty body and refs, retained for Forget/Clear. */
  available: z.boolean().optional(),
  id: z.uuid(),
  body: z.string().max(ASSISTANT_MEMORY_LIMITS.maxBodyChars),
  refs: z.array(assistantMemoryRefSchema).max(ASSISTANT_MEMORY_LIMITS.maxRefs),
  sourceMessageId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type AssistantMemory = z.infer<typeof assistantMemorySchema>;

export const assistantMemoryListSchema = z.object({
  items: z.array(assistantMemorySchema).max(ASSISTANT_MEMORY_LIMITS.maxPerUser),
});
export type AssistantMemoryList = z.infer<typeof assistantMemoryListSchema>;

export const assistantMemoryParamSchema = z.object({ id: z.uuid() });
export type AssistantMemoryParam = z.infer<typeof assistantMemoryParamSchema>;

export const deleteAssistantMemoryResponseSchema = z.object({ deleted: z.literal(true) });

/** `deleted` is how many rows of the person's own went. */
export const clearAssistantMemoryResponseSchema = z.object({
  deleted: z.number().int().min(0),
});

// --- conversations (own only) ------------------------------------------------------------------------------

/** Newest first. */
export const ASSISTANT_CONVERSATION_LIST_LIMIT = 50;

export const assistantConversationSummarySchema = z.object({
  id: z.uuid(),
  locale: assistantLocaleSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Turns of the person and of the assistant. */
  messageCount: z.number().int().min(0),
  /**
   * The first thing the person asked, as it is stored: redacted (N4), so a name or an address appears as a
   * placeholder such as `[PERSON_1]`. Null when there is no message left. At most 120 characters.
   */
  preview: z.string().max(120).nullable(),
});
export type AssistantConversationSummary = z.infer<typeof assistantConversationSummarySchema>;

export const assistantConversationListSchema = z.object({
  items: z.array(assistantConversationSummarySchema).max(ASSISTANT_CONVERSATION_LIST_LIMIT),
});
export type AssistantConversationList = z.infer<typeof assistantConversationListSchema>;

// --- feedback (ADR-029 sections 5 and 9.6) -------------------------------------------------------------------

/** Why a 👎. One list for a reply of the assistant and for an embedded insight; `judges_person` feeds the section 9.9 review. */
export const ASSISTANT_FEEDBACK_REASONS = [
  'wrong_number',
  'not_useful',
  'misleading',
  'judges_person',
  'other',
] as const;
export const assistantFeedbackReasonSchema = z.enum(ASSISTANT_FEEDBACK_REASONS);
export type AssistantFeedbackReason = z.infer<typeof assistantFeedbackReasonSchema>;

/**
 * What the feedback is about: `message` is an answer of the assistant to this person; `insight` is an
 * `ai_element_insight` row the person can see (section 9.3; one they cannot see is a 404 like one that does not exist).
 */
export const assistantFeedbackTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), id: z.uuid() }),
  z.object({ kind: z.literal('insight'), id: z.uuid() }),
]);
export type AssistantFeedbackTarget = z.infer<typeof assistantFeedbackTargetSchema>;

export const assistantFeedbackRequestSchema = z
  .object({
    target: assistantFeedbackTargetSchema,
    rating: z.enum(['up', 'down']),
    /** A reason goes with a 👎 only. */
    reason: assistantFeedbackReasonSchema.optional(),
  })
  .refine((value) => value.reason === undefined || value.rating === 'down', {
    message: 'a reason goes with a thumbs-down only',
    path: ['reason'],
  });
export type AssistantFeedbackRequest = z.infer<typeof assistantFeedbackRequestSchema>;

/** One row per person and target: pressing again replaces the earlier rating. */
export const assistantFeedbackSchema = z.object({
  id: z.uuid(),
  target: assistantFeedbackTargetSchema,
  rating: z.enum(['up', 'down']),
  reason: assistantFeedbackReasonSchema.nullable(),
  updatedAt: z.iso.datetime(),
});
export type AssistantFeedback = z.infer<typeof assistantFeedbackSchema>;
