'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { DASHBOARD_CACHE_SECONDS } from '@watchtower/shared';

import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import { userScope } from '@/lib/tickets/queries';

/** The api recomputes a window at most this often (30 s), so asking more often only reads its cache. */
export const DASHBOARD_POLL_MS = DASHBOARD_CACHE_SECONDS * 1000;

export const dashboardKeys = (userId: string) => {
  const all = [...userScope(userId), 'dashboard'] as const;
  return { all, ops: (days: number) => [...all, 'ops', days] as const };
};

/**
 * The ops dashboard for a window. It polls at the api's cache cadence; the previous window's
 * figures stay on screen while a new window loads (`placeholderData`), so a refetch or a change of
 * window never swaps the page for a skeleton and nothing moves under the cursor.
 */
export function useDashboardOps(days: number, enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: dashboardKeys(userId).ops(days),
    queryFn: ({ signal }) => api.dashboardOps(days, signal),
    enabled,
    refetchInterval: DASHBOARD_POLL_MS,
    staleTime: DASHBOARD_POLL_MS / 2,
    placeholderData: keepPreviousData,
  });
}
