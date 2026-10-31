import {
  authConfigSchema,
  intentListSchema,
  magicLinkAcceptedSchema,
  replyResultSchema,
  sessionInfoSchema,
  teamQueueListSchema,
  ticketDetailResponseSchema,
  ticketListSchema,
  timelinePageSchema,
  workflowSchema,
  type AssignTicket,
  type BreakGlassLogin,
  type ChangeStatus,
  type DevLoginRequest,
  type Note,
  type Reply,
  type TicketListQuery,
  type UpdateTicket,
} from '@watchtower/shared';
import { createAdminEndpoints } from './admin-endpoints';
import type { ApiClient } from './client';

/** Query for the ticket list as the UI builds it: the schema defaults are applied by the api. */
export type TicketListParams = Partial<
  Pick<
    TicketListQuery,
    | 'status'
    | 'priority'
    | 'assignee'
    | 'intentId'
    | 'tag'
    | 'q'
    | 'overdue'
    | 'sort'
    | 'limit'
    | 'cursor'
    | 'queueId'
  >
>;

/** One function per endpoint the web app uses. No component builds a URL by hand. */
export function createEndpoints(client: ApiClient) {
  const refPath = (ref: string) => `/v1/tickets/${encodeURIComponent(ref)}`;

  return {
    ...createAdminEndpoints(client),

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
