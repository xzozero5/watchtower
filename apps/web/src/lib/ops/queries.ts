'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { AlertListQuery, IncidentListQuery, StatusPostListQuery } from '@watchtower/shared';

import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import { userScope } from '@/lib/tickets/queries';

/** The alert and incident lists also poll, in case a realtime event was missed while the socket was down. */
export const OPS_POLL_MS = 30_000;

export const opsKeys = (userId: string) => {
  const all = [...userScope(userId), 'ops'] as const;
  return {
    all,
    alerts: [...all, 'alerts'] as const,
    alertList: (query: unknown) => [...all, 'alerts', 'list', query] as const,
    alert: (id: string) => [...all, 'alerts', 'one', id] as const,
    escalations: (id: string) => [...all, 'alerts', 'one', id, 'escalations'] as const,
    correlations: [...all, 'alerts', 'correlations'] as const,
    noise: (days: number) => [...all, 'alerts', 'noise', days] as const,
    services: [...all, 'services'] as const,
    policies: [...all, 'policies'] as const,
    heartbeats: [...all, 'heartbeats'] as const,
    incidents: [...all, 'incidents'] as const,
    incidentList: (query: unknown) => [...all, 'incidents', 'list', query] as const,
    incident: (id: string) => [...all, 'incidents', 'one', id] as const,
    changes: (id: string) => [...all, 'incidents', 'one', id, 'changes'] as const,
    comms: (id: string) => [...all, 'incidents', 'one', id, 'comms'] as const,
    commPreview: (id: string) => [...all, 'incidents', 'one', id, 'comm-preview'] as const,
    statusComponents: [...all, 'status', 'components'] as const,
    statusPosts: (query: unknown) => [...all, 'status', 'posts', query] as const,
    statusPostsAll: [...all, 'status', 'posts'] as const,
    statusMaintenance: [...all, 'status', 'maintenance'] as const,
    statusSubscribers: [...all, 'status', 'subscribers'] as const,
    orgHealth: (orgId: string) => [...all, 'health', orgId] as const,
  };
};

export function useAlertList(query: Partial<AlertListQuery> | null) {
  const api = useApi();
  const userId = useUserId();
  return useInfiniteQuery({
    queryKey: opsKeys(userId).alertList(query),
    queryFn: ({ pageParam, signal }) =>
      api.alerts({ ...query, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: query !== null,
    refetchInterval: OPS_POLL_MS,
    staleTime: OPS_POLL_MS / 2,
  });
}

export function useAlert(alertId: string | null) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: opsKeys(userId).alert(alertId ?? ''),
    queryFn: ({ signal }) => api.alert(alertId ?? '', signal),
    enabled: alertId !== null,
    staleTime: 5_000,
  });
}

export function useAlertEscalations(alertId: string | null) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: opsKeys(userId).escalations(alertId ?? ''),
    queryFn: ({ signal }) => api.alertEscalations(alertId ?? '', signal),
    enabled: alertId !== null,
    staleTime: 5_000,
  });
}

export function useCorrelations(enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: opsKeys(userId).correlations,
    queryFn: ({ signal }) => api.alertCorrelations(signal),
    enabled,
    staleTime: 15_000,
  });
}

export function useNoise(days: number, enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: opsKeys(userId).noise(days),
    queryFn: ({ signal }) => api.alertNoise(days, signal),
    enabled,
    staleTime: 60_000,
  });
}

export function useServices(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: opsKeys(userId).services,
    queryFn: ({ signal }) => api.services(signal),
    enabled,
    staleTime: 30_000,
  });
}

export function useEscalationPolicies(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: opsKeys(userId).policies,
    queryFn: ({ signal }) => api.escalationPolicies(signal),
    enabled,
    staleTime: 30_000,
  });
}

export function useHeartbeats(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: opsKeys(userId).heartbeats,
    queryFn: ({ signal }) => api.heartbeats(signal),
    enabled,
    refetchInterval: OPS_POLL_MS,
    staleTime: OPS_POLL_MS / 2,
  });
}

export function useIncidentList(query: Partial<IncidentListQuery>) {
  const api = useApi();
  const userId = useUserId();
  return useInfiniteQuery({
    queryKey: opsKeys(userId).incidentList(query),
    queryFn: ({ pageParam, signal }) =>
      api.incidents({ ...query, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: OPS_POLL_MS,
    staleTime: OPS_POLL_MS / 2,
  });
}

export function useIncident(incidentId: string | null) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: opsKeys(userId).incident(incidentId ?? ''),
    queryFn: ({ signal }) => api.incident(incidentId ?? '', signal),
    enabled: incidentId !== null,
    refetchInterval: OPS_POLL_MS,
    staleTime: 5_000,
  });
}

export function useIncidentChanges(incidentId: string | null, enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: opsKeys(userId).changes(incidentId ?? ''),
    queryFn: ({ signal }) => api.incidentChanges(incidentId ?? '', undefined, signal),
    enabled: enabled && incidentId !== null,
    staleTime: 30_000,
  });
}

export function useIncidentComms(incidentId: string | null, enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: opsKeys(userId).comms(incidentId ?? ''),
    queryFn: ({ signal }) => api.incidentComms(incidentId ?? '', signal),
    enabled: enabled && incidentId !== null,
    staleTime: 5_000,
  });
}

/** Read again every time the confirm dialog opens: the number to confirm must be the audience now. */
export function useCommPreview(incidentId: string | null, enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: opsKeys(userId).commPreview(incidentId ?? ''),
    queryFn: ({ signal }) => api.incidentCommPreview(incidentId ?? '', signal),
    enabled: enabled && incidentId !== null,
    staleTime: 0,
    gcTime: 0,
  });
}

export function useStatusComponents(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: opsKeys(userId).statusComponents,
    queryFn: ({ signal }) => api.statusComponents(signal),
    enabled,
    staleTime: 15_000,
  });
}

export function useStatusPosts(query: Partial<StatusPostListQuery>, enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useInfiniteQuery({
    queryKey: opsKeys(userId).statusPosts(query),
    queryFn: ({ pageParam, signal }) =>
      api.statusPosts({ ...query, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
    staleTime: 15_000,
  });
}

export function useStatusMaintenance(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: opsKeys(userId).statusMaintenance,
    queryFn: ({ signal }) => api.statusMaintenance(signal),
    enabled,
    staleTime: 15_000,
  });
}

export function useStatusSubscribers(enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: opsKeys(userId).statusSubscribers,
    queryFn: ({ signal }) => api.statusSubscribers(signal),
    enabled,
    staleTime: 15_000,
  });
}

/** Only ever called by a person who holds `org.health.read`; the api refuses anyone else. */
export function useOrgHealth(orgId: string, enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: opsKeys(userId).orgHealth(orgId),
    queryFn: ({ signal }) => api.orgHealth(orgId, signal),
    enabled,
    staleTime: 60_000,
  });
}
