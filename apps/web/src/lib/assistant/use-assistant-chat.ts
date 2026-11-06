'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AssistantContext,
  AssistantLocale,
  AssistantReply,
  AssistantPhaseEvent,
  AssistantState,
  AssistantStarters,
  ProposalCard,
} from '@watchtower/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApi } from '@/lib/api/api-context';
import { isApiError } from '@/lib/api/errors';
import { AssistantStreamError } from '@/lib/api/assistant-stream';
import { useUserId } from '@/lib/auth/session';
import { ticketKeys } from '@/lib/tickets/queries';
import { assistantKeys } from './library';

export type ChatErrorKind = 'generic' | 'forbidden' | 'rate' | 'notFound';

/** Why a card shows no buttons: what happened to it, as a message key suffix. */
export type ProposalOutcome =
  'done' | 'rejected' | 'expired' | 'stale' | 'failed' | 'forbidden' | 'gone';

export interface ProposalView {
  card: ProposalCard;
  busy: boolean;
  outcome: ProposalOutcome | null;
  /** Where "Open" goes after the press. */
  href: string | null;
}

export type Turn =
  { id: string; kind: 'user'; text: string } | { id: string; kind: 'ai'; reply: AssistantReply };

export const startersKey = (userId: string, page: string, ticket: string, locale: string) =>
  [userId, 'assistant', 'starters', page, ticket, locale] as const;

/** `GET /v1/assistant/starters`: the state of the assistant and up to three prompts. No model call. */
export function useAssistantStarters(params: {
  enabled: boolean;
  locale: AssistantLocale;
  page: AssistantContext['page'];
  ticket: string | null;
}) {
  const api = useApi();
  const userId = useUserId();
  return useQuery<AssistantStarters>({
    queryKey: startersKey(userId, params.page ?? '', params.ticket ?? '', params.locale),
    queryFn: ({ signal }) =>
      api.assistantStarters(
        {
          locale: params.locale,
          ...(params.page ? { page: params.page } : {}),
          ...(params.ticket ? { ticket: params.ticket } : {}),
        },
        signal,
      ),
    enabled: params.enabled,
    retry: false,
    staleTime: 15_000,
  });
}

function errorKind(error: unknown): ChatErrorKind {
  if (!isApiError(error)) return 'generic';
  if (error.code === 'csrf_invalid') return 'generic';
  if (error.status === 403) return 'forbidden';
  if (error.status === 429) return 'rate';
  if (error.status === 404) return 'notFound';
  return 'generic';
}

let counter = 0;
const nextId = () => `t${String((counter += 1))}`;

/**
 * One conversation with the assistant. The server holds the history (and a person's own
 * conversation only); this keeps what is on screen, the id to continue it, and the state of each
 * proposal card. A failed message stays on screen and `retry` sends the same text again.
 */
