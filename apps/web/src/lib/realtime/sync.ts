import type { QueryClient } from '@tanstack/react-query';
import type { RealtimeEvent } from '@watchtower/shared';

import type { Endpoints } from '@/lib/api/endpoints';
import { storeTicket, ticketKeys } from '@/lib/tickets/queries';

interface CachedPage {
  items: readonly { id: string }[];
}

/** True when this tab holds the ticket anywhere: an open detail or a row of a loaded list. */
export function isTicketCached(queryClient: QueryClient, ticketId: string, key: string): boolean {
  if (queryClient.getQueryData(ticketKeys.detail(key)) !== undefined) return true;
  const lists = queryClient.getQueriesData<{ pages: readonly CachedPage[] }>({
    queryKey: ticketKeys.lists,
  });
  return lists.some(([, data]) =>
    data?.pages.some((page) => page.items.some((item) => item.id === ticketId)),
  );
}

export interface SyncDeps {
  queryClient: QueryClient;
  api: Pick<Endpoints, 'getTicket'>;
  onNewTicket: (ticketId: string) => void;
}

/**
 * Turns one realtime event into cache updates. Events carry ids only (the api never puts message
 * text on the wire), so each one is a cue to fetch what changed:
 *  - `ticket.created`: counted for the "N new" pill; the list is not touched, so it never moves
 *    under the cursor;
 *  - `ticket.updated`: the ticket is re-read and its row is replaced in place;
 *  - `message.created`: the timeline of that ticket is refetched if this tab has it.
 */
export function applyRealtimeEvent(event: RealtimeEvent, deps: SyncDeps): void {
  const { queryClient, api } = deps;
  switch (event.type) {
    case 'ticket.created':
      deps.onNewTicket(event.ticketId);
      return;
    case 'ticket.updated': {
      if (!isTicketCached(queryClient, event.ticketId, event.ticketKey)) return;
      api
        .getTicket(event.ticketKey)
        .then((ticket) => {
          storeTicket(queryClient, ticket);
        })
        .catch(() => {
          void queryClient.invalidateQueries({ queryKey: ticketKeys.detail(event.ticketKey) });
        });
      return;
    }
    case 'message.created':
      void queryClient.invalidateQueries({ queryKey: ticketKeys.timeline(event.ticketKey) });
      return;
  }
}
