import type { Role } from '@watchtower/shared';

import { makeSession } from './fixtures';
import { type MockHandler, mockApi } from './mock-api';
import {
  assignee,
  currentHandoff,
  emptyIncoming,
  shiftBrief,
  shiftDefinition,
  shiftNote,
  shiftOverview,
  shiftStatus,
  SHIFT_TZ,
  WHO,
} from './shift-fixtures';

export interface ShiftApiOptions {
  role?: Role;
  overrides?: Record<string, MockHandler>;
}

/**
 * Every read the shift screens make, answered with the fixtures. A test overrides only what it is
 * about; `overrides` win. Stubs `fetch`.
 */
export function shiftApi({ role = 'agent', overrides = {} }: ShiftApiOptions = {}) {
  const defaults: Record<string, MockHandler> = {
    'GET /health': { json: { status: 'ok' } },
    'GET /v1/auth/session': { json: makeSession(role) },
    'GET /v1/shifts/status': { json: shiftStatus() },
    'GET /v1/shifts/brief': { json: shiftBrief() },
    'GET /v1/shifts/overview': { json: shiftOverview() },
    'GET /v1/handoffs/current': { json: currentHandoff() },
    'GET /v1/handoffs/incoming': { json: emptyIncoming() },
    'GET /v1/assignees': {
      json: {
        scope: 'all_staff',
        assignees: [
          assignee(WHO.me),
          assignee(WHO.mana),
          assignee(WHO.pim),
          assignee(WHO.dao, { onShift: false, openTickets: 0 }),
        ],
      },
    },
    'GET /v1/shift-notes': {
      json: { items: [shiftNote(1)], nextCursor: null, unreadCount: 1 },
    },
    'GET /v1/shifts/definitions': {
      json: { timezone: SHIFT_TZ, definitions: [shiftDefinition(0), shiftDefinition(1)] },
    },
    'GET /v1/roster': { json: { timezone: SHIFT_TZ, entries: [] } },
  };
  return mockApi({
    ...overrides,
    ...Object.fromEntries(Object.entries(defaults).filter(([key]) => !(key in overrides))),
  });
}
