'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RunTool } from '@watchtower/shared';

import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import { userScope } from '@/lib/tickets/queries';

/** The investigation buttons and pinned results of one ticket (T-203e). */
export const toolKeys = (userId: string, ticketKey: string) => {
  const all = [...userScope(userId), 'tools', ticketKey] as const;
  return { all, buttons: [...all, 'buttons'] as const, cards: [...all, 'cards'] as const };
};

/** Which checks the ticket has. Nothing here runs anything. */
export function useTicketTools(ticketKey: string, enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: toolKeys(userId, ticketKey).buttons,
    queryFn: ({ signal }) => api.ticketTools(ticketKey, signal),
    enabled,
    staleTime: 30_000,
  });
}

/** The results pinned to the ticket, newest first. */
export function useTicketCards(ticketKey: string, enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: toolKeys(userId, ticketKey).cards,
    queryFn: ({ signal }) => api.ticketEvidenceCards(ticketKey, signal),
    enabled,
  });
}

/** Run one check (a read-only tool) and pin what it found; the pinned list is refetched. */
export function useRunTool(ticketKey: string) {
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Pick<RunTool, 'templateId'> & Partial<RunTool>) =>
      api.runTicketTool(ticketKey, body),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: toolKeys(userId, ticketKey).cards });
      // The budget and the connection may have changed what the buttons can do.
      void queryClient.invalidateQueries({ queryKey: toolKeys(userId, ticketKey).buttons });
    },
  });
}

export function useUnpinCard(ticketKey: string) {
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (cardId: string) => api.unpinEvidenceCard(ticketKey, cardId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: toolKeys(userId, ticketKey).cards });
    },
  });
}
