import { z } from 'zod';

import { channelTypeSchema } from './channels.js';
import { slaStateSchema, ticketPrioritySchema } from './sla.js';
import {
  OPEN_STATUSES,
  ticketRefSchema,
  ticketSortSchema,
  ticketStatusSchema,
  type TicketListQuery,
} from './ticketing.js';

/**
 * HTTP contract of saved views, bulk actions and linked tickets (T-119, PRD R-1.1, R-1.8, UI spec
 * section 4.2). apps/api validates and documents with these; apps/web imports the same schemas.
 */

// --- saved views ---

/**
 * The filters a view keeps: the same names as the ticket list query, but already parsed (arrays and
 * booleans, not `a,b` text). `assignee: "me"` means whoever opens the view, which is what makes a
 * shared "My queue" style view work for everybody. Unknown keys are refused so a view cannot carry
 * something the list does not understand.
 */
export const savedViewFiltersSchema = z
  .object({
    status: z.array(ticketStatusSchema).min(1).max(8).optional(),
    priority: z.array(ticketPrioritySchema).min(1).max(4).optional(),
    assignee: z.union([z.uuid(), z.literal('me'), z.literal('unassigned')]).optional(),
    queueId: z.uuid().optional(),
    orgId: z.uuid().optional(),
    intentId: z.uuid().optional(),
    channel: channelTypeSchema.optional(),
    tag: z.string().trim().min(1).max(64).optional(),
    q: z.string().trim().min(2).max(200).optional(),
    overdue: z.boolean().optional(),
    slaState: z.array(slaStateSchema).min(1).max(4).optional(),
  })
  .strict();
export type SavedViewFilters = z.infer<typeof savedViewFiltersSchema>;

/** The built-in views (UI spec 4.2); they cannot be edited and need no row. `Alerts` and `Other mail` are not ticket filters. */
export const SYSTEM_VIEW_KEYS = [
  'my_queue',
  'unassigned',
  'sla_at_risk',
  'triage',
  'waiting_on_customer',
  'all_open',
] as const;
export type SystemViewKey = (typeof SYSTEM_VIEW_KEYS)[number];
export const systemViewKeySchema = z.enum(SYSTEM_VIEW_KEYS);

export const SYSTEM_VIEW_ID_PREFIX = 'system:';

interface SystemViewDefinition {
  readonly name: string;
  readonly filters: SavedViewFilters;
  readonly sort: TicketListQuery['sort'];
}

/**
 * What each built-in view filters and how it sorts `[ASSUMED]` (UI spec 4.2: default sort is SLA
 * first). `sla_at_risk` includes tickets already breached: the person who wants the ones about to
 * go over also wants the ones that did, most urgent first. `triage` is the `triage` status, the
 * place the classifier puts anything it is not sure about (PRD 5.1 step 3).
 */
export const SYSTEM_VIEWS: Readonly<Record<SystemViewKey, SystemViewDefinition>> = {
  my_queue: {
    name: 'My queue',
    filters: { assignee: 'me', status: [...OPEN_STATUSES] },
    sort: 'sla_due_asc',
  },
  unassigned: {
    name: 'Unassigned',
    filters: { assignee: 'unassigned', status: [...OPEN_STATUSES] },
    sort: 'sla_due_asc',
  },
  sla_at_risk: {
    name: 'SLA at risk',
    filters: { status: [...OPEN_STATUSES], slaState: ['at_risk', 'breached'] },
    sort: 'sla_due_asc',
  },
  triage: { name: 'Triage', filters: { status: ['triage'] }, sort: 'created_asc' },
  waiting_on_customer: {
    name: 'Waiting on customer',
    filters: { status: ['waiting_on_customer'] },
    sort: 'created_asc',
  },
  all_open: { name: 'All open', filters: { status: [...OPEN_STATUSES] }, sort: 'sla_due_asc' },
};

export const VIEW_KINDS = ['system', 'shared', 'personal'] as const;
export const viewKindSchema = z.enum(VIEW_KINDS);

export const MAX_PERSONAL_VIEWS = 50;
export const viewNameSchema = z.string().trim().min(1).max(80);

export const savedViewSchema = z.object({
  /** A uuid, or `system:<key>` for a built-in view. */
  id: z.string(),
  kind: viewKindSchema,
  /** The key of a built-in view (the web translates it); null for a view somebody saved. */
  key: systemViewKeySchema.nullable(),
  /** English name of a built-in view; the name somebody gave a saved one. */
  name: z.string(),
  filters: savedViewFiltersSchema,
  sort: ticketSortSchema,
  /** Null for a built-in view. */
  ownerId: z.uuid().nullable(),
  ownerName: z.string().nullable(),
  /** Tickets the view matches for the person asking right now; null when counting was switched off. */
  count: z.number().int().min(0).nullable(),
  /** Whether the caller may edit or delete it. */
  editable: z.boolean(),
  createdAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime().nullable(),
});
export type SavedView = z.infer<typeof savedViewSchema>;

export const viewListQuerySchema = z.object({
  /** `false` skips the counts (cheaper). Default true. */
  counts: z.stringbool().default(true),
});
export type ViewListQuery = z.infer<typeof viewListQuerySchema>;

/** A view in a URL: a uuid, or `system:<key>` (which the api answers with 409, not 400). */
export const viewIdParamSchema = z.object({ id: z.string().min(1).max(64) });
export type ViewIdParam = z.infer<typeof viewIdParamSchema>;

