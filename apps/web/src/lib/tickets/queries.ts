'use client';

import {
  type InfiniteData,
  keepPreviousData,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { AssignTicket, ChangeStatus, Note, Reply, UpdateTicket } from '@watchtower/shared';
import { useEffect } from 'react';

import { useApi } from '@/lib/api/api-context';
import type { Endpoints } from '@/lib/api/endpoints';

import { type QueueFilters, filtersToParams } from './filters';
import type { TicketItem } from './model';

type TicketPage = Awaited<ReturnType<Endpoints['listTickets']>>;

export const ticketKeys = {
  all: ['tickets'] as const,
  lists: ['tickets', 'list'] as const,
  list: (filters: QueueFilters) => ['tickets', 'list', filters] as const,
  detail: (key: string) => ['tickets', 'detail', key] as const,
  timelines: ['tickets', 'timeline'] as const,
  timeline: (key: string) => ['tickets', 'timeline', key] as const,
};

export const referenceKeys = {
  intents: ['reference', 'intents'] as const,
  queues: ['reference', 'queues'] as const,
  workflow: ['reference', 'workflow'] as const,
};

/**
 * Replaces the row of `ticket` in every cached list without moving it, so the queue does not
 * reflow under the cursor (PRD section 10). A ticket that no longer matches a list's filters stays
 * until the next explicit refresh.
 */
export function patchTicketInLists(queryClient: QueryClient, ticket: TicketItem): void {
  queryClient.setQueriesData<InfiniteData<TicketPage, string | undefined>>(
    { queryKey: ticketKeys.lists },
    (data) => {
      if (!data) return data;
      return {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          items: page.items.map((item) => (item.id === ticket.id ? ticket : item)),
        })),
      };
    },
  );
}

/** Stores a ticket the api just returned: the detail cache and its row in the lists. */
export function storeTicket(queryClient: QueryClient, ticket: TicketItem): void {
  queryClient.setQueryData(ticketKeys.detail(ticket.key), ticket);
  patchTicketInLists(queryClient, ticket);
}

export function useTicketList(filters: QueueFilters) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: ticketKeys.list(filters),
    queryFn: ({ pageParam, signal }) =>
      api.listTickets({ ...filtersToParams(filters), cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    // A refresh is the user's call (the "N new" pill, reload); never refetch on its own.
    staleTime: 60_000,
  });
}

export function useTicket(key: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ticketKeys.detail(key ?? ''),
    queryFn: ({ signal }) => api.getTicket(key ?? '', signal),
    enabled: key !== null,
  });
}

/** Every page of a ticket's timeline, oldest first. Pages load one after another until done. */
export function useTimeline(key: string | null) {
  const api = useApi();
  const query = useInfiniteQuery({
    queryKey: ticketKeys.timeline(key ?? ''),
    queryFn: ({ pageParam, signal }) => api.timeline(key ?? '', pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: key !== null,
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  return query;
}

export function useIntents(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: referenceKeys.intents,
    queryFn: ({ signal }) => api.intents(signal),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useQueues(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: referenceKeys.queues,
    queryFn: ({ signal }) => api.queues(signal),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useWorkflow(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: referenceKeys.workflow,
    queryFn: ({ signal }) => api.workflow(signal),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** Mutations that change one ticket. Each stores the returned ticket so every pane updates at once. */
export function useTicketMutations(ticketKey: string) {
  const api = useApi();
  const queryClient = useQueryClient();

  const afterTicket = (ticket: TicketItem) => {
    storeTicket(queryClient, ticket);
  };
  const afterMessage = (result: { ticket: TicketItem }) => {
    afterTicket(result.ticket);
    void queryClient.invalidateQueries({ queryKey: ticketKeys.timeline(ticketKey) });
  };

  return {
    reply: useMutation({
      mutationFn: (body: Reply) => api.reply(ticketKey, body),
      onSuccess: afterMessage,
    }),
    note: useMutation({
      mutationFn: (body: Note) => api.note(ticketKey, body),
      onSuccess: afterMessage,
    }),
    changeStatus: useMutation({
      mutationFn: (body: ChangeStatus) => api.changeStatus(ticketKey, body),
      onSuccess: (ticket) => {
        afterTicket(ticket);
        void queryClient.invalidateQueries({ queryKey: ticketKeys.timeline(ticketKey) });
      },
    }),
    assign: useMutation({
      mutationFn: (body: AssignTicket) => api.assign(ticketKey, body),
      onSuccess: (ticket) => {
        afterTicket(ticket);
        void queryClient.invalidateQueries({ queryKey: ticketKeys.timeline(ticketKey) });
      },
    }),
    update: useMutation({
      mutationFn: (body: UpdateTicket) => api.updateTicket(ticketKey, body),
      onSuccess: (ticket) => {
        afterTicket(ticket);
        void queryClient.invalidateQueries({ queryKey: ticketKeys.timeline(ticketKey) });
      },
    }),
  };
}
