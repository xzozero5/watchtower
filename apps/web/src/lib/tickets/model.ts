import {
  OPEN_STATUSES,
  type ClientTicket,
  type TicketDetail,
  type TicketPriority,
  type TicketAiRow,
  type TicketChannel,
  type TicketStatus,
  type TicketSummary,
} from '@watchtower/shared';
import type { SeverityId } from '@watchtower/ui';

import { slaView, type SlaView } from './sla';

/** What the api returns for a ticket: staff get the full shape, a client the reduced one. */
export type TicketItem = TicketSummary | TicketDetail | ClientTicket;

export function isStaffTicket(ticket: TicketItem): ticket is TicketSummary | TicketDetail {
  return 'channel' in ticket;
}

export function isDetail(ticket: TicketItem): ticket is TicketDetail {
  return 'mergedTickets' in ticket;
}

const SEVERITY: Record<TicketPriority, SeverityId> = { P1: 'p1', P2: 'p2', P3: 'p3', P4: 'p4' };

/** Ticket priority P1 to P4 as the design system's severity level. */
export function severityOf(priority: TicketPriority): SeverityId {
  return SEVERITY[priority];
}

/** Everything a queue row shows, with the staff-only parts null for a client. */
export interface RowModel {
  id: string;
  key: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  orgName: string | null;
  /** Who wrote in. A client sees their own name; staff see the requester on the ticket. */
  requesterName: string | null;
  /** Stable id behind the avatar hue. */
  requesterId: string;
  channel: TicketChannel | null;
  assigneeName: string | null;
  /** Who holds the ticket; absent in fixtures that predate it, null when nobody does. */
  assigneeId?: string | null;
  /** The team queue the ticket sits in. */
  queueId?: string | null;
  unassigned: boolean;
  intentName: string | null;
  /** Stable key of the intent: picks its colour and icon. */
  intentKey: string | null;
  /** What the AI did with it, from the list row; null when the api sends nothing (T-128). */
  ai: TicketAiRow | null;
  updatedAt: string;
  overdue: boolean;
  sla: SlaView;
}

/**
 * A ticket is overdue when it is open, its clock is running, and a due time has passed without the
 * matching milestone (first response, resolution).
 */
export function isOverdue(ticket: TicketItem, now: number): boolean {
  if (!isStaffTicket(ticket)) return false;
  if (!OPEN_STATUSES.includes(ticket.status)) return false;
  if (ticket.slaPausedAt !== null) return false;
  const late = (due: string | null) => due !== null && Date.parse(due) < now;
  return (
    (ticket.firstRespondedAt === null && late(ticket.firstResponseDueAt)) ||
    (ticket.resolvedAt === null && late(ticket.resolutionDueAt))
  );
}

/** The digits at the end of a ticket key (`OPS-1003` gives 1003); 0 when there are none. */
export function ticketNumber(key: string): number {
  const match = /(\d+)$/.exec(key);
  return match ? Number(match[1]) : 0;
}

export function toRowModel(ticket: TicketItem, now: number): RowModel {
  const staff = isStaffTicket(ticket);
  return {
    id: ticket.id,
    key: ticket.key,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    orgName: staff ? ticket.org.name : null,
    requesterName: staff ? (ticket.requester?.name ?? null) : ticket.requesterName,
    requesterId: staff ? (ticket.requester?.id ?? ticket.id) : ticket.id,
    channel: staff ? ticket.channel : null,
    assigneeName: staff ? (ticket.assignee?.name ?? null) : null,
    assigneeId: staff ? (ticket.assignee?.id ?? null) : null,
    queueId: staff ? (ticket.queue?.id ?? null) : null,
    unassigned: staff && ticket.assignee === null,
    intentName: ticket.intent?.name ?? null,
    intentKey: ticket.intent && 'key' in ticket.intent ? ticket.intent.key : null,
    ai: staff ? (ticket.ai ?? null) : null,
    updatedAt: ticket.updatedAt,
    overdue: isOverdue(ticket, now),
    sla: slaView(ticket, now),
  };
}

/** Terminal states: no reply box, and no status to move to. */
export function isClosedForReplies(status: TicketStatus): boolean {
  return status === 'closed' || status === 'merged';
}
