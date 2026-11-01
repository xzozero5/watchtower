import { z } from 'zod';

import { ticketChannelSchema } from './channels.js';
import { csvList, cursorSchema, jsonRecordSchema, pageLimit, pageOf } from './common.js';
import { emailSchema } from './auth.js';
import { assertDisjoint } from './features/compose.js';
import { ticketAiRowSchema } from './features/ai.js';
import { FEATURES, FEATURE_TICKET_EVENTS } from './features/index.js';
import { deliverySummarySchema } from './features/outbound.js';
import { ticketSlaViewSchema } from './features/shifts.js';
import { slaStateSchema, ticketPrioritySchema } from './sla.js';

/**
 * HTTP contract of the ticket endpoints (PRD section 4.1) and the rules both sides share: the
 * status workflow, ticket numbers, and the shapes of tickets, messages and timeline entries.
 * apps/api validates and documents with these; apps/web imports the same schemas.
 */

// --- ticket number ---

/** Prefix of the human ticket number (`OPS-1234`) when an instance does not configure its own. */
export const DEFAULT_TICKET_KEY_PREFIX = 'OPS';

/**
 * A ticket number prefix: 2 to 10 upper-case letters or digits, starting with a letter. The api
 * reads it from `TICKET_KEY_PREFIX`. Changing it later renames future displays only: the number is
 * a database sequence, but keys already copied into event payloads or sent in emails keep the old
 * prefix.
 */
export const ticketKeyPrefixSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, 'expected 2 to 10 letters or digits, starting with a letter');

export function formatTicketKey(
  number: number | bigint,
  prefix: string = DEFAULT_TICKET_KEY_PREFIX,
): string {
  return `${prefix}-${String(number)}`;
}

/** `OPS-1234` (any case) to 1234; null when the text is not a key with this prefix. */
export function parseTicketKey(
  value: string,
  prefix: string = DEFAULT_TICKET_KEY_PREFIX,
): number | null {
  const text = value.trim();
  const dash = text.lastIndexOf('-');
  if (dash <= 0 || text.slice(0, dash).toUpperCase() !== prefix.toUpperCase()) return null;
  const digits = text.slice(dash + 1);
  if (!/^\d{1,15}$/.test(digits)) return null;
  const number = Number(digits);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** What any instance's ticket key looks like, whatever its prefix: the prefix is checked by the api. */
const TICKET_KEY_SHAPE = /^[A-Za-z][A-Za-z0-9]{1,9}-\d{1,15}$/;

/** A ticket addressed by its uuid or by its number (`OPS-1234`), as it appears in URLs. */
export const ticketRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => z.uuid().safeParse(value).success || TICKET_KEY_SHAPE.test(value), {
    message: 'expected a ticket id or a ticket number such as OPS-1234',
  });
export const ticketRefParamSchema = z.object({ id: ticketRefSchema });

// --- status workflow (R-1.2) ---

export const TICKET_STATUSES = [
  'new',
  'triage',
  'open',
  'waiting_on_customer',
  'waiting_on_dev',
  'resolved',
  'closed',
  'merged',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const ticketStatusSchema = z.enum(TICKET_STATUSES);

/** A status a person can move a ticket to. `merged` is reached only through the merge endpoint. */
export const SETTABLE_STATUSES = TICKET_STATUSES.filter((status) => status !== 'merged');

/** The SLA clock stops while a ticket is in one of these. */
export const SLA_PAUSED_STATUSES: readonly TicketStatus[] = ['waiting_on_customer'];

export const OPEN_STATUSES: readonly TicketStatus[] = [
  'new',
  'triage',
  'open',
  'waiting_on_customer',
  'waiting_on_dev',
];

/** A customer reply reopens a resolved ticket for this many days after it was resolved (R-1.10). */
export const REOPEN_WINDOW_DAYS = 7;

export interface StatusTransition {
  readonly from: TicketStatus;
  readonly to: TicketStatus;
}

/**
 * Transitions seeded by migration 0002 (`ticket_status_transition`). A head can change them
 * without a deploy (`PUT /v1/ticket-workflow`); an integration test keeps the seed equal to this.
 */
export const DEFAULT_STATUS_TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  new: ['triage', 'open', 'waiting_on_customer', 'resolved', 'closed'],
  triage: ['open', 'waiting_on_customer', 'waiting_on_dev', 'resolved', 'closed'],
  open: ['triage', 'waiting_on_customer', 'waiting_on_dev', 'resolved', 'closed'],
  waiting_on_customer: ['open', 'waiting_on_dev', 'resolved', 'closed'],
  waiting_on_dev: ['open', 'waiting_on_customer', 'resolved', 'closed'],
  resolved: ['open', 'closed'],
  closed: [],
  merged: [],
};

