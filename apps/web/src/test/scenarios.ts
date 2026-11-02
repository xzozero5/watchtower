import {
  SYSTEM_VIEWS,
  SYSTEM_VIEW_KEYS,
  defaultTransitionList,
  type ClientTicket,
  type Role,
  type SavedView,
  type TicketAiInsight,
  type TicketDetail,
  type TimelineEntry,
} from '@watchtower/shared';

import { INTENT, makeClientTicket, makeMessage, makeSession, makeTicket, uuid } from './fixtures';
import { type MockHandler, mockApi } from './mock-api';

/** The built-in views the server lists, with a count each; a test adds the ones people saved. */
export function viewList(
  counts: Partial<Record<(typeof SYSTEM_VIEW_KEYS)[number], number>> = {},
  saved: SavedView[] = [],
): { items: SavedView[] } {
  return {
    items: [
      ...SYSTEM_VIEW_KEYS.map((key) => ({
        id: `system:${key}`,
        kind: 'system' as const,
        key,
        name: SYSTEM_VIEWS[key].name,
        filters: SYSTEM_VIEWS[key].filters,
        sort: SYSTEM_VIEWS[key].sort,
        ownerId: null,
        ownerName: null,
        count: counts[key] ?? 0,
        editable: false,
        createdAt: null,
        updatedAt: null,
      })),
      ...saved,
    ],
  };
}

export interface Scenario {
  role?: Role;
  tickets?: (TicketDetail | ClientTicket)[];
  timelines?: Record<string, TimelineEntry[]>;
  /** AI briefs by ticket key. A ticket without one answers 404, like an api that has none yet. */
  ai?: Record<string, TicketAiInsight>;
  overrides?: Record<string, MockHandler>;
}

/**
 * A staff or client user looking at a small queue. Every read the workspace makes is answered; a
 * test overrides only what it is about.
 */
export function workspaceApi({
  role = 'agent',
  tickets,
  timelines = {},
  ai = {},
  overrides = {},
}: Scenario = {}) {
  const list =
    tickets ??
    (role === 'client'
      ? [makeClientTicket(1), makeClientTicket(2)]
      : [
          makeTicket(1, { subject: 'Cannot log in', priority: 'P1' }),
          makeTicket(2, { subject: 'Export is slow', priority: 'P3' }),
          makeTicket(3, {
            subject: 'Invoice question',
            priority: 'P4',
            status: 'waiting_on_customer',
          }),
        ]);

  return mockApi({
    'GET /health': { json: { status: 'ok' } },
    'GET /v1/auth/session': { json: makeSession(role) },
    'GET /v1/tickets': { json: { items: list, nextCursor: null } },
    'GET /v1/tickets/:id': ({ params }) => {
      const id = params.id ?? '';
      const found = list.find((ticket) => ticket.key === id || ticket.id === id);
      return found
        ? { json: found }
        : {
            status: 404,
            json: { statusCode: 404, error: 'Not Found', code: 'not_found', message: 'x' },
          };
    },
    'GET /v1/tickets/:id/ai': ({ params }) => {
      const insight = ai[params.id ?? ''];
      return insight
        ? { json: insight }
        : {
            status: 404,
            json: { statusCode: 404, error: 'Not Found', code: 'not_found', message: 'x' },
          };
    },
    'GET /v1/tickets/:id/timeline': ({ params }) => {
      const id = params.id ?? '';
      const found = list.find((ticket) => ticket.key === id);
      const entries =
        timelines[id] ??
        (found ? [makeMessage(1, found, { bodyText: `Hello from ${found.key}` })] : []);
      return { json: { entries, nextCursor: null } };
    },
    'GET /v1/intents': {
      json: {
        intents:
          role === 'client'
            ? []
            : [
                INTENT,
                {
                  ...INTENT,
                  id: uuid(701),
                  key: 'billing',
                  name: 'Billing question',
                  replyTemplates: [],
                },
              ],
      },
    },
    'GET /v1/queues': {
      json: {
        queues: [
          {
            id: uuid(800),
            name: 'Support',
            assignmentMode: 'manual',
            isDefault: true,
            members: [
              { userId: uuid(900), name: 'Alex Agent', role: 'agent', status: 'active' },
              { userId: uuid(901), name: 'Sam Support', role: 'agent', status: 'active' },
            ],
            createdAt: '2026-11-02T03:00:00.000Z',
            updatedAt: '2026-11-02T03:00:00.000Z',
          },
        ],
      },
    },
    'GET /v1/assignees': {
      json: {
        scope: 'all_staff',
        assignees: [
          {
            id: uuid(900),
            name: 'Alex Agent',
            role: 'agent',
            onShift: true,
            openTickets: 1,
            inQueue: false,
          },
          {
            id: uuid(901),
            name: 'Sam Support',
            role: 'agent',
            onShift: true,
            openTickets: 0,
            inQueue: false,
          },
        ],
      },
    },
    'GET /v1/ticket-workflow': { json: { transitions: defaultTransitionList() } },
    ...(role === 'client' ? {} : { 'GET /v1/views': { json: viewList() } }),
    ...overrides,
  });
}
