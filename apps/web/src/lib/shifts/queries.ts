'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import { userScope } from '@/lib/tickets/queries';

/** The shift state, the incoming list and the overview have no realtime event yet, so they poll. */
export const SHIFT_POLL_MS = 30_000;

export const shiftKeys = (userId: string) => {
  const all = [...userScope(userId), 'shifts'] as const;
  return {
    all,
    status: [...all, 'status'] as const,
    brief: [...all, 'brief'] as const,
    overview: [...all, 'overview'] as const,
    assignees: [...all, 'assignees'] as const,
    definitions: [...all, 'definitions'] as const,
    roster: (range: unknown) => [...all, 'roster', range] as const,
    rosterAll: [...all, 'roster'] as const,
    handoff: [...all, 'handoff'] as const,
    incoming: [...all, 'incoming'] as const,
    notesAll: [...all, 'notes'] as const,
    notes: (box: string, unread: boolean) => [...all, 'notes', box, unread] as const,
  };
};

export function useShiftStatus(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: shiftKeys(userId).status,
    queryFn: ({ signal }) => api.shiftStatus(signal),
    enabled,
    refetchInterval: SHIFT_POLL_MS,
    staleTime: SHIFT_POLL_MS / 2,
  });
}

export function useShiftBrief(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: shiftKeys(userId).brief,
    queryFn: ({ signal }) => api.shiftBrief(signal),
    enabled,
    refetchInterval: SHIFT_POLL_MS,
    staleTime: SHIFT_POLL_MS / 2,
  });
}

export function useShiftOverview(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: shiftKeys(userId).overview,
    queryFn: ({ signal }) => api.shiftOverview(signal),
    enabled,
    refetchInterval: SHIFT_POLL_MS,
    staleTime: SHIFT_POLL_MS / 2,
  });
}

/** Who can be assigned, with who is on shift (agents may not list users, so this is the picker's source). */
export function useAssignees(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: shiftKeys(userId).assignees,
    queryFn: ({ signal }) => api.assignees({}, signal),
    enabled,
    staleTime: 15_000,
  });
}

export function useShiftDefinitions(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: shiftKeys(userId).definitions,
    queryFn: ({ signal }) => api.shiftDefinitions(signal),
    enabled,
    staleTime: 60_000,
  });
}

export function useRoster(range: { from: string; to: string }, enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: shiftKeys(userId).roster(range),
    queryFn: ({ signal }) => api.roster(range, signal),
    enabled,
    staleTime: 15_000,
  });
}

export function useCurrentHandoff(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: shiftKeys(userId).handoff,
    queryFn: ({ signal }) => api.currentHandoff(signal),
    enabled,
    staleTime: 10_000,
  });
}

export function useIncomingHandoffs(enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: shiftKeys(userId).incoming,
    queryFn: ({ signal }) => api.incomingHandoffs(signal),
    enabled,
    refetchInterval: SHIFT_POLL_MS,
    staleTime: SHIFT_POLL_MS / 2,
  });
}

export function useShiftNotes(box: 'inbox' | 'sent', unread: boolean, enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useInfiniteQuery({
    queryKey: shiftKeys(userId).notes(box, unread),
    queryFn: ({ pageParam, signal }) =>
      api.shiftNotes({ box, unread, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
    staleTime: 15_000,
  });
}
