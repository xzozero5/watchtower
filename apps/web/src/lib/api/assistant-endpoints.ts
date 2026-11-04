import {
  assistantReplySchema,
  assistantStartersSchema,
  confirmProposalResponseSchema,
  deleteConversationResponseSchema,
  rejectProposalResponseSchema,
  type AssistantMessageRequest,
  type AssistantStartersQuery,
} from '@watchtower/shared';

import type { ApiClient } from './client';

/** The AI assistant (T-134, ADR-023): `/v1/assistant/*`. Staff only; a client gets a 403. */
export function createAssistantEndpoints(client: ApiClient) {
  return {
    assistantStarters: (query: AssistantStartersQuery, signal?: AbortSignal) =>
      client.request({
        path: '/v1/assistant/starters',
        query: { locale: query.locale, page: query.page, ticket: query.ticket },
        schema: assistantStartersSchema,
        ...(signal ? { signal } : {}),
      }),

    assistantMessage: (body: AssistantMessageRequest, signal?: AbortSignal) =>
      client.request({
        method: 'POST',
        path: '/v1/assistant/messages',
        body,
        schema: assistantReplySchema,
        ...(signal ? { signal } : {}),
      }),

    /** The one press. The server runs it with this person's permissions and checks again. */
    confirmProposal: (id: string) =>
      client.request({
        method: 'POST',
        path: `/v1/assistant/proposals/${encodeURIComponent(id)}/confirm`,
        schema: confirmProposalResponseSchema,
      }),

    rejectProposal: (id: string) =>
      client.request({
        method: 'POST',
        path: `/v1/assistant/proposals/${encodeURIComponent(id)}/reject`,
        schema: rejectProposalResponseSchema,
      }),

    deleteAssistantConversation: (id: string) =>
      client.request({
        method: 'DELETE',
        path: `/v1/assistant/conversations/${encodeURIComponent(id)}`,
        schema: deleteConversationResponseSchema,
      }),
  };
}
