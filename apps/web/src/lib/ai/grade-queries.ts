'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import { ticketKeys, userScope } from '@/lib/tickets/queries';

export const gradeKeys = (userId: string) => {
  const all = [...userScope(userId), 'grades'] as const;
  return {
    all,
    ticket: (ticketKey: string) => [...ticketKeys(userId).all, 'grade', ticketKey] as const,
    metrics: (days: number) => [...all, 'metrics', days] as const,
    goldenOfTicket: (ticketKey: string) =>
      [...ticketKeys(userId).all, 'golden', ticketKey] as const,
    golden: [...all, 'golden'] as const,
  };
};

/**
 * The grader's verdict on a resolved ticket (T-301d). `grade: null` means the grader has not looked yet.
 * No retry: a failure says "unavailable" and nothing else is drawn in its place (N5).
 */
export function useTicketGrade(ticketKey: string, enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: gradeKeys(userId).ticket(ticketKey),
    queryFn: ({ signal }) => api.ticketGrade(ticketKey, signal),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}

/** Grader numbers per intent over a window of days (lead and head). The old window stays while a new one loads. */
export function useIntentGradeMetrics(days: number, enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: gradeKeys(userId).metrics(days),
    queryFn: ({ signal }) => api.intentGradeMetrics(days, signal),
    enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

/** The replies of one ticket that are golden, so each reply can show its mark. */
export function useTicketGolden(ticketKey: string, enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: gradeKeys(userId).goldenOfTicket(ticketKey),
    queryFn: ({ signal }) => api.goldenOfTicket(ticketKey, signal),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}

/** The scrubbed text of a reply, fetched only while the lead has the shareable box ticked. */
export function useGoldenPreview(ticketKey: string, messageId: string, enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: [...gradeKeys(userId).goldenOfTicket(ticketKey), 'preview', messageId] as const,
    queryFn: ({ signal }) => api.goldenPreview(ticketKey, messageId, signal),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}

export function useMarkGolden(ticketKey: string) {
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { messageId: string; shareable: boolean }) =>
      api.markGolden(ticketKey, input.messageId, input.shareable),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: gradeKeys(userId).goldenOfTicket(ticketKey) });
      void queryClient.invalidateQueries({ queryKey: gradeKeys(userId).golden });
    },
  });
}

/** Every live golden answer (the admin list). */
export function useGoldenAnswers(enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: gradeKeys(userId).golden,
    queryFn: ({ signal }) => api.goldenAnswers(signal),
    enabled,
    staleTime: 30_000,
  });
}

export function useDeleteGolden() {
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteGolden(id),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: gradeKeys(userId).golden });
      void queryClient.invalidateQueries({
        queryKey: [...ticketKeys(userId).all, 'golden'] as const,
      });
    },
  });
}
