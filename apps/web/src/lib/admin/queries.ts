'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { AuditLogQuery, OrganizationListQuery } from '@watchtower/shared';

import { OPEN_WORK_STATUSES } from '@/lib/admin/contracts';
import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import { userScope } from '@/lib/tickets/queries';

/** AI switches change rarely and have no realtime event yet (ADR-011), so staff screens poll. */
export const AUTONOMY_POLL_MS = 30_000;
/** Home refetches every minute (docs/06-UI-SPEC.md section 18.2). */
export const HOME_REFRESH_MS = 60_000;

export const adminKeys = (userId: string) => {
  const all = [...userScope(userId), 'admin'] as const;
  return {
    all,
    autonomy: [...userScope(userId), 'autonomy'] as const,
    stats: [...all, 'stats'] as const,
    slaList: [...all, 'home-sla'] as const,
    unassignedList: [...all, 'home-unassigned'] as const,
    unassignedStats: [...all, 'home-unassigned-by-queue'] as const,
    ready: [...all, 'ready'] as const,
    users: [...all, 'users'] as const,
    orgs: [...all, 'orgs'] as const,
    org: (id: string) => [...all, 'org', id] as const,
    contacts: (orgId: string) => [...all, 'contacts', orgId] as const,
    slaPolicies: [...all, 'sla-policies'] as const,
    calendars: [...all, 'calendars'] as const,
    calendar: (id: string) => [...all, 'calendar', id] as const,
    intentHistory: (id: string) => [...all, 'intent-history', id] as const,
    integrations: [...all, 'integrations'] as const,
    gmailStatus: [...all, 'gmail-status'] as const,
    channelAccounts: [...all, 'channel-accounts'] as const,
    csatSettings: [...all, 'csat-settings'] as const,
    uploadScan: [...all, 'upload-scan'] as const,
    orgTiers: [...all, 'org-tiers'] as const,
    outboxHealth: [...all, 'outbox-health'] as const,
    outboxDead: [...all, 'outbox-dead'] as const,
    auditAll: [...all, 'audit'] as const,
    audit: (filters: unknown) => [...all, 'audit', filters] as const,
  };
};

/**
 * Both AI switches and every intent's stage. Polled every 30 s on every staff screen (spec section
 * 18.4) and refetched after a flip. Any staff member may read it.
 */
export function useAutonomy(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: adminKeys(userId).autonomy,
    queryFn: ({ signal }) => api.autonomy(signal),
    enabled,
    refetchInterval: AUTONOMY_POLL_MS,
    staleTime: AUTONOMY_POLL_MS / 2,
  });
}

/** Today's AI spend against the caps (T-142). Lead and head; refreshed every minute. */
export function useAiBudget(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: [...adminKeys(userId).all, 'ai-budget'] as const,
    queryFn: ({ signal }) => api.aiBudget(signal),
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

/** The counts for Home. Same filter vocabulary as the ticket list. */
export function useTicketStats(enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: adminKeys(userId).stats,
    queryFn: ({ signal }) => api.ticketStats({ status: OPEN_WORK_STATUSES }, signal),
    enabled,
    refetchInterval: HOME_REFRESH_MS,
    staleTime: HOME_REFRESH_MS / 2,
  });
}

/**
 * Open work nobody holds, counted per team queue (T-141): the same counts endpoint and the same open
 * statuses as the rest of Home, filtered to `assignee=unassigned`, so its queue numbers add up to the
 * Unassigned tile.
 */
export function useUnassignedByQueue(enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: adminKeys(userId).unassignedStats,
    queryFn: ({ signal }) =>
      api.ticketStats({ status: OPEN_WORK_STATUSES, assignee: 'unassigned' }, signal),
    enabled,
    refetchInterval: HOME_REFRESH_MS,
    staleTime: HOME_REFRESH_MS / 2,
  });
}

/** Tickets whose SLA is at risk or past due, most urgent first (the server decides): the top-10 list. */
export function useSlaRiskTickets(enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: adminKeys(userId).slaList,
    queryFn: ({ signal }) =>
      api.listTickets(
        { slaState: ['at_risk', 'breached'], sort: 'sla_due_asc', limit: 50 },
        signal,
      ),
    enabled,
    refetchInterval: HOME_REFRESH_MS,
    staleTime: HOME_REFRESH_MS / 2,
  });
}