export function defaultTransitionList(): StatusTransition[] {
  return TICKET_STATUSES.flatMap((from) =>
    DEFAULT_STATUS_TRANSITIONS[from].map((to): StatusTransition => ({ from, to })),
  );
}

export const statusTransitionSchema = z.object({
  from: ticketStatusSchema,
  to: ticketStatusSchema,
});

export const workflowSchema = z.object({ transitions: z.array(statusTransitionSchema) });
export type Workflow = z.infer<typeof workflowSchema>;

export const setWorkflowSchema = z
  .object({ transitions: z.array(statusTransitionSchema).max(TICKET_STATUSES.length ** 2) })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, transition] of value.transitions.entries()) {
      const key = `${transition.from}>${transition.to}`;
      if (transition.from === transition.to) {
        context.addIssue({
          code: 'custom',
          message: 'a status cannot lead to itself',
          path: ['transitions', index],
        });
      }
      if (transition.from === 'merged' || transition.to === 'merged') {
        context.addIssue({
          code: 'custom',
          message: 'merged is only reached by merging a ticket and cannot be left',
          path: ['transitions', index],
        });
      }
      if (seen.has(key)) {
        context.addIssue({
          code: 'custom',
          message: 'duplicate transition',
          path: ['transitions', index],
        });
      }
      seen.add(key);
    }
  });
export type SetWorkflow = z.infer<typeof setWorkflowSchema>;

// --- tickets ---

export const MESSAGE_VISIBILITIES = ['public', 'internal'] as const;
export type MessageVisibility = (typeof MESSAGE_VISIBILITIES)[number];
export const messageVisibilitySchema = z.enum(MESSAGE_VISIBILITIES);

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound', 'internal'] as const;
export const messageDirectionSchema = z.enum(MESSAGE_DIRECTIONS);

/**
 * `scheduled`/`cancelled` are the undo-send states of ADR-010: a staff reply on Gmail or LINE waits
 * `scheduled` until the hold ends, then becomes `delivered` or `failed`; an undone one is `cancelled`.
 * `pending` stays for channels without a dispatcher (Discord, webhook).
 */
export const DELIVERY_STATUSES = [
  'not_applicable',
  'pending',
  'scheduled',
  'delivered',
  'failed',
  'cancelled',
] as const;
export const deliveryStatusSchema = z.enum(DELIVERY_STATUSES);
/**
 * A customer never sees a reply that has not reached them (ADR-010 section 2): one still waiting out
 * the undo window, one that was undone, or one that failed. Screens and queries for clients leave
 * these out.
 */
export const CLIENT_HIDDEN_DELIVERY_STATUSES = ['scheduled', 'cancelled', 'failed'] as const;

export const ASSIGNMENT_STRATEGIES = ['manual', 'round_robin'] as const;
export const assignmentStrategySchema = z.enum(ASSIGNMENT_STRATEGIES);

/** Types written to `ticket_event.type` by the core (Phase 0) features; Phase 1 features add theirs in `features/<feature>.ts`. */
export const CORE_TICKET_EVENT_TYPES = {
  created: 'ticket.created',
  updated: 'ticket.updated',
  statusChanged: 'ticket.status_changed',
  assigned: 'ticket.assigned',
  merged: 'ticket.merged',
  mergeReceived: 'ticket.merge_received',
  /** A ticket merged earlier now points at a new target because its own target was merged away. */
  reparented: 'ticket.reparented',
  reopened: 'ticket.reopened',
  slaPaused: 'sla.paused',
  slaResumed: 'sla.resumed',
  slaRecalculated: 'sla.recalculated',
} as const;

/** Types written to `ticket_event.type`: core plus every feature. */
export const TICKET_EVENT_TYPES = { ...CORE_TICKET_EVENT_TYPES, ...FEATURE_TICKET_EVENTS } as const;
assertDisjoint('TICKET_EVENT_TYPES', [
  CORE_TICKET_EVENT_TYPES,
  ...FEATURES.map((feature) => feature.ticketEvents),
]);
export type TicketEventType = (typeof TICKET_EVENT_TYPES)[keyof typeof TICKET_EVENT_TYPES];

