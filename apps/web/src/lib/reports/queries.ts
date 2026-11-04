'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CeoPointsBody, WeeklyBriefContent } from '@watchtower/shared';

import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import { userScope } from '@/lib/tickets/queries';

/** The reports are cheap to read but change slowly: a minute is fresh enough. */
export const REPORTS_POLL_MS = 60_000;

export const reportKeys = (userId: string) => {
  const all = [...userScope(userId), 'reports'] as const;
  return {
    all,
    aiCost: (days: number, top: number) => [...all, 'ai-cost', days, top] as const,
    ceo: (days: number) => [...all, 'ceo', days] as const,
    brief: [...all, 'brief'] as const,
  };
};

/** AI cost for a window. The last window stays on screen while a new one loads: nothing jumps. */
export function useAiCost(days: number, top: number, enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: reportKeys(userId).aiCost(days, top),
    queryFn: ({ signal }) => api.aiCost(days, top, signal),
    enabled,
    refetchInterval: REPORTS_POLL_MS,
    staleTime: REPORTS_POLL_MS / 2,
    placeholderData: keepPreviousData,
  });
}

export function useCeoView(days: number, enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: reportKeys(userId).ceo(days),
    queryFn: ({ signal }) => api.ceoView(days, signal),
    enabled,
    refetchInterval: REPORTS_POLL_MS,
    staleTime: REPORTS_POLL_MS / 2,
    placeholderData: keepPreviousData,
  });
}

/** Changing a pluggable tile refreshes every window of the CEO view. */
function useCeoRefresh() {
  const queryClient = useQueryClient();
  const userId = useUserId();
  return () => queryClient.invalidateQueries({ queryKey: [...reportKeys(userId).all, 'ceo'] });
}

export function useRecordCeoPoints() {
  const api = useApi();
  const refresh = useCeoRefresh();
  return useMutation({
    mutationFn: (body: CeoPointsBody) => api.recordCeoPoints(body),
    onSuccess: () => void refresh(),
  });
}

export function useImportCeoCsv() {
  const api = useApi();
  const refresh = useCeoRefresh();
  return useMutation({
    mutationFn: (csv: string) => api.importCeoCsv(csv),
    onSuccess: () => void refresh(),
  });
}

export function useDeleteCeoMetric() {
  const api = useApi();
  const refresh = useCeoRefresh();
  return useMutation({
    mutationFn: (key: string) => api.deleteCeoMetric(key),
    onSuccess: () => void refresh(),
  });
}

/** The newest published weekly brief (T-305c). It changes once a week: a minute is fresh enough. */
export function useWeeklyBrief(enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: [...reportKeys(userId).brief, 'published'],
    queryFn: ({ signal }) => api.weeklyBrief(signal),
    enabled,
    refetchInterval: REPORTS_POLL_MS,
    staleTime: REPORTS_POLL_MS / 2,
  });
}

/** The newest draft and the default recipients (head). Not polled: the head is editing it. */
export function useWeeklyBriefDraft(enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: [...reportKeys(userId).brief, 'draft'],
    queryFn: ({ signal }) => api.weeklyBriefDraft(signal),
    enabled,
    staleTime: REPORTS_POLL_MS / 2,
  });
}

function useBriefRefresh() {
  const queryClient = useQueryClient();
  const userId = useUserId();
  return () => queryClient.invalidateQueries({ queryKey: reportKeys(userId).brief });
}

export function useEditWeeklyBrief() {
  const api = useApi();
  const refresh = useBriefRefresh();
  return useMutation({
    mutationFn: (input: { id: string; content: WeeklyBriefContent }) =>
      api.editWeeklyBrief(input.id, input.content),
    onSuccess: () => void refresh(),
  });
}

export function usePublishWeeklyBrief() {
  const api = useApi();
  const refresh = useBriefRefresh();
  return useMutation({
    mutationFn: (input: { id: string; recipients: readonly string[] }) =>
      api.publishWeeklyBrief(input.id, input.recipients),
    onSuccess: () => void refresh(),
  });
}
