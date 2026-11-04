'use client';

import type { AssistantContext, AssistantPage } from '@watchtower/shared';
import { useEffect, useState } from 'react';

import { readSelectedTicket } from '@/lib/tickets/selection';

/** The page kind the api's `context.page` knows, from the address. Nothing is guessed beyond it. */
export function pageOfPath(pathname: string, ticket: string | null): AssistantPage {
  const parts = pathname.split('/').filter((part) => part !== '');
  const first = parts[0] ?? '';
  if (first === '') return ticket === null ? 'queue' : 'ticket';
  if (first === 'shift') {
    if (parts[1] === 'brief') return 'brief';
    if (parts[1] === 'handoff') return 'handoff';
    return 'other';
  }
  if (first === 'home' || first === 'dashboard') return 'dashboard';
  if (first === 'incidents' || first === 'alerts') return 'incident';
  return 'other';
}

/** The ticket named in the address, only on the queue page where the workspace keeps it. */
export function ticketOfLocation(pathname: string, search: string): string | null {
  return pathname === '/' ? readSelectedTicket(search) : null;
}

export interface PageContext {
  page: AssistantPage;
  ticket: string | null;
}

const POLL_MS = 600;

/**
 * What the chips above the input say, kept up to date. The queue keeps the open ticket in the
 * address with `replaceState`, which fires no event, so while the panel is open the address is read
 * again every so often. No hidden context: the chips are exactly what is sent (the person can
 * remove either).
 */
export function usePageContext(pathname: string, active: boolean): PageContext {
  const read = (): PageContext => {
    const ticket = ticketOfLocation(pathname, window.location.search);
    return { page: pageOfPath(pathname, ticket), ticket };
  };
  const [context, setContext] = useState<PageContext>(read);

  useEffect(() => {
    const update = () => {
      const next = read();
      setContext((current) =>
        current.page === next.page && current.ticket === next.ticket ? current : next,
      );
    };
    update();
    if (!active) return undefined;
    const timer = window.setInterval(update, POLL_MS);
    window.addEventListener('popstate', update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('popstate', update);
    };
    // `read` closes over `pathname` only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, active]);

  return context;
}

/** The request context for the chips that are still on. */
export function contextForRequest(
  context: PageContext,
  removed: { page: boolean; ticket: boolean },
): AssistantContext | undefined {
  const result: AssistantContext = {};
  if (!removed.page) result.page = context.page;
  if (!removed.ticket && context.ticket !== null) result.ticket = context.ticket;
  return Object.keys(result).length === 0 ? undefined : result;
}
