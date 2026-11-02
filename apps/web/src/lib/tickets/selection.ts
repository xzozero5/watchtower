'use client';

import { ticketRefSchema } from '@watchtower/shared';
import { useCallback, useEffect, useState } from 'react';

export const TICKET_PARAM = 'ticket';

/** The ticket named in the address (`/?ticket=OPS-12`), or null if absent or not a valid reference. */
export function readSelectedTicket(search: string): string | null {
  const value = new URLSearchParams(search).get(TICKET_PARAM);
  if (value === null) return null;
  const parsed = ticketRefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The address for a selection, keeping any other query parameters. */
export function withSelectedTicket(search: string, key: string | null): string {
  const params = new URLSearchParams(search);
  if (key === null) params.delete(TICKET_PARAM);
  else params.set(TICKET_PARAM, key);
  const query = params.toString();
  return query === '' ? '/' : `/?${query}`;
}

const OPEN_EVENT = 'wt:open-ticket';

/** Asks the workspace on screen to open a ticket (the command palette's "Go to ticket"). */
export function requestOpenTicket(key: string): void {
  window.dispatchEvent(new CustomEvent<string>(OPEN_EVENT, { detail: key }));
}

/**
 * Which ticket is open, kept in the address so a reload or a shared link lands on the same ticket.
 * Uses replaceState: moving through the queue with J/K must not fill the back button's history.
 * Only call it from components that render on the client (the workspace does: it sits behind the
 * auth gate).
 */
export function useSelectedTicket(): readonly [string | null, (key: string | null) => void] {
  const [selected, setSelected] = useState<string | null>(() =>
    readSelectedTicket(window.location.search),
  );

  useEffect(() => {
    const onPop = () => {
      setSelected(readSelectedTicket(window.location.search));
    };
    const onOpen = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== 'string') return;
      const parsed = ticketRefSchema.safeParse(event.detail);
      if (!parsed.success) return;
      setSelected(parsed.data);
      window.history.replaceState(
        null,
        '',
        withSelectedTicket(window.location.search, parsed.data),
      );
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  const select = useCallback((key: string | null) => {
    setSelected(key);
    window.history.replaceState(null, '', withSelectedTicket(window.location.search, key));
  }, []);

  return [selected, select];
}
