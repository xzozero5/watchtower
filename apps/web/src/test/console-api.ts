import type { Role, TicketDetail } from '@watchtower/shared';
import type { AutonomyState, TicketStats } from '@watchtower/shared';

import {
  auditEntry,
  CALENDAR,
  CONTACT,
  dueTicket,
  FULL_INTENTS,
  makeAutonomy,
  ORG,
  PEOPLE,
  POLICY,
  QUEUE,
  QUEUE_BILLING,
  STATS,
  UNASSIGNED_STATS,
  USERS,
} from './console-fixtures';
import { makeSession, uuid } from './fixtures';
import { shiftOverview } from './shift-fixtures';
import { type MockHandler, mockApi } from './mock-api';

const AT = '2026-11-02T03:00:00.000Z';

export interface ConsoleOptions {
  role?: Role;
  stats?: TicketStats | MockHandler;
  autonomy?: AutonomyState;
  tickets?: TicketDetail[];
  overrides?: Record<string, MockHandler>;
}

/**
 * Every read the head console makes, answered with the fixtures above. A test overrides only what
 * it is about; `overrides` win. Stubs `fetch`.
 */
export function consoleApi({
  role = 'head',
  stats = STATS,
  autonomy = makeAutonomy(),
  tickets = [dueTicket(1, 30, { priority: 'P1' }), dueTicket(2, -10, { priority: 'P2' })],
  overrides = {},
}: ConsoleOptions = {}) {
  const defaults: Record<string, MockHandler> = {
    'GET /health': { json: { status: 'ok' } },
    'GET /health/ready': {
      json: {
        status: 'ok',
        checks: { database: { status: 'up' }, redis: { status: 'up' } },
      },
    },
    'GET /v1/auth/session': { json: makeSession(role) },
    'GET /v1/tickets/stats':
      typeof stats === 'function'
        ? stats
        : ({ url }) => ({
            json: url.searchParams.get('assignee') === 'unassigned' ? UNASSIGNED_STATS : stats,
          }),
    'GET /v1/tickets': { json: { items: tickets, nextCursor: null } },
    'GET /v1/autonomy': { json: autonomy },
    'GET /v1/shifts/overview': { json: shiftOverview() },
    'GET /v1/users': { json: { users: USERS } },
    'GET /v1/queues': { json: { queues: [QUEUE, QUEUE_BILLING] } },
    'GET /v1/org-tiers': {
      json: {
        tiers: [
          { slug: 'gold', name: 'Gold', sortOrder: 1 },
          { slug: 'silver', name: 'Silver', sortOrder: 2 },
          { slug: 'standard', name: 'Standard', sortOrder: 3 },
        ],
      },
    },
    'GET /v1/intents': { json: { intents: FULL_INTENTS } },
    'GET /v1/sla-policies': { json: { policies: [POLICY] } },
    'GET /v1/business-calendars': { json: { calendars: [CALENDAR] } },
    'GET /v1/business-calendars/:id': { json: CALENDAR },
    'GET /v1/orgs': { json: { items: [ORG], nextCursor: null } },
    'GET /v1/orgs/:id': { json: ORG },
    'GET /v1/contacts': { json: { items: [CONTACT], nextCursor: null } },
    'GET /v1/audit-logs': {
      json: { entries: [auditEntry(1), auditEntry(2, { outcome: 'denied' })], nextCursor: null },
    },
    'GET /v1/intents/:id/autonomy/history': {
      json: {
        items: [
          {
            id: uuid(1100),
            intentId: uuid(700),
            change: 'stage',
            fromStage: 1,
            toStage: 2,
            pinned: false,
            reason: 'eval run passed',
            changedBy: PEOPLE.mana.id,
            changedByName: 'Mana',
            changedAt: AT,
          },
        ],
        nextCursor: null,
      },
    },
  };
  // The first matching route wins, so a test's own routes go first and replace same-named defaults.
  return mockApi({
    ...overrides,
    ...Object.fromEntries(Object.entries(defaults).filter(([key]) => !(key in overrides))),
  });
}