export const savedViewListSchema = z.object({ items: z.array(savedViewSchema) });
export type SavedViewList = z.infer<typeof savedViewListSchema>;

export const createSavedViewSchema = z.object({
  name: viewNameSchema,
  filters: savedViewFiltersSchema,
  sort: ticketSortSchema.default('sla_due_asc'),
  /** Share it with the team. Needs the `view.share` permission. */
  shared: z.boolean().default(false),
});
export type CreateSavedView = z.infer<typeof createSavedViewSchema>;

export const updateSavedViewSchema = z
  .object({
    name: viewNameSchema.optional(),
    filters: savedViewFiltersSchema.optional(),
    sort: ticketSortSchema.optional(),
    shared: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'nothing to update' });
export type UpdateSavedView = z.infer<typeof updateSavedViewSchema>;

// --- bulk actions (R-1.8) ---

export const BULK_MAX_TICKETS = 100;

/** A status a person can move a ticket to; `merged` is reached only by merging. */
const settableStatusSchema = ticketStatusSchema.exclude(['merged']);

/**
 * What a bulk request can do: assign, change status, change priority, merge into one ticket. There is
 * deliberately no reply and no message of any kind: nothing a bulk action does reaches a customer by
 * itself, and the policy gate for customer sends (N3) is never in its path.
 */
export const bulkActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('assign'),
    /** A staff user id, or null to unassign. */
    assigneeId: z.uuid().nullable(),
  }),
  z.object({
    type: z.literal('status'),
    status: settableStatusSchema,
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  z.object({ type: z.literal('priority'), priority: ticketPrioritySchema }),
  z.object({
    type: z.literal('merge'),
    /** The ticket that stays; every selected ticket is merged into it. */
    intoTicketId: ticketRefSchema,
    reason: z.string().trim().min(1).max(500).optional(),
  }),
]);
export type BulkAction = z.infer<typeof bulkActionSchema>;

export const bulkRequestSchema = z.object({
  ticketIds: z
    .array(z.uuid())
    .min(1)
    .max(BULK_MAX_TICKETS)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'ticketIds must be unique' }),
  action: bulkActionSchema,
});
export type BulkRequest = z.infer<typeof bulkRequestSchema>;

export const bulkItemSchema = z.object({
  ticketId: z.uuid(),
  /** `OPS-1234`; null when the ticket does not exist or the caller cannot see it. */
  key: z.string().nullable(),
  ok: z.boolean(),
  error: z.object({ status: z.number().int(), code: z.string(), message: z.string() }).optional(),
});
export type BulkItem = z.infer<typeof bulkItemSchema>;

export const bulkResultSchema = z.object({
  action: z.enum(['assign', 'status', 'priority', 'merge']),
  total: z.number().int().min(1),
  succeeded: z.number().int().min(0),
  failed: z.number().int().min(0),
  items: z.array(bulkItemSchema),
});
export type BulkResult = z.infer<typeof bulkResultSchema>;

// --- linked tickets (R-1.1) ---

/** Links between two tickets (T-119). */
export const TICKET_PAIR_LINK_KINDS = ['duplicate', 'related'] as const;
/** Links from a ticket to something that already exists outside the queue (T-137). */
export const TICKET_REFERENCE_LINK_KINDS = ['incident', 'deploy'] as const;
/** Every kind a row of `ticket_link` can have. */
export const TICKET_LINK_KINDS = [
  ...TICKET_PAIR_LINK_KINDS,
  ...TICKET_REFERENCE_LINK_KINDS,
] as const;
export type TicketLinkKind = (typeof TICKET_LINK_KINDS)[number];
/** The kinds of the ticket-to-ticket routes; the other two have their own (`/references`). */
export const ticketPairLinkKindSchema = z.enum(TICKET_PAIR_LINK_KINDS);
export type TicketPairLinkKind = (typeof TICKET_PAIR_LINK_KINDS)[number];

/**
 * How the other ticket relates to the one asked about. `duplicate_of`: this ticket is a duplicate of
 * the other. `has_duplicate`: the other is a duplicate of this one. `related` is the same both ways.
 */
export const TICKET_LINK_RELATIONS = ['duplicate_of', 'has_duplicate', 'related'] as const;
export const ticketLinkRelationSchema = z.enum(TICKET_LINK_RELATIONS);
export type TicketLinkRelation = (typeof TICKET_LINK_RELATIONS)[number];

export const ticketLinkSchema = z.object({
  id: z.uuid(),
  kind: ticketPairLinkKindSchema,
  relation: ticketLinkRelationSchema,
  ticket: z.object({
    id: z.uuid(),
    key: z.string(),
    subject: z.string(),
    status: ticketStatusSchema,
    priority: ticketPrioritySchema,
  }),
  createdAt: z.iso.datetime(),
  createdBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
});
export type TicketLink = z.infer<typeof ticketLinkSchema>;
export const ticketLinkListSchema = z.object({ items: z.array(ticketLinkSchema) });
export type TicketLinkList = z.infer<typeof ticketLinkListSchema>;

export const createTicketLinkSchema = z.object({
  kind: ticketPairLinkKindSchema,
  /**
   * The other ticket, by id or number. `duplicate`: the ticket in the URL is a duplicate of this one.
   * Both tickets must belong to the same organization.
   */
  ticketId: ticketRefSchema,
});
export type CreateTicketLink = z.infer<typeof createTicketLinkSchema>;

export const ticketLinkParamSchema = z.object({ id: ticketRefSchema, linkId: z.uuid() });
export type TicketLinkParam = z.infer<typeof ticketLinkParamSchema>;