export function useAssistantChat() {
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [phase, setPhase] = useState<AssistantPhaseEvent | null>(null);
  const [error, setError] = useState<ChatErrorKind | null>(null);
  const [stopped, setStopped] = useState(false);
  const [state, setState] = useState<AssistantState>('ok');
  const [proposals, setProposals] = useState<Record<string, ProposalView>>({});
  const abort = useRef<AbortController | null>(null);
  const failed = useRef<{
    text: string;
    locale: AssistantLocale;
    context?: AssistantContext;
  } | null>(null);
  const conversation = useRef<string | null>(null);
  useEffect(
    () => () => {
      abort.current?.abort();
    },
    [],
  );

  const run = useCallback(
    async (text: string, locale: AssistantLocale, context: AssistantContext | undefined) => {
      const controller = new AbortController();
      abort.current = controller;
      setPending(true);
      setPhase(null);
      // A failed turn is not an availability probe. A retry/Stop clears its transient failure;
      // paused/budget remain authoritative, and the panel still consults fresh starters when ok.
      setState((current) => (current === 'unavailable' ? 'ok' : current));
      setError(null);
      setStopped(false);
      failed.current = { text, locale, ...(context ? { context } : {}) };
      try {
        const reply = await api.assistantMessage(
          {
            text,
            locale,
            ...(conversation.current ? { conversationId: conversation.current } : {}),
            ...(context ? { context } : {}),
          },
          controller.signal,
          (event) => {
            if (controller.signal.aborted || abort.current !== controller) return;
            setPhase(event);
            if (event.phase === 'error') setState(event.state);
          },
        );
        if (controller.signal.aborted || abort.current !== controller) return;
        conversation.current = reply.conversationId;
        setConversationId(reply.conversationId);
        setState(reply.state);
        void queryClient.invalidateQueries({ queryKey: assistantKeys(userId).conversations });
        failed.current = null;
        setTurns((current) => [...current, { id: nextId(), kind: 'ai', reply }]);
        setProposals((current) => {
          const next = { ...current };
          for (const card of reply.proposals) {
            next[card.id] = { card, busy: false, outcome: null, href: null };
          }
          return next;
        });
      } catch (caught) {
        if (abort.current !== controller) return;
        if (controller.signal.aborted) {
          failed.current = null;
          setStopped(true);
        } else {
          setError(
            caught instanceof AssistantStreamError && caught.event.reason === 'assistant_queue_full'
              ? 'rate'
              : errorKind(caught),
          );
        }
      } finally {
        if (abort.current === controller) {
          abort.current = null;
          setPending(false);
          setPhase(null);
        }
      }
    },
    [api, queryClient, userId],
  );

  const send = useCallback(
    (text: string, locale: AssistantLocale, context: AssistantContext | undefined) => {
      const trimmed = text.trim();
      if (trimmed === '' || abort.current !== null) return;
      setTurns((current) => [...current, { id: nextId(), kind: 'user', text: trimmed }]);
      void run(trimmed, locale, context);
    },
    [run],
  );

  const retry = useCallback(() => {
    const last = failed.current;
    if (last === null || abort.current !== null) return;
    void run(last.text, last.locale, last.context);
  }, [run]);

  const stop = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    failed.current = null;
    setPending(false);
    setPhase(null);
    setStopped(true);
    setState((current) => (current === 'unavailable' ? 'ok' : current));
  }, []);

  const clear = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setPending(false);
    setPhase(null);
    conversation.current = null;
    failed.current = null;
    setConversationId(null);
    setTurns([]);
    setProposals({});
    setError(null);
    setStopped(false);
    setState('ok');
    // New chat preserves the server's history. Deletion is an explicit library action.
  }, []);

  const patch = useCallback((id: string, change: Partial<ProposalView>) => {
    setProposals((current) => {
      const existing = current[id];
      return existing ? { ...current, [id]: { ...existing, ...change } } : current;
    });
  }, []);

  const clearIfCurrent = useCallback(
    (id: string) => {
      if (conversation.current === id) clear();
    },
    [clear],
  );

  const confirm = useCallback(
    async (id: string) => {
      patch(id, { busy: true });
      try {
        const answer = await api.confirmProposal(id);
        patch(id, {
          card: answer.proposal,
          busy: false,
          outcome: answer.outcome === 'done' ? 'done' : 'stale',
          href: answer.result?.href ?? null,
        });
        if (answer.outcome === 'done') {
          await queryClient.invalidateQueries({ queryKey: ticketKeys(userId).all });
        }
      } catch (caught) {
        const status = isApiError(caught) ? caught.status : 0;
        patch(id, {
          busy: false,
          outcome:
            status === 403 ? 'forbidden' : status === 404 || status === 409 ? 'gone' : 'failed',
        });
      }
    },
    [api, patch, queryClient, userId],
  );

  const reject = useCallback(
    async (id: string) => {
      patch(id, { busy: true });
      try {
        const answer = await api.rejectProposal(id);
        patch(id, { card: answer.proposal, busy: false, outcome: 'rejected' });
      } catch (caught) {
        const status = isApiError(caught) ? caught.status : 0;
        patch(id, { busy: false, outcome: status === 404 || status === 409 ? 'gone' : 'failed' });
      }
    },
    [api, patch],
  );

  return {
    turns,
    conversationId,
    pending,
    phase,
    error,
    stopped,
    state,
    proposals,
    send,
    retry,
    stop,
    clear,
    clearIfCurrent,
    confirm,
    reject,
  };
}