export const ticketOrgRefSchema = z.object({ id: z.uuid(), name: z.string() });
export const ticketIntentRefSchema = z.object({ id: z.uuid(), key: z.string(), name: z.string() });
export const ticketUserRefSchema = z.object({ id: z.uuid(), name: z.string() });
export const ticketQueueRefSchema = z.object({ id: z.uuid(), name: z.string() });

/** A ticket as the queue shows it. The requester's address is not here; the detail has it. */
export const ticketSummarySchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  /** `OPS-1234`. */
  key: z.string(),
  subject: z.string(),
  status: ticketStatusSchema,
  priority: ticketPrioritySchema,
  channel: ticketChannelSchema,
  org: ticketOrgRefSchema,
  requester: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  intent: ticketIntentRefSchema.nullable(),
  assignee: ticketUserRefSchema.nullable(),
  queue: ticketQueueRefSchema.nullable(),
  slaPolicyId: z.uuid().nullable(),
  firstResponseDueAt: z.iso.datetime().nullable(),
  resolutionDueAt: z.iso.datetime().nullable(),
  /** Set while the SLA clock is stopped (`waiting_on_customer`). */
  slaPausedAt: z.iso.datetime().nullable(),
  firstRespondedAt: z.iso.datetime().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
  /** The ticket this one was merged into, if any. */
  parentTicketId: z.uuid().nullable(),
  mergedIntoKey: z.string().nullable(),
  tags: z.array(z.string()),
  customFields: jsonRecordSchema,
  autonomyStageAtCreation: z.number().int().nullable(),
  aiHandled: z.boolean(),
  reopenCount: z.number().int(),
  csatScore: z.number().int().nullable(),
  /** What the AI has done with the ticket (T-128). Absent until the api serves it. */
  ai: ticketAiRowSchema.optional(),
  /**
   * The running SLA target and the time left on it, counted by the server on the policy's own
   * calendar (T-111e). Absent when no target runs (resolved, closed, no policy).
   */
  sla: ticketSlaViewSchema.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TicketSummary = z.infer<typeof ticketSummarySchema>;

export const ticketDetailSchema = ticketSummarySchema.extend({
  requester: z.object({ id: z.uuid(), name: z.string(), email: z.string().nullable() }).nullable(),
  /** Tickets merged into this one. */
  mergedTickets: z.array(z.object({ id: z.uuid(), key: z.string(), subject: z.string() })),
});
export type TicketDetail = z.infer<typeof ticketDetailSchema>;

/** What a client sees of a ticket of their own organization: nothing internal. */
export const clientTicketSchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  key: z.string(),
  subject: z.string(),
  status: ticketStatusSchema,
  priority: ticketPrioritySchema,
  intent: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  requesterName: z.string().nullable(),
  mergedIntoKey: z.string().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ClientTicket = z.infer<typeof clientTicketSchema>;

export const ticketListSchema = pageOf(z.union([ticketSummarySchema, clientTicketSchema]));
export const ticketDetailResponseSchema = z.union([ticketDetailSchema, clientTicketSchema]);

/** A new ticket may duplicate one of the same intent filed in this window (R-1.5). */
export const DUPLICATE_WINDOW_HOURS = 72;
export const DUPLICATE_SUGGESTION_LIMIT = 10;

/** Open tickets of the same organization and intent that this ticket may duplicate, newest first. */
export const duplicateSuggestionsSchema = z.object({
  items: z.array(z.union([ticketSummarySchema, clientTicketSchema])),
});
export type DuplicateSuggestions = z.infer<typeof duplicateSuggestionsSchema>;

/**
 * `due_asc` sorts by the first-response due time (kept for existing callers). `sla_due_asc` sorts by
 * the due time of the target that is running now (first response until the ticket is answered, then
 * resolution), tickets with no running target last. `created_asc` is oldest first.
 */
export const TICKET_SORTS = [
  'created_desc',
  'updated_desc',
  'due_asc',
  'created_asc',
  'sla_due_asc',
] as const;
export const ticketSortSchema = z.enum(TICKET_SORTS);

/**
 * Shortest free-text search. Two, not three, because many Thai words are two characters; a query
 * under 3 characters has no trigram and therefore cannot use the `pg_trgm` index, so Postgres scans
 * the rows that the other filters leave (fine for one organization, slow across the whole table).
 */
export const MIN_SEARCH_LENGTH = 2;

