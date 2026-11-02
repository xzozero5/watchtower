import {
  evidenceCardListSchema,
  evidenceCardSchema,
  ticketToolsSchema,
  type RunTool,
} from '@watchtower/shared';

import type { ApiClient } from './client';

const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

/**
 * The one-click investigation buttons of a ticket (T-203e, ADR-016): which buttons a ticket has, run
 * one, and the evidence cards it pinned. Read-only tools only; the ad-hoc routes have no function
 * here on purpose (they stay behind `investigate.adhoc`).
 */
export function createToolEndpoints(client: ApiClient) {
  const id = (value: string) => encodeURIComponent(value);

  return {
    ticketTools: (ticketRef: string, signal?: AbortSignal) =>
      client.request({
        path: `/v1/tickets/${id(ticketRef)}/tools`,
        schema: ticketToolsSchema,
        ...withSignal(signal),
      }),
    runTicketTool: (ticketRef: string, body: Pick<RunTool, 'templateId'> & Partial<RunTool>) =>
      client.request({
        method: 'POST',
        path: `/v1/tickets/${id(ticketRef)}/tools/run`,
        body,
        schema: evidenceCardSchema,
      }),
    ticketEvidenceCards: (ticketRef: string, signal?: AbortSignal) =>
      client.request({
        path: `/v1/tickets/${id(ticketRef)}/evidence`,
        schema: evidenceCardListSchema,
        ...withSignal(signal),
      }),
    unpinEvidenceCard: (ticketRef: string, cardId: string) =>
      client.request({
        method: 'DELETE',
        path: `/v1/tickets/${id(ticketRef)}/evidence/${id(cardId)}`,
        schema: null,
      }),
  };
}
