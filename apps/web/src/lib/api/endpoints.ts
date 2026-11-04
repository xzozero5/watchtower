import {
  aiBudgetSchema,
  aiModelMappingSchema,
  aiStatusSchema,
  authConfigSchema,
  bulkResultSchema,
  cancelSendResultSchema,
  convertOtherMailResultSchema,
  intentListSchema,
  lineQuotaSchema,
  magicLinkAcceptedSchema,
  manualTicketResultSchema,
  otherMailDetailSchema,
  otherMailPageSchema,
  outboundSettingsSchema,
  replyResultSchema,
  savedViewListSchema,
  savedViewSchema,
  sessionInfoSchema,
  similarTicketsSchema,
  teamQueueListSchema,
  ticketAiInsightSchema,
  ticketDetailResponseSchema,
  ticketListSchema,
  timelinePageSchema,
  workflowSchema,
  type AiRequest,
  type AssignTicket,
  type BreakGlassLogin,
  type BulkRequest,
  type ChangeStatus,
  type ConvertOtherMail,
  type CreateManualTicket,
  type CreateSavedView,
  type DevLoginRequest,
  type Note,
  type OtherMailQuery,
  type RejectAiDraft,
  type Reply,
  type SimilarTicketsQuery,
  type TicketListQuery,
  type UpdateTicket,
} from '@watchtower/shared';
import { createAdminEndpoints } from './admin-endpoints';
import { createNotificationEndpoints } from './notification-endpoints';
import { createOpsEndpoints } from './ops-endpoints';
import { createReportEndpoints } from './report-endpoints';
import { createShiftEndpoints } from './shift-endpoints';
import { createAssistantEndpoints } from './assistant-endpoints';
import { createGradeEndpoints } from './grade-endpoints';
import { createToolEndpoints } from './tool-endpoints';
import { createUploadEndpoints } from './upload-endpoints';
import type { ApiClient } from './client';

/** Query for the ticket list as the UI builds it: the schema defaults are applied by the api. */
export type TicketListParams = Partial<
  Pick<
    TicketListQuery,
    | 'status'
    | 'priority'
    | 'assignee'
    | 'devOwner'
    | 'intentId'
    | 'tag'
    | 'q'
    | 'overdue'
    | 'sort'
    | 'limit'
    | 'cursor'
    | 'queueId'
    | 'slaState'
    | 'allStatuses'
  >
>;