export const ticketListQuerySchema = z.object({
  status: csvList(ticketStatusSchema),
  priority: csvList(ticketPrioritySchema),
  /** A user id, `me`, or `unassigned`. Ignored for clients (they have no assignee). */
  assignee: z.union([z.uuid(), z.literal('me'), z.literal('unassigned')]).optional(),
  queueId: z.uuid().optional(),
  /** Staff only; a client is always limited to their own organization. */
  orgId: z.uuid().optional(),
  intentId: z.uuid().optional(),
  channel: ticketChannelSchema.optional(),
  tag: z.string().trim().min(1).max(64).optional(),
  /** Free text over the subject and the visible messages, and an exact ticket number. */
  q: z.string().trim().min(MIN_SEARCH_LENGTH).max(200).optional(),
  /** Only open tickets that are past a first-response or resolution due time. */
  overdue: z.stringbool().optional(),
  /**
   * Only tickets whose running SLA target is in one of these states (staff only; computed on the
   * server, UI spec 17 Q9). `at_risk` and `ok` are measured in business time; tickets with no
   * running target (not open, or no due date) match none of them.
   */
  slaState: csvList(slaStateSchema),
  sort: ticketSortSchema.default('created_desc'),
  limit: pageLimit(50, 200),
  cursor: cursorSchema.optional(),
});
export type TicketListQuery = z.infer<typeof ticketListQuerySchema>;

/** Counts take the same filters as the list; paging and sorting mean nothing for a count. */
export const ticketStatsQuerySchema = ticketListQuerySchema.omit({
  sort: true,
  limit: true,
  cursor: true,
});
export type TicketStatsQuery = z.infer<typeof ticketStatsQuerySchema>;

/** Tickets per SLA state; a ticket with no running target is in none of them. */
export const slaCountsSchema = z.object({
  ok: z.number().int().min(0),
  at_risk: z.number().int().min(0),
  breached: z.number().int().min(0),
  paused: z.number().int().min(0),
});
export type SlaCounts = z.infer<typeof slaCountsSchema>;

/** The numbers every group carries: all tickets, the open ones, and the SLA state of those. */
export const ticketStatsBucketSchema = z.object({
  /** Tickets in the group, whatever their status (after the filters). */
  count: z.number().int().min(0),
  /** Of those, tickets in an open status (`OPEN_STATUSES`). */
  open: z.number().int().min(0),
  sla: slaCountsSchema,
});
export type TicketStatsBucket = z.infer<typeof ticketStatsBucketSchema>;

export const ticketStatsSchema = z.object({
  generatedAt: z.iso.datetime(),
  total: ticketStatsBucketSchema,
  /** Groups with no ticket are left out. In workflow order. */
  byStatus: z.array(ticketStatsBucketSchema.extend({ status: ticketStatusSchema })),
  /** `queueId: null` = tickets in no queue. Largest group first. */
  byQueue: z.array(ticketStatsBucketSchema.extend({ queueId: z.uuid().nullable() })),
  /** `assigneeId: null` = unassigned. Largest group first. */
  byAssignee: z.array(ticketStatsBucketSchema.extend({ assigneeId: z.uuid().nullable() })),
  /** P1 to P4. */
  byPriority: z.array(ticketStatsBucketSchema.extend({ priority: ticketPrioritySchema })),
});
export type TicketStats = z.infer<typeof ticketStatsSchema>;

const tagSchema = z.string().trim().min(1).max(64);
export const ticketTagsSchema = z.array(tagSchema).max(30);

export const createTicketSchema = z.object({
  /** Required for staff. A client's ticket always belongs to their own organization. */
  orgId: z.uuid().optional(),
  subject: z.string().trim().min(1).max(300),
  /** The first message of the ticket, as the customer would have written it. */
  body: z.string().trim().min(1).max(20_000),
  /** Staff: who is asking, by contact id or by address (a contact is created if the address is new). */
  requesterContactId: z.uuid().optional(),
  requester: z.object({ email: emailSchema, name: z.string().trim().min(1).max(200) }).optional(),
  intentId: z.uuid().optional(),
  intentKey: z.string().trim().min(1).max(64).optional(),
  priority: ticketPrioritySchema.optional(),
  queueId: z.uuid().optional(),
  assigneeId: z.uuid().optional(),
  tags: ticketTagsSchema.optional(),
  customFields: jsonRecordSchema.optional(),
});
export type CreateTicket = z.infer<typeof createTicketSchema>;

