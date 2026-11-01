import type { RealtimeEvent, TicketPriority, TicketStatus } from '@watchtower/shared';

import type { QueueFilters } from '@/lib/tickets/filters';

/**
 * What the "N new" pill remembers about a ticket that arrived while the list was on screen: just
 * enough to tell whether it belongs to the filter the person has on (docs/06-UI-SPEC.md section
 * 7.1). The event carries the org, queue and channel for this; it never carries message text.
 */
export interface NewTicket {
  readonly id: string;
  readonly orgId: string;
  readonly queueId: string | null;
  readonly channel: string | null;
  readonly priority: TicketPriority;
  readonly status: TicketStatus;
  readonly assigneeId: string | null;
}

export function toNewTicket(event: Extract<RealtimeEvent, { type: 'ticket.created' }>): NewTicket {
  return {
    id: event.ticketId,
    orgId: event.orgId,
    queueId: event.data.queueId ?? null,
    channel: event.data.channel ?? null,
    priority: event.data.priority,
    status: event.data.status,
    assigneeId: event.data.assigneeId ?? null,
  };
}

/**
 * True when a ticket that was just created would be in the list for `filters`. What the event
 * cannot tell is not guessed:
 *  - a text search (`q`) is the server's to answer, so while one is typed nothing is counted: the
 *    pill would promise rows the search may not return;
 *  - "overdue" is never true of a ticket that was just created.
 */
export function matchesFilters(ticket: NewTicket, filters: QueueFilters, userId: string): boolean {
  if (filters.q.trim() !== '' || filters.overdue) return false;
  if (filters.status.length > 0 && !filters.status.includes(ticket.status)) return false;
  if (filters.priority.length > 0 && !filters.priority.includes(ticket.priority)) return false;
  if (filters.queueId !== undefined && ticket.queueId !== filters.queueId) return false;
  if (filters.assigneeId !== undefined) return ticket.assigneeId === filters.assigneeId;
  switch (filters.assignee) {
    case 'me':
      return ticket.assigneeId === userId;
    case 'unassigned':
      return ticket.assigneeId === null;
    case 'any':
      return true;
  }
}

/** How many of the tickets that arrived belong to the current filter: the number on the pill. */
export function countNewMatching(
  tickets: readonly NewTicket[],
  filters: QueueFilters,
  userId: string,
): number {
  return tickets.filter((ticket) => matchesFilters(ticket, filters, userId)).length;
}
