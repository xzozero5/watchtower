import {
  CUSTOMER_STATUS_LABELS,
  REOPEN_WINDOW_DAYS,
  TICKET_EVENT_TYPES,
  customerStatus,
  customerStatusSchema,
  ticketStatusSchema,
  type CustomerStatus,
  type PortalTimelineEntry,
  type TicketStatus,
} from '@watchtower/shared';
import { z } from 'zod';

import { firstName } from './portal-notifier.js';

export interface ViewMessage {
  readonly id: string;
  readonly direction: string;
  readonly bodyText: string;
  /** `message.attachments` as stored; only the display name and size leave this module. */
  readonly attachments?: unknown;
  readonly createdAt: Date;
  /** Full name of the staff sender, if any. Only the first name leaves this module. */
  readonly staffName: string | null;
}

export interface ViewEvent {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly createdAt: Date;
}

const statusChangePayload = z.object({ from: ticketStatusSchema, to: ticketStatusSchema });
const mergedPayload = z.object({ intoKey: z.string().max(32) });

const DAY_MS = 24 * 60 * 60 * 1000;

const storedAttachment = z.object({ filename: z.string().nullable(), size: z.number() });

/** Name and size of each stored attachment; object keys, hashes and the rest of the record stay inside. */
export function customerFacingAttachments(value: unknown): { name: string; size: number }[] {
  if (!Array.isArray(value)) return [];
  const files: { name: string; size: number }[] = [];
  for (const item of value as unknown[]) {
    const parsed = storedAttachment.safeParse(item);
    if (parsed.success) {
      files.push({
        name: parsed.data.filename ?? 'file',
        size: Math.max(0, Math.trunc(parsed.data.size)),
      });
    }
  }
  return files;
}

/**
 * The timeline a customer sees: public messages, and the status words they went through. Internal
 * notes, AI and system events, assignment, SLA and staff-only payload never get here (the queries
 * ask for public rows; this function only reads the keys it knows). A staff member appears by first
 * name only (UI spec Q6), and a status change that reads the same to the customer ("In progress"
 * after "In progress") is left out.
 */
export function buildTimeline(
  messages: readonly ViewMessage[],
  events: readonly ViewEvent[],
): PortalTimelineEntry[] {
  type Item = {
    at: Date;
    /** Within one millisecond: the ticket opens, then the message, then what the message caused. */
    rank: number;
    id: string;
    entry: (last: CustomerStatus | null) => PortalTimelineEntry | null;
  };
  const items: Item[] = [];

  for (const message of messages) {
    const fromSupport = message.direction === 'outbound';
    const files = customerFacingAttachments(message.attachments);
    items.push({
      at: message.createdAt,
      rank: 1,
      id: message.id,
      entry: () => ({
        kind: 'message',
        id: message.id,
        from: fromSupport ? 'support' : 'customer',
        authorName: fromSupport ? firstName(message.staffName) : null,
        body: message.bodyText,
        ...(files.length > 0 ? { attachments: files } : {}),
        createdAt: message.createdAt.toISOString(),
      }),
    });
  }

  for (const event of events) {
    items.push({
      at: event.createdAt,
      rank: event.type === TICKET_EVENT_TYPES.created ? 0 : 2,
      id: event.id,
      entry: (last) => {
        let status: CustomerStatus;
        let mergedIntoKey: string | null = null;
        if (event.type === TICKET_EVENT_TYPES.created) {
          status = 'received';
        } else if (event.type === TICKET_EVENT_TYPES.statusChanged) {
          const payload = statusChangePayload.safeParse(event.payload);
          if (!payload.success) return null;
          if (customerStatus(payload.data.from) === customerStatus(payload.data.to)) return null;
          status = customerStatus(payload.data.to);
        } else if (event.type === TICKET_EVENT_TYPES.merged) {
          const payload = mergedPayload.safeParse(event.payload);
          if (!payload.success) return null;
          status = 'merged';
          mergedIntoKey = payload.data.intoKey;
        } else {
          return null;
        }
        if (status === last) return null;
        return {
          kind: 'status',
          id: event.id,
          status,
          label: CUSTOMER_STATUS_LABELS[status],
          mergedIntoKey,
          createdAt: event.createdAt.toISOString(),
        };
      },
    });
  }

  items.sort(
    (a, b) => a.at.getTime() - b.at.getTime() || a.rank - b.rank || (a.id < b.id ? -1 : 1),
  );
  const entries: PortalTimelineEntry[] = [];
  let last: CustomerStatus | null = null;
  for (const item of items) {
    const entry = item.entry(last);
    if (entry === null) continue;
    if (entry.kind === 'status') last = customerStatusSchema.parse(entry.status);
    entries.push(entry);
  }
  return entries;
}

/** False once a ticket is closed or merged, or was resolved longer ago than a reply may reopen it. */
export function canCustomerReply(
  ticket: { readonly status: string; readonly resolvedAt: Date | null },
  now: Date = new Date(),
): boolean {
  const status = ticket.status as TicketStatus;
  if (status === 'closed' || status === 'merged') return false;
  if (status === 'resolved') {
    return (
      ticket.resolvedAt !== null &&
      now.getTime() - ticket.resolvedAt.getTime() <= REOPEN_WINDOW_DAYS * DAY_MS
    );
  }
  return true;
}
