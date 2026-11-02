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
 * status filter dropped, minus what the list already shows. Asks only while a search and a status
 * filter are both active. Assumes the list api treats a missing `status` as "every status"
 * `[ASSUMED]`; the all-status flag the api is getting (parallel work) is not needed for this.
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
      api.listTickets({ ...filtersToParams({ ...filters, status: [] }), limit: 20 }, signal),
  });
  if (!active || !query.data) return null;
  const hidden = query.data.items.filter((item: TicketItem) => !shownKeys.has(item.key));
  if (hidden.length === 0) return null;
  return { count: hidden.length, allClosed: hidden.every((item) => CLOSED.has(item.status)) };
}
