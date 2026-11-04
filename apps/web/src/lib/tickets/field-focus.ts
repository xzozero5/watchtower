import { useEffect, useRef } from 'react';

/** The ticket fields a shortcut or palette command can jump to (docs/06-UI-SPEC.md section 14). */
export type TicketField = 'status' | 'priority' | 'assignee';

/** DOM ids of those fields in the details panel. */
export const TICKET_FIELD_ID: Readonly<Record<TicketField, string>> = {
  status: 'ticket-field-status',
  priority: 'ticket-field-priority',
  assignee: 'ticket-field-assignee',
};

const EVENT = 'wt:ticket-field';

/** Asks the open workspace to show the details panel and focus a field. No-op off the queue. */
export function requestTicketField(field: TicketField): void {
  window.dispatchEvent(new CustomEvent<TicketField>(EVENT, { detail: field }));
}

/** Calls `handler` whenever something (the palette) asks for a ticket field. */
export function useTicketFieldRequests(
  handler: (field: TicketField) => void,
  enabled = true,
): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    const onRequest = (event: Event) => {
      latest.current((event as CustomEvent<TicketField>).detail);
    };
    window.addEventListener(EVENT, onRequest);
    return () => {
      window.removeEventListener(EVENT, onRequest);
    };
  }, [enabled]);
}