/** The oldest ticket nobody owns yet, for the "oldest" age on the Unassigned tile. */
export function useOldestUnassigned(enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: adminKeys(userId).unassignedList,
    queryFn: ({ signal }) =>
      api.listTickets(
        {
          status: [...OPEN_WORK_STATUSES],
          assignee: 'unassigned',
          sort: 'created_asc',
          limit: 1,
        },
        signal,
      ),
    enabled,
    refetchInterval: HOME_REFRESH_MS,
    staleTime: HOME_REFRESH_MS / 2,
  });
}

export function useOrgTiers(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: adminKeys(userId).orgTiers,
    queryFn: ({ signal }) => api.orgTiers(signal),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** How late the outbox is running; refreshed every 30 s while the page is open (PRD section 8.3). */
export const OUTBOX_POLL_MS = 30_000;

export function useOutboxHealth(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: adminKeys(userId).outboxHealth,
    queryFn: ({ signal }) => api.outboxHealth(signal),
    enabled,
    refetchInterval: OUTBOX_POLL_MS,
    staleTime: OUTBOX_POLL_MS / 2,
  });
}

/** The dead-letter rows, newest first, fifty at a time. */
export function useDeadOutbox(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useInfiniteQuery({
    queryKey: adminKeys(userId).outboxDead,
    queryFn: ({ pageParam, signal }) => api.deadOutbox(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useReadiness(enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: adminKeys(userId).ready,
    queryFn: ({ signal }) => api.ready(signal),
    enabled,
    refetchInterval: HOME_REFRESH_MS,
    staleTime: HOME_REFRESH_MS / 2,
  });
}

export function useUsers(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: adminKeys(userId).users,
    queryFn: ({ signal }) => api.users(signal),
    enabled,
    staleTime: 60_000,
  });
}

export function useOrgs(query: Pick<OrganizationListQuery, 'q' | 'status'>, enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useInfiniteQuery({
    queryKey: [...adminKeys(userId).orgs, query],
    queryFn: ({ pageParam, signal }) =>
      api.orgs({ ...query, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
    staleTime: 30_000,
  });
}

export function useOrg(orgId: string) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: adminKeys(userId).org(orgId),
    queryFn: ({ signal }) => api.org(orgId, signal),
    staleTime: 30_000,
  });
}

export function useContacts(orgId: string) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: adminKeys(userId).contacts(orgId),
    queryFn: ({ signal }) => api.contacts(orgId, signal),
    staleTime: 30_000,
  });
}

export function useSlaPolicies(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: adminKeys(userId).slaPolicies,
    queryFn: ({ signal }) => api.slaPolicies(signal),
    enabled,
    staleTime: 60_000,
  });
}

export function useCalendars(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: adminKeys(userId).calendars,
    queryFn: ({ signal }) => api.calendars(signal),
    enabled,
    staleTime: 60_000,
  });
}

export function useCalendar(calendarId: string) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: adminKeys(userId).calendar(calendarId),
    queryFn: ({ signal }) => api.calendar(calendarId, signal),
    staleTime: 30_000,
  });
}

export function useIntentHistory(intentId: string, enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: adminKeys(userId).intentHistory(intentId),
    queryFn: ({ signal }) => api.intentAutonomyHistory(intentId, signal),
    enabled,
    staleTime: 10_000,
  });
}

export type AuditFilters = Pick<
  AuditLogQuery,
  'actorId' | 'actorType' | 'action' | 'outcome' | 'targetType' | 'targetId' | 'from' | 'to'
>;

export function useAuditLogs(filters: AuditFilters) {
  const api = useApi();
  const userId = useUserId();
  return useInfiniteQuery({
    queryKey: adminKeys(userId).audit(filters),
    queryFn: ({ pageParam, signal }) =>
      api.auditLogs({ ...filters, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  });
}

/** Credential status per integration. Never a value (ADR-012). */
export function useIntegrations(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: adminKeys(userId).integrations,
    queryFn: ({ signal }) => api.integrations(signal),
    enabled,
    staleTime: 10_000,
  });
}

export function useGmailStatus(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: adminKeys(userId).gmailStatus,
    queryFn: ({ signal }) => api.gmailStatus(signal),
    enabled,
    staleTime: 10_000,
  });
}

export function useChannelAccounts(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: adminKeys(userId).channelAccounts,
    queryFn: ({ signal }) => api.channelAccounts(signal),
    enabled,
    staleTime: 10_000,
  });
}

export function useUploadScan(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: adminKeys(userId).uploadScan,
    queryFn: ({ signal }) => api.uploadScan(signal),
    enabled,
    staleTime: 10_000,
  });
}

export function useCsatSettings(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: adminKeys(userId).csatSettings,
    queryFn: ({ signal }) => api.csatSettings(signal),
    enabled,
    staleTime: 10_000,
  });
}
