import {
  defaultTransitionList,
  type AuthConfig,
  type ClientTicket,
  type RealtimeEvent,
  type Role,
  type SessionInfo,
  type TicketAiInsight,
  type TicketDetail,
  type TimelineEntry,
} from '@watchtower/shared';
import type { Page, Route, WebSocketRoute } from '@playwright/test';

import {
  INTENT,
  makeClientTicket,
  makeMessage,
  makeSession,
  makeTicket,
  uuid,
} from '../src/test/fixtures';

import { E2E_API_URL, E2E_PORT } from './constants';

/**
 * A stand-in for apps/api, served from the browser with `page.route` (the full-stack e2e is T-009).
 * It answers the same paths with the same JSON shapes, applies CORS for credentialed requests, and
 * keeps a log of what the page sent so a test can assert on requests.
 */
export const APP_ORIGIN = `http://127.0.0.1:${String(E2E_PORT)}`;

export interface RecordedRequest {
  method: string;
  path: string;
  search: string;
  body: unknown;
  csrf: string | undefined;
}

export interface BackendOptions {
  role?: Role;
  /** `null`: nobody is signed in. */
  session?: SessionInfo | null;
  tickets?: (TicketDetail | ClientTicket)[];
  timelines?: Record<string, TimelineEntry[]>;
  /** AI briefs by ticket key (GET /v1/tickets/:id/ai). A ticket without one answers 404, as the api does today. */
  ai?: Record<string, TicketAiInsight>;
  authConfig?: AuthConfig;
  /** HTTP status for /health, or `'down'` for a refused connection. */
  health?: number | 'down';
  /** Extra or replacement routes: `'METHOD /path'` to a responder. */
  routes?: Record<string, (request: RecordedRequest) => { status?: number; json?: unknown }>;
}

export const LIVE_CONFIG: AuthConfig = {
  google: { mode: 'live', startPath: '/v1/auth/google/start' },
  devLoginEnabled: false,
  magicLinkEnabled: true,
  breakGlassEnabled: true,
};

const CORS = {
  'access-control-allow-origin': APP_ORIGIN,
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers': 'content-type, x-csrf-token',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
};

const errorBody = (statusCode: number, code: string) => ({
  statusCode,
  error: 'Error',
  code,
  message: code,
});

export function defaultTickets(): TicketDetail[] {
  return [
    makeTicket(1, { subject: 'Cannot log in', priority: 'P1' }),
    makeTicket(2, { subject: 'Export is slow', priority: 'P3' }),
    makeTicket(3, { subject: 'Invoice question', priority: 'P4', status: 'waiting_on_customer' }),
  ];
}

