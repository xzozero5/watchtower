'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiRequest, RejectAiDraft, TicketAiInsight } from '@watchtower/shared';

import { useApi } from '@/lib/api/api-context';
import { isApiError } from '@/lib/api/errors';
import { useUserId } from '@/lib/auth/session';
import { ticketKeys } from '@/lib/tickets/queries';

export const aiKey = (userId: string, ticketKey: string) =>
  [...ticketKeys(userId).all, 'ai', ticketKey] as const;

/**
 * The AI brief of a ticket (`GET /v1/tickets/:id/ai`). Any failure, a 404 from an api that does not
 * serve it yet included, simply means "unavailable": no retry, and the UI says so and shows nothing
 * else (N5: it never fills the gap with made-up content).
 */
export function useTicketAi(ticketKey: string | null, enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: aiKey(userId, ticketKey ?? ''),
    queryFn: ({ signal }) => api.ticketAi(ticketKey ?? '', signal),
    enabled: enabled && ticketKey !== null,
    retry: false,
    staleTime: 30_000,
  });
}

/** What the cached brief looks like once its draft has been dealt with. */
export function withoutDraft(
  insight: TicketAiInsight,
  draftId: string,
  state: TicketAiInsight['state'],
): TicketAiInsight {
  if (insight.draft?.id !== draftId) return insight;
  const next: TicketAiInsight = { ...insight, state };
  delete next.draft;
  return next;
}

/** Actions on the draft of one ticket: reject it, or drop it from view after it was sent. */
export function useAiDraftActions(ticketKey: string) {
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const key = aiKey(userId, ticketKey);

  const settle = (draftId: string, state: TicketAiInsight['state']) => {
    queryClient.setQueryData<TicketAiInsight>(key, (current) =>
      current ? withoutDraft(current, draftId, state) : current,
    );
    void queryClient.invalidateQueries({ queryKey: key });
  };

  return {
    reject: useMutation({
      mutationFn: ({ draftId, body }: { draftId: string; body: RejectAiDraft }) =>
        api.rejectAiDraft(ticketKey, draftId, body),
      onSuccess: (_result, { draftId }) => {
        settle(draftId, 'needs_human');
      },
    }),
    /** Read the brief again, for example after a send was refused. */
    refresh: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
    /** The draft was sent (a person approved it): it is no longer waiting for a decision. */
    sent: (draftId: string) => {
      settle(draftId, 'classified');
    },
  };
}

/**
 * The escalation cards of a ticket (T-303f, `GET /v1/tickets/:id/procedure-proposals`): asked only when the report
 * of the brief says a procedure step proposed one (`enabled`). A failure means "no cards": the brief stays as it is.
 */
export function useProcedureProposals(ticketKey: string, enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: [...aiKey(userId, ticketKey), 'procedure-proposals'] as const,
    queryFn: ({ signal }) => api.procedureProposals(ticketKey, signal),
    enabled,
    retry: false,
    staleTime: 15_000,
  });
}

/**
 * Presses one card. The ticket may have changed (queue, priority, a note, a notification), so the ticket, its
 * timeline and the brief are read again; a 409 (expired) also refreshes the card list so it shows why.
 */
export function useApplyProcedureProposal(ticketKey: string) {
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ticketKeys(userId).all });
  return useMutation({
    mutationFn: (proposalId: string) => api.applyProcedureProposal(ticketKey, proposalId),
    onSuccess: refresh,
    onError: (failure) => {
      if (isApiError(failure) && failure.status === 409) void refresh();
    },
  });
}

/**
 * "Draft a reply" / "Investigate again": the api answers 202 at once and the job runs in the
 * worker; its progress reaches this tab as `ticket.updated` events (`changed: ['ai']`) that
 * re-read the brief. The brief is read once more here so the `investigating` state shows without
 * waiting for the first event.
 */
export function useAiRequest(ticketKey: string) {
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AiRequest) => api.requestAi(ticketKey, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: aiKey(userId, ticketKey) });
    },
  });
}