export const updateTicketSchema = z
  .object({
    subject: z.string().trim().min(1).max(300).optional(),
    priority: ticketPrioritySchema.optional(),
    intentId: z.uuid().nullable().optional(),
    queueId: z.uuid().nullable().optional(),
    tags: ticketTagsSchema.optional(),
    customFields: jsonRecordSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'nothing to update' });
export type UpdateTicket = z.infer<typeof updateTicketSchema>;

export const changeStatusSchema = z.object({
  status: ticketStatusSchema,
  reason: z.string().trim().min(1).max(500).optional(),
});
export type ChangeStatus = z.infer<typeof changeStatusSchema>;

export const assignTicketSchema = z
  .object({
    /** A staff user id, or null to unassign. */
    assigneeId: z.uuid().nullable().optional(),
    /**
     * Pick a member of the ticket's queue (or of `queueId`) who is clocked in: the next in turn
     * (`round_robin`), the one with the fewest open tickets (`load_balanced`), or whoever handled
     * the requester's last ticket (`stay_with_last_handler`, falling back to load) (R-1.7).
     */
    strategy: z.enum(['round_robin', 'load_balanced', 'stay_with_last_handler']).optional(),
    queueId: z.uuid().optional(),
  })
  .refine((value) => (value.assigneeId !== undefined) !== (value.strategy !== undefined), {
    message: 'give either assigneeId or strategy',
  });
export type AssignTicket = z.infer<typeof assignTicketSchema>;

export const mergeTicketSchema = z.object({
  /** The ticket that stays; the ticket in the URL is merged into it. */
  intoTicketId: ticketRefSchema,
  reason: z.string().trim().min(1).max(500).optional(),
});
export type MergeTicket = z.infer<typeof mergeTicketSchema>;

export const replySchema = z.object({
  body: z.string().trim().min(1).max(20_000),
  /** "Reply and set status" (R-1.4). Staff only; checked against the workflow. */
  setStatus: ticketStatusSchema.optional(),
  /**
   * Staff only: the AI draft this reply sends. The body must be exactly the draft (its content hash
   * is compared); sending it records the sender as the approver (N3, ADR-011 A-2). Without it the
   * reply is the sender's own text.
   */
  aiDraftId: z.uuid().optional(),
});
export type Reply = z.infer<typeof replySchema>;

export const noteSchema = z.object({ body: z.string().trim().min(1).max(20_000) });
export type Note = z.infer<typeof noteSchema>;

export const messageSenderSchema = z.object({
  type: z.enum(['contact', 'user', 'system']),
  id: z.uuid().nullable(),
  name: z.string().nullable(),
});

export const messageSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  ticketKey: z.string(),
  channel: ticketChannelSchema,
  direction: messageDirectionSchema,
  visibility: messageVisibilitySchema,
  sender: messageSenderSchema,
  bodyText: z.string(),
  deliveryStatus: deliveryStatusSchema,
  /** Staff only, outbound replies on Gmail or LINE: the delivery behind `deliveryStatus` (Undo, Retry). */
  delivery: deliverySummarySchema.nullable().optional(),
  attachments: z.array(jsonRecordSchema),
  createdAt: z.iso.datetime(),
});
export type Message = z.infer<typeof messageSchema>;

export const timelineEventSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  ticketKey: z.string(),
  type: z.string(),
  actor: z.object({
    type: z.enum(['user', 'system', 'ai', 'anonymous']),
    id: z.string().nullable(),
    name: z.string().nullable(),
  }),
  visibility: messageVisibilitySchema,
  payload: jsonRecordSchema,
  createdAt: z.iso.datetime(),
});

export const timelineEntrySchema = z.discriminatedUnion('kind', [
  messageSchema.extend({ kind: z.literal('message') }),
  timelineEventSchema.extend({ kind: z.literal('event') }),
]);
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

export const timelineQuerySchema = z.object({
  /** Include the history of tickets merged into this one (default yes). */
  includeMerged: z.stringbool().default(true),
  limit: pageLimit(100, 500),
  cursor: cursorSchema.optional(),
});
export type TimelineQuery = z.infer<typeof timelineQuerySchema>;

export const timelinePageSchema = z.object({
  entries: z.array(timelineEntrySchema),
  nextCursor: z.string().nullable(),
});

export const mergeResultSchema = z.object({
  source: ticketDetailSchema,
  target: ticketDetailSchema,
});

export const replyResultSchema = z.object({
  message: messageSchema,
  ticket: z.union([ticketDetailSchema, clientTicketSchema]),
});