export async function mockBackend(page: Page, options: BackendOptions = {}) {
  const role = options.role ?? 'agent';
  const tickets = options.tickets ?? (role === 'client' ? [makeClientTicket(1)] : defaultTickets());
  const session = options.session === undefined ? makeSession(role) : options.session;
  const requests: RecordedRequest[] = [];
  let sockets: WebSocketRoute[] = [];

  const fulfill = (route: Route, status: number, json?: unknown) =>
    route.fulfill({
      status,
      headers: { ...CORS, 'content-type': 'application/json' },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });

  await page.route(`${E2E_API_URL}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    if (url.pathname === '/health') {
      if (options.health === 'down') {
        await route.abort('connectionrefused');
        return;
      }
      await fulfill(route, options.health ?? 200, { status: 'ok' });
      return;
    }

    const recorded: RecordedRequest = {
      method,
      path: url.pathname,
      search: url.search,
      body: request.postDataJSON() as unknown,
      csrf: request.headers()['x-csrf-token'],
    };
    requests.push(recorded);
    const key = `${method} ${url.pathname}`;
    const custom = options.routes?.[key];
    if (custom) {
      const result = custom(recorded);
      await fulfill(route, result.status ?? 200, result.json);
      return;
    }

    const ticketMatch = /^\/v1\/tickets\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    const ref = ticketMatch?.[1] ? decodeURIComponent(ticketMatch[1]) : undefined;
    const found = ref
      ? tickets.find((ticket) => ticket.key === ref || ticket.id === ref)
      : undefined;

    const reject = /^\/v1\/tickets\/([^/]+)\/ai\/drafts\/([^/]+)\/reject$/.exec(url.pathname);
    if (method === 'POST' && reject) return fulfill(route, 204);

    if (key === 'GET /v1/auth/config')
      return fulfill(route, 200, options.authConfig ?? LIVE_CONFIG);
    if (key === 'GET /v1/auth/session') {
      return session
        ? fulfill(route, 200, session)
        : fulfill(route, 401, errorBody(401, 'unauthenticated'));
    }
    if (key === 'POST /v1/auth/logout') return fulfill(route, 204);
    if (key === 'GET /v1/tickets') return fulfill(route, 200, { items: tickets, nextCursor: null });
    if (method === 'GET' && ticketMatch && !ticketMatch[2]) {
      return found ? fulfill(route, 200, found) : fulfill(route, 404, errorBody(404, 'not_found'));
    }
    if (method === 'GET' && ticketMatch?.[2] === '/ai') {
      const insight = ref ? options.ai?.[ref] : undefined;
      return insight
        ? fulfill(route, 200, insight)
        : fulfill(route, 404, errorBody(404, 'not_found'));
    }
    if (method === 'GET' && ticketMatch?.[2] === '/timeline') {
      const entries = ref
        ? (options.timelines?.[ref] ??
          (found ? [makeMessage(1, found, { bodyText: `Hello from ${found.key}` })] : []))
        : [];
      return fulfill(route, 200, { entries, nextCursor: null });
    }
    if (method === 'POST' && ticketMatch?.[2] === '/replies' && found) {
      return fulfill(route, 201, {
        message: makeMessage(90, found, { direction: 'outbound', bodyText: 'sent' }),
        ticket: found,
      });
    }
    if (method === 'POST' && ticketMatch?.[2] === '/notes' && found) {
      return fulfill(route, 201, {
        message: makeMessage(91, found, { direction: 'internal', visibility: 'internal' }),
        ticket: found,
      });
    }
    if (method === 'POST' && ticketMatch?.[2] === '/status' && found) {
      const status = (recorded.body as { status: TicketDetail['status'] }).status;
      Object.assign(found, { status });
      return fulfill(route, 200, found);
    }
    if (key === 'GET /v1/intents') {
      return fulfill(route, 200, { intents: role === 'client' ? [] : [INTENT] });
    }
    if (key === 'GET /v1/queues') return fulfill(route, 200, { queues: [] });
    if (key === 'GET /v1/ticket-workflow') {
      return fulfill(route, 200, { transitions: defaultTransitionList() });
    }
    return fulfill(route, 404, errorBody(404, 'not_found'));
  });

  await page.routeWebSocket(`ws://127.0.0.1:4999/v1/realtime`, (socket) => {
    sockets = [...sockets, socket];
    socket.send(
      JSON.stringify({
        type: 'ready',
        audience: role === 'client' ? 'client' : 'staff',
        accessExpiresAt: '2026-11-02T03:15:00.000Z',
      }),
    );
  });

  return {
    requests,
    /** Requests of one kind, for assertions. */
    to: (method: string, path: string) =>
      requests.filter((request) => request.method === method && request.path === path),
    /** Pushes a realtime event to every open socket, as the api would. */
    push: (event: RealtimeEvent) => {
      for (const socket of sockets) socket.send(JSON.stringify(event));
    },
    /** Closes every open socket from the server side with a close code. */
    closeSockets: async (code: number) => {
      const open = sockets;
      sockets = [];
      await Promise.all(open.map((socket) => socket.close({ code })));
    },
    get socketCount() {
      return sockets.length;
    },
    tickets,
  };
}

export { makeTicket, uuid };
