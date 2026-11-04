'use client';

import { useQuery } from '@tanstack/react-query';

import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';

import { OPS_POLL_MS, opsKeys } from './queries';

/** The most the rail asks for; a full page means "at least this many". */
export const RAIL_COUNT_LIMIT = 100;

/** How many items wait: the page length, and whether more exist beyond it (shown as `100+`). */
export function pageCount(page: { items: readonly unknown[]; nextCursor: string | null }): {
  count: number;
  more: boolean;
} {
  return { count: page.items.length, more: page.nextCursor !== null };
}

/**
 * Open alerts and open incidents for the rail icons (T-158). Alerts sit under the `alerts` key, so the
 * `alert.updated` realtime event refreshes them; there is no incident event, so incidents poll like the
 * incident list does. Until the first read (or if it fails) the count is zero and the icon stays neutral.
 */
export function useRailCounts(enabled: { alerts: boolean; incidents: boolean }) {
  const api = useApi();
  const userId = useUserId();
  const keys = opsKeys(userId);
  const alerts = useQuery({
    queryKey: [...keys.alerts, 'rail-count'],
    queryFn: ({ signal }) => api.alerts({ state: 'open', limit: RAIL_COUNT_LIMIT }, signal),
    enabled: enabled.alerts,
    refetchInterval: OPS_POLL_MS,
    staleTime: OPS_POLL_MS / 2,
    select: pageCount,
  });
  const incidents = useQuery({
    queryKey: [...keys.incidents, 'rail-count'],
    queryFn: ({ signal }) => api.incidents({ open: true, limit: RAIL_COUNT_LIMIT }, signal),
    enabled: enabled.incidents,
    refetchInterval: OPS_POLL_MS,
    staleTime: OPS_POLL_MS / 2,
    select: pageCount,
  });
  return {
    alerts: alerts.data?.count ?? 0,
    alertsMore: alerts.data?.more ?? false,
    incidents: incidents.data?.count ?? 0,
    incidentsMore: incidents.data?.more ?? false,
  };
}
