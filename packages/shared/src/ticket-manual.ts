import { z } from 'zod';

import { emailSchema } from './auth.js';
import { manualChannelSchema } from './channels.js';
import { ticketPrioritySchema } from './sla.js';
import {
  ticketDetailSchema,
  ticketStatusSchema,
  ticketTagsSchema,
  type TicketStatus,
} from './ticketing.js';

// --- a ticket filed by hand (T-136) ---

/**
 * What happened to the confirmation email of a ticket filed by hand `[ASSUMED]`:
 * - `queued`: an automatic acknowledgment (a safe template, through the policy gate) was scheduled;
 * - `not_requested`: nobody asked for it. For a contact that already existed the default is to send; for an
 *   address that is new here the person must tick the box, so the email never goes to the wrong person;
 * - `no_address`: the contact has no email address;
 * - `no_email_account`: no Gmail account is connected to send through;
 * - `blocked_by_policy`: the policy gate refused the automatic message (for example a kill switch).
 */
export const CONFIRMATION_STATUSES = [
  'queued',
  'not_requested',
  'no_address',
  'no_email_account',
  'blocked_by_policy',
] as const;
export type ConfirmationStatus = (typeof CONFIRMATION_STATUSES)[number];

export const createManualTicketSchema = z
  .object({
    orgId: z.uuid(),
    /** Where the request came from. */
    channel: manualChannelSchema,
    subject: z.string().trim().min(1).max(300),
    /** What the customer said, as the person who took the call or the visit wrote it down. */
    body: z.string().trim().min(1).max(20_000),
    /** An existing contact of the organization... */
    requesterContactId: z.uuid().optional(),
    /** ...or a new one (found by address if it exists). A new contact is created unverified. */
    requester: z.object({ email: emailSchema, name: z.string().trim().min(1).max(200) }).optional(),
    /**
     * Send the customer the automatic "we received your request" email. Default: yes for a contact that
     * already exists, no for an address that is new here (the person ticks the box).
     */
    sendConfirmation: z.boolean().optional(),
    intentId: z.uuid().optional(),
    priority: ticketPrioritySchema.optional(),
    queueId: z.uuid().optional(),
    tags: ticketTagsSchema.optional(),
  })
  .refine((value) => (value.requesterContactId === undefined) !== (value.requester === undefined), {
    message: 'give either requesterContactId or requester',
    path: ['requesterContactId'],
  });
export type CreateManualTicket = z.infer<typeof createManualTicketSchema>;

export const manualTicketResultSchema = z.object({
  ticket: ticketDetailSchema,
  contact: z.object({ id: z.uuid(), created: z.boolean() }),
  confirmation: z.object({ status: z.enum(CONFIRMATION_STATUSES) }),
});
export type ManualTicketResult = z.infer<typeof manualTicketResultSchema>;

/** Open tickets that may be the same request, by requester and subject, while a person types. */
export const SIMILAR_TICKET_LIMIT = 5;
/** Trigram similarity of two subjects from which a ticket is suggested `[ASSUMED]`. */
export const SIMILAR_TICKET_THRESHOLD = 0.3;
export const similarTicketsQuerySchema = z.object({
  orgId: z.uuid(),
  requesterContactId: z.uuid().optional(),
  subject: z.string().trim().min(3).max(300),
});
export type SimilarTicketsQuery = z.infer<typeof similarTicketsQuerySchema>;

export const similarTicketsSchema = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      key: z.string(),
      subject: z.string(),
      status: ticketStatusSchema,
      priority: ticketPrioritySchema,
      createdAt: z.iso.datetime(),
      /** Filed by the same contact. */
      sameRequester: z.boolean(),
      /** Trigram similarity of the subjects, 0 to 1. */
      similarity: z.number().min(0).max(1),
    }),
  ),
});
export type SimilarTickets = z.infer<typeof similarTicketsSchema>;

// --- the developer's part of a ticket (T-137) ---

/** The only two statuses the `dev` role moves a ticket between. */
export const DEV_STATUSES = ['open', 'waiting_on_dev'] as const satisfies readonly TicketStatus[];

/**
 * A status change that must carry a note `[ASSUMED]` (T-137): moving to `waiting_on_dev` (an agent or a
 * developer hands it over) and a developer leaving it (handing it back). The note is saved as an internal
 * note; the customer sees "In progress" for both statuses and is told nothing.
 */
export function statusChangeNeedsNote(
  from: TicketStatus,
  to: TicketStatus,
  byDev = false,
): boolean {
  return to === 'waiting_on_dev' || (byDev && from === 'waiting_on_dev');
}

/** The moves a `dev` may make: `open` to `waiting_on_dev` and back, nothing else. */
export function isDevStatusMove(from: TicketStatus, to: TicketStatus): boolean {
  return (
    (DEV_STATUSES as readonly string[]).includes(from) &&
    (DEV_STATUSES as readonly string[]).includes(to) &&
    from !== to
  );
}
