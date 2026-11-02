'use client';

import { useQuery } from '@tanstack/react-query';
import type { TicketStatus } from '@watchtower/shared';

import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';

import { filtersToParams, type QueueFilters } from './filters';
import type { TicketItem } from './model';

const CLOSED: ReadonlySet<TicketStatus> = new Set<TicketStatus>(['resolved', 'closed', 'merged']);

export interface HiddenMatches {
  count: number;
  /** Every hidden match is a finished ticket (resolved, closed, merged). */
  allClosed: boolean;
}

/**
 * Tickets that match the search but are hidden by the status filter: the same search with the
 * status filter dropped (`allStatuses=true`; it also matches a requester email, which the stats and
 * count routes deliberately do not), minus what the list already shows. Asks only while a search
 * and a status filter are both active.
 */
export function useHiddenMatches(
  filters: QueueFilters,
  shownKeys: ReadonlySet<string>,
  enabled: boolean,
): HiddenMatches | null {
  const api = useApi();
  const userId = useUserId();
  const q = filters.q.trim();
  const active = enabled && q.length >= 2 && filters.status.length > 0;
  const query = useQuery({
    queryKey: ['user', userId, 'tickets', 'hidden-matches', filters],
    enabled: active,
    staleTime: 30_000,
    queryFn: ({ signal }) =>
      api.listTickets(
        { ...filtersToParams({ ...filters, status: [] }), allStatuses: true, limit: 20 },
        signal,
      ),
  });
  if (!active || !query.data) return null;
  return summarizeHidden(query.data.items, shownKeys);
}

/** What the search finds that the list does not show; null when nothing is hidden. */
export function summarizeHidden(
  items: readonly Pick<TicketItem, 'key' | 'status'>[],
  shownKeys: ReadonlySet<string>,
): HiddenMatches | null {
  const hidden = items.filter((item) => !shownKeys.has(item.key));
  if (hidden.length === 0) return null;
  return { count: hidden.length, allClosed: hidden.every((item) => CLOSED.has(item.status)) };
}