/** One function per endpoint the web app uses. No component builds a URL by hand. */
export function createEndpoints(client: ApiClient) {
  const refPath = (ref: string) => `/v1/tickets/${encodeURIComponent(ref)}`;

  return {
    ...createAdminEndpoints(client),
    ...createNotificationEndpoints(client),
    ...createShiftEndpoints(client),
    ...createOpsEndpoints(client),
    ...createReportEndpoints(client),
    ...createToolEndpoints(client),
    ...createUploadEndpoints(client),
    ...createAssistantEndpoints(client),
    ...createGradeEndpoints(client),

    downloadAttachment: (ref: string, messageId: string, index: number, signal?: AbortSignal) =>
      client.download(
        `${refPath(ref)}/messages/${encodeURIComponent(messageId)}/attachments/${String(index)}`,
        signal,
      ),

    /** The `index`-th remote picture of an inbound mail, fetched by the api (T-175); the page's CSP allows no remote host. */
    downloadRemoteImage: (ref: string, messageId: string, index: number, signal?: AbortSignal) =>
      client.download(
        `${refPath(ref)}/messages/${encodeURIComponent(messageId)}/remote-image?u=${String(index)}`,
        signal,
      ),

    // --- auth (public) ---
    authConfig: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/auth/config',
        schema: authConfigSchema,
        retryOnUnauthenticated: false,
        ...(signal ? { signal } : {}),
      }),

    /** `refresh: false` reads the session without trying to renew an expired one. */
    session: (signal?: AbortSignal, options: { refresh?: boolean } = {}) =>
      client
        .request({
          path: '/v1/auth/session',
          schema: sessionInfoSchema,
          retryOnUnauthenticated: options.refresh ?? true,
          ...(signal ? { signal } : {}),
        })
        .then((session) => {
          client.acceptSession(session);
          return session;
        }),

    devLogin: (body: DevLoginRequest) =>
      client
        .request({
          method: 'POST',
          path: '/v1/auth/dev-login',
          body,
          schema: sessionInfoSchema,
          retryOnUnauthenticated: false,
        })
        .then((session) => {
          client.acceptSession(session);
          return session;
        }),

    requestMagicLink: (email: string) =>
      client.request({
        method: 'POST',
        path: '/v1/auth/magic-link/request',
        body: { email },
        schema: magicLinkAcceptedSchema,
        retryOnUnauthenticated: false,
      }),

    verifyMagicLink: (token: string) =>
      client
        .request({
          method: 'POST',
          path: '/v1/auth/magic-link/verify',
          body: { token },
          schema: sessionInfoSchema,
          retryOnUnauthenticated: false,
        })
        .then((session) => {
          client.acceptSession(session);
          return session;
        }),

    breakGlass: (body: BreakGlassLogin) =>
      client
        .request({
          method: 'POST',
          path: '/v1/auth/break-glass',
          body,
          schema: sessionInfoSchema,
          retryOnUnauthenticated: false,
        })
        .then((session) => {
          client.acceptSession(session);
          return session;
        }),

    logout: () =>
      client
        .request({
          method: 'POST',
          path: '/v1/auth/logout',
          schema: null,
          retryOnUnauthenticated: false,
        })
        .finally(() => {
          client.clearSession();
        }),

    // --- tickets ---
    listTickets: (params: TicketListParams, signal?: AbortSignal) =>
      client.request({
        path: '/v1/tickets',
        query: params,
        schema: ticketListSchema,
        ...(signal ? { signal } : {}),
      }),

    getTicket: (ref: string, signal?: AbortSignal) =>
      client.request({
        path: refPath(ref),
        schema: ticketDetailResponseSchema,
        ...(signal ? { signal } : {}),
      }),

    timeline: (ref: string, cursor: string | undefined, signal?: AbortSignal) =>
      client.request({
        path: `${refPath(ref)}/timeline`,
        query: { cursor },
        schema: timelinePageSchema,
        ...(signal ? { signal } : {}),
      }),

    reply: (ref: string, body: Reply) =>
      client.request({
        method: 'POST',
        path: `${refPath(ref)}/replies`,
        body,
        schema: replyResultSchema,
      }),

    note: (ref: string, body: Note) =>
      client.request({
        method: 'POST',
        path: `${refPath(ref)}/notes`,
        body,
        schema: replyResultSchema,
      }),

    changeStatus: (ref: string, body: ChangeStatus) =>
      client.request({
        method: 'POST',
        path: `${refPath(ref)}/status`,
        body,
        schema: ticketDetailResponseSchema,
      }),

    /** The caller picks the ticket up as its developer, or lets it go (T-137). */
    devPickUp: (ref: string) =>
      client.request({
        method: 'POST',
        path: `${refPath(ref)}/dev-owner`,
        schema: ticketDetailResponseSchema,
      }),

    devRelease: (ref: string) =>
      client.request({
        method: 'DELETE',
        path: `${refPath(ref)}/dev-owner`,
        schema: ticketDetailResponseSchema,
      }),

    /** A ticket filed by hand: a call, a visit, a chat that is not connected (T-136). */
    createManualTicket: (body: CreateManualTicket) =>
      client.request({
        method: 'POST',
        path: '/v1/tickets/manual',
        body,
        schema: manualTicketResultSchema,
      }),

    /** Open tickets that may be the same request as the one being typed. */
    similarTickets: (query: SimilarTicketsQuery, signal?: AbortSignal) =>
      client.request({
        path: '/v1/tickets/similar',
        query,
        schema: similarTicketsSchema,
        ...(signal ? { signal } : {}),
      }),

    assign: (ref: string, body: AssignTicket) =>
      client.request({
        method: 'POST',
        path: `${refPath(ref)}/assign`,
        body,
        schema: ticketDetailResponseSchema,
      }),

    updateTicket: (ref: string, body: UpdateTicket) =>
      client.request({
        method: 'PATCH',
        path: refPath(ref),
        body,
        schema: ticketDetailResponseSchema,
      }),

    // --- bulk actions and saved views (T-119) ---
    /** Up to 100 tickets at once; the answer lists every ticket's outcome. */
    bulk: (body: BulkRequest) =>
      client.request({
        method: 'POST',
        path: '/v1/tickets/bulk',
        body,
        schema: bulkResultSchema,
      }),

    /** The built-in views with counts, then the team's and the caller's own. Staff only. */
    views: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/views',
        schema: savedViewListSchema,
        ...(signal ? { signal } : {}),
      }),

    createView: (body: CreateSavedView) =>
      client.request({ method: 'POST', path: '/v1/views', body, schema: savedViewSchema }),

    deleteView: (id: string) =>
      client.request({
        method: 'DELETE',
        path: `/v1/views/${encodeURIComponent(id)}`,
        schema: null,
      }),

    // --- Other mail (T-119) ---
    otherMail: (params: Partial<OtherMailQuery>, signal?: AbortSignal) =>
      client.request({
        path: '/v1/inbound/other-mail',
        query: params,
        schema: otherMailPageSchema,
        ...(signal ? { signal } : {}),
      }),

    otherMailItem: (id: string, signal?: AbortSignal) =>
      client.request({
        path: `/v1/inbound/other-mail/${encodeURIComponent(id)}`,
        schema: otherMailDetailSchema,
        ...(signal ? { signal } : {}),
      }),

    convertOtherMail: (id: string, body: ConvertOtherMail) =>
      client.request({
        method: 'POST',
        path: `/v1/inbound/other-mail/${encodeURIComponent(id)}/convert`,
        body,
        schema: convertOtherMailResultSchema,
      }),

    // --- AI brief (T-106e / T-108; an api that has no brief for a ticket answers 404) ---
    ticketAi: (ref: string, signal?: AbortSignal) =>
      client.request({
        path: `${refPath(ref)}/ai`,
        schema: ticketAiInsightSchema,
        ...(signal ? { signal } : {}),
      }),

    /** Whether the AI can be reached (online / offline / disabled), for the console banner (T-170). */
    aiStatus: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/ai/status',
        schema: aiStatusSchema,
        ...(signal ? { signal } : {}),
      }),

    /** Today's AI spend against the daily caps, and the heaviest assistant users (T-142). */
    aiBudget: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/ai/budget',
        schema: aiBudgetSchema,
        ...(signal ? { signal } : {}),
      }),

    /** Which model each AI agent uses, read-only (T-301c). */
    aiModels: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/ai/models',
        schema: aiModelMappingSchema,
        ...(signal ? { signal } : {}),
      }),

    rejectAiDraft: (ref: string, draftId: string, body: RejectAiDraft) =>
      client.request({
        method: 'POST',
        path: `${refPath(ref)}/ai/drafts/${encodeURIComponent(draftId)}/reject`,
        body,
        schema: null,
      }),

    /** "Draft a reply" or "Investigate again"; the api answers 202 and the brief shows progress. */
    requestAi: (ref: string, body: AiRequest) =>
      client.request({
        method: 'POST',
        path: `${refPath(ref)}/ai/requests`,
        body,
        schema: null,
      }),

    // --- sending (T-122d): the server holds a reply for the undo window ---
    cancelDelivery: (ref: string, deliveryId: string) =>
      client.request({
        method: 'POST',
        path: `${refPath(ref)}/deliveries/${encodeURIComponent(deliveryId)}/cancel`,
        schema: cancelSendResultSchema,
      }),

    outboundSettings: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/settings/outbound',
        schema: outboundSettingsSchema,
        ...(signal ? { signal } : {}),
      }),

    lineQuota: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/line/quota',
        schema: lineQuotaSchema,
        ...(signal ? { signal } : {}),
      }),

    // --- reference data for the editors ---
    intents: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/intents',
        schema: intentListSchema,
        ...(signal ? { signal } : {}),
      }),

    queues: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/queues',
        schema: teamQueueListSchema,
        ...(signal ? { signal } : {}),
      }),

    workflow: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/ticket-workflow',
        schema: workflowSchema,
        ...(signal ? { signal } : {}),
      }),
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
