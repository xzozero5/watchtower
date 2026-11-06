import {
  assistantReplySchema,
  assistantConversationListSchema,
  assistantMemoryListSchema,
  assistantMemorySchema,
  assistantFeedbackSchema,
  createAssistantMemorySchema,
  assistantFeedbackRequestSchema,
  clearAssistantMemoryResponseSchema,
  deleteAssistantMemoryResponseSchema,
  assistantStartersSchema,
  confirmProposalResponseSchema,
  deleteConversationResponseSchema,
  rejectProposalResponseSchema,
  type AssistantMessageRequest,
  type AssistantPhaseEvent,
  type AssistantStartersQuery,
  type CreateAssistantMemory,
  type AssistantFeedbackRequest,
} from '@watchtower/shared';

import type { ApiClient } from './client';
import { readAssistantStream } from './assistant-stream';

/** The AI assistant (T-134, ADR-023): `/v1/assistant/*`. Staff only; a client gets a 403. */
export function createAssistantEndpoints(client: ApiClient) {
  return {
    assistantConversations: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/assistant/conversations',
        schema: assistantConversationListSchema,
        signal,
      }),
    assistantMemory: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/assistant/memory',
        schema: assistantMemoryListSchema,
        signal,
      }),
    pinAssistantMemory: (body: CreateAssistantMemory) =>
      client.request({
        method: 'POST',
        path: '/v1/assistant/memory',
        body: createAssistantMemorySchema.parse(body),
        schema: assistantMemorySchema,
        replayAfterAuth: false,
      }),
    deleteAssistantMemory: (id: string) =>
      client.request({
        method: 'DELETE',
        path: `/v1/assistant/memory/${encodeURIComponent(id)}`,
        schema: deleteAssistantMemoryResponseSchema,
      }),
    clearAssistantMemory: () =>
      client.request({
        method: 'DELETE',
        path: '/v1/assistant/memory',
        schema: clearAssistantMemoryResponseSchema,
      }),
    assistantFeedback: (body: AssistantFeedbackRequest) =>
      client.request({
        method: 'POST',
        path: '/v1/assistant/feedback',
        body: assistantFeedbackRequestSchema.parse(body),
        schema: assistantFeedbackSchema,
        replayAfterAuth: false,
      }),
    assistantStarters: (query: AssistantStartersQuery, signal?: AbortSignal) =>
      client.request({
        path: '/v1/assistant/starters',
        query: { locale: query.locale, page: query.page, ticket: query.ticket },
        schema: assistantStartersSchema,
        ...(signal ? { signal } : {}),
      }),

    assistantMessage: (
      body: AssistantMessageRequest,
      signal?: AbortSignal,
      onPhase: (event: AssistantPhaseEvent) => void = () => undefined,
    ) =>
      client.request({
        method: 'POST',
        path: '/v1/assistant/messages',
        body,
        schema: assistantReplySchema,
        accept: 'text/event-stream',
        replayAfterAuth: false,
        readResponse: (response, requestSignal) =>
          readAssistantStream(response, onPhase, requestSignal),
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
