import type { QueryClient } from '@tanstack/react-query';
import type { RealtimeEvent } from '@watchtower/shared';

import type { Endpoints } from '@/lib/api/endpoints';
import { notificationKeys } from '@/lib/notifications/keys';
import { storeTicket, ticketKeys } from '@/lib/tickets/queries';

import { type NewTicket, toNewTicket } from './new-tickets';

interface CachedPage {
  items: readonly { id: string }[];
}

/** True when this tab holds the ticket anywhere: an open detail or a row of a loaded list. */
export function isTicketCached(
  queryClient: QueryClient,
  userId: string,
  ticketId: string,
  key: string,
): boolean {
  const keys = ticketKeys(userId);
  if (queryClient.getQueryData(keys.detail(key)) !== undefined) return true;
  const lists = queryClient.getQueriesData<{ pages: readonly CachedPage[] }>({
    queryKey: keys.lists,
  });
  return lists.some(([, data]) =>
    data?.pages.some((page) => page.items.some((item) => item.id === ticketId)),
  );
}

export interface SyncDeps {
  queryClient: QueryClient;
  /** Whose cache the event updates: query keys are scoped by user id. */
  userId: string;
  api: Pick<Endpoints, 'getTicket'>;
  /** A ticket arrived: remembered with its org, queue and channel so the pill can count per filter. */
  onNewTicket: (ticket: NewTicket) => void;
}

/**
 * Turns one realtime event into cache updates. Events carry ids only (the api never puts message
 * text on the wire), so each one is a cue to fetch what changed:
 *  - `ticket.created`: counted for the "N new" pill; the list is not touched, so it never moves
 *    under the cursor;
 *  - `ticket.updated`: the ticket is re-read and its row is replaced in place;
 *  - `message.created`: the timeline of that ticket is refetched if this tab has it;
 *  - `notification.created`: the notification center and the P1 banner are refetched (the event is
 *    addressed to this user only; the api never sends another person's).
 */
export function applyRealtimeEvent(event: RealtimeEvent, deps: SyncDeps): void {
  const { queryClient, api } = deps;
  switch (event.type) {
    case 'ticket.created':
      deps.onNewTicket(toNewTicket(event));
      return;
    case 'notification.created':
      // The event says that there is something new, not what: the center and the banner re-read.
      void queryClient.invalidateQueries({ queryKey: notificationKeys(deps.userId).all });
      return;
    case 'ticket.updated': {
      if (!isTicketCached(queryClient, deps.userId, event.ticketId, event.ticketKey)) return;
      api
        .getTicket(event.ticketKey)
        .then((ticket) => {
          storeTicket(queryClient, deps.userId, ticket);
        })
        .catch(() => {
          void queryClient.invalidateQueries({
            queryKey: ticketKeys(deps.userId).detail(event.ticketKey),
          });
        });
      return;
    }
    case 'message.created':
      void queryClient.invalidateQueries({
        queryKey: ticketKeys(deps.userId).timeline(event.ticketKey),
      });
      return;
  }
}
