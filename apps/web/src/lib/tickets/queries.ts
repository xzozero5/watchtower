'use client';

import {
  type InfiniteData,
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
import { useUserId } from '@/lib/auth/session';

import { type QueueFilters, filtersToParams } from './filters';
import type { TicketItem } from './model';

type TicketPage = Awaited<ReturnType<Endpoints['listTickets']>>;

/**
 * Every cached read of a signed-in person lives under `['user', userId, ...]`. A second person on
 * the same tab therefore has different keys and can never be served the first person's data, even
 * if a clean-up were missed (`endSession` removes the old entries as well).
 */
export const userScope = (userId: string) => ['user', userId] as const;

export const ticketKeys = (userId: string) => {
  const all = [...userScope(userId), 'tickets'] as const;
  return {
    all,
    lists: [...all, 'list'] as const,
    list: (filters: QueueFilters) => [...all, 'list', filters] as const,
    detail: (key: string) => [...all, 'detail', key] as const,
    timelines: [...all, 'timeline'] as const,
    timeline: (key: string) => [...all, 'timeline', key] as const,
  };
};

export const referenceKeys = (userId: string) => {
  const all = [...userScope(userId), 'reference'] as const;
  return {
    intents: [...all, 'intents'] as const,
    queues: [...all, 'queues'] as const,
    workflow: [...all, 'workflow'] as const,
  };
};

/**
 * Replaces the row of `ticket` in every cached list without moving it, so the queue does not
 * reflow under the cursor (PRD section 10). A ticket that no longer matches a list's filters stays
 * until the next explicit refresh.
 */
export function patchTicketInLists(
  queryClient: QueryClient,
  userId: string,
  ticket: TicketItem,
): void {
  queryClient.setQueriesData<InfiniteData<TicketPage, string | undefined>>(
    { queryKey: ticketKeys(userId).lists },
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
export function storeTicket(queryClient: QueryClient, userId: string, ticket: TicketItem): void {
  queryClient.setQueryData(ticketKeys(userId).detail(ticket.key), ticket);
  patchTicketInLists(queryClient, userId, ticket);
}

export function useTicketList(filters: QueueFilters) {
  const api = useApi();
  const userId = useUserId();
  return useInfiniteQuery({
    queryKey: ticketKeys(userId).list(filters),
    queryFn: ({ pageParam, signal }) =>
      api.listTickets({ ...filtersToParams(filters), cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // While a new filter loads, keep showing the previous list so the queue does not flash empty,
    // but only if it belongs to the same person (keys are `['user', id, ...]`).
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === userId ? previous : undefined,
    // A refresh is the user's call (the "N new" pill, reload); never refetch on its own.
    staleTime: 60_000,
  });
}

export function useTicket(key: string | null) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: ticketKeys(userId).detail(key ?? ''),
    queryFn: ({ signal }) => api.getTicket(key ?? '', signal),
    enabled: key !== null,
  });
}

/** Every page of a ticket's timeline, oldest first. Pages load one after another until done. */
export function useTimeline(key: string | null) {
  const api = useApi();
  const userId = useUserId();
  const query = useInfiniteQuery({
    queryKey: ticketKeys(userId).timeline(key ?? ''),
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
  const userId = useUserId();
  return useQuery({
    queryKey: referenceKeys(userId).intents,
    queryFn: ({ signal }) => api.intents(signal),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useQueues(enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: referenceKeys(userId).queues,
    queryFn: ({ signal }) => api.queues(signal),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useWorkflow(enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: referenceKeys(userId).workflow,
    queryFn: ({ signal }) => api.workflow(signal),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** Mutations that change one ticket. Each stores the returned ticket so every pane updates at once. */
export function useTicketMutations(ticketKey: string) {
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const keys = ticketKeys(userId);

  const afterTicket = (ticket: TicketItem) => {
    storeTicket(queryClient, userId, ticket);
  };
  const afterMessage = (result: { ticket: TicketItem }) => {
    afterTicket(result.ticket);
    void queryClient.invalidateQueries({ queryKey: keys.timeline(ticketKey) });
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
        void queryClient.invalidateQueries({ queryKey: keys.timeline(ticketKey) });
      },
    }),
    assign: useMutation({
      mutationFn: (body: AssignTicket) => api.assign(ticketKey, body),
      onSuccess: (ticket) => {
        afterTicket(ticket);
        void queryClient.invalidateQueries({ queryKey: keys.timeline(ticketKey) });
      },
    }),
    update: useMutation({
      mutationFn: (body: UpdateTicket) => api.updateTicket(ticketKey, body),
      onSuccess: (ticket) => {
        afterTicket(ticket);
        void queryClient.invalidateQueries({ queryKey: keys.timeline(ticketKey) });
      },
    }),
  };
}
