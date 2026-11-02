/**
 * AI assistant contract (T-134, ADR-017): the routes `/v1/assistant/*`.
 *
 * The assistant is the signed-in person's hands, not a user of its own. A read tool answers at once;
 * a write is a `ProposalCard` built from server values that the person presses once; a reply to a
 * customer is never written here, it opens the existing draft review (N3).
 */
import { z } from 'zod';

import { claimSchema } from './claims.js';

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
  'brief',
  'handoff',
  'dashboard',
  'kb',
  'incident',
  'other',
] as const;
export const assistantPageSchema = z.enum(ASSISTANT_PAGES);
export type AssistantPage = z.infer<typeof assistantPageSchema>;

export const ASSISTANT_LOCALES = ['th', 'en'] as const;
export const assistantLocaleSchema = z.enum(ASSISTANT_LOCALES);
export type AssistantLocale = z.infer<typeof assistantLocaleSchema>;

/** What the chips above the input send. The person removes a chip: it is not sent. No hidden context. */
export const assistantContextSchema = z.object({
  page: assistantPageSchema.optional(),
  /** A ticket id or number (`OPS-1234`) the person is looking at. Resolved with the person's own access. */
  ticket: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(
      (value) =>
        z.uuid().safeParse(value).success || /^[A-Za-z][A-Za-z0-9]{1,9}-\d{1,15}$/.test(value),
      { message: 'expected a ticket id or a ticket number such as OPS-1234' },
    )
    .optional(),
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
