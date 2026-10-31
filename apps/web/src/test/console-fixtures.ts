import type {
  AuditLogEntry,
  Contact,
  Intent,
  Organization,
  Role,
  SlaPolicy,
  TeamQueue,
  TicketDetail,
  User,
} from '@watchtower/shared';

import type { AutonomyView, CalendarView, TicketStats } from '@/lib/admin/contracts';

import { INTENT, makeSession, makeTicket, uuid } from './fixtures';
import { type MockHandler, mockApi } from './mock-api';

/** Fictional people and organizations only: example.com, invented names (N1). */
export const PEOPLE = {
  head: { id: uuid(900), name: 'Alex Agent' },
  mana: { id: uuid(910), name: 'Mana K.' },
  pim: { id: uuid(911), name: 'Pim S.' },
  dao: { id: uuid(912), name: 'Dao N.' },
} as const;

const AT = '2026-11-02T03:00:00.000Z';

export function makeUser(overrides: Partial<User> & Pick<User, 'id' | 'name'>): User {
  return {
    email: `${overrides.name.toLowerCase().replace(/\W+/g, '.')}@example.com`,
    role: 'agent',
    status: 'active',
    orgId: null,
    isBreakGlass: false,
    lastLoginAt: AT,
    createdAt: AT,
    ...overrides,
  };
}

export const USERS: User[] = [
  makeUser({ ...PEOPLE.head, role: 'head', email: 'head@example.com' }),
  makeUser({ ...PEOPLE.mana, role: 'lead' }),
  makeUser({ ...PEOPLE.pim }),
  makeUser({ ...PEOPLE.dao, status: 'disabled' }),
  makeUser({
    id: uuid(913),
    name: 'Break Glass',
    role: 'head',
    isBreakGlass: true,
    lastLoginAt: null,
  }),
];

export const STATS: TicketStats = {
  byStatus: { new: 4, triage: 2, open: 31, waiting_on_dev: 6, waiting_on_customer: 12 },
  byQueue: [
    { queueId: uuid(800), name: 'Support', n: 22 },
    { queueId: uuid(801), name: 'Billing', n: 9 },
    { queueId: null, name: null, n: 3 },
  ],
  byAssignee: [
    { userId: null, name: null, n: 3 },
    { userId: PEOPLE.mana.id, name: 'Mana K.', n: 9 },
    { userId: PEOPLE.pim.id, name: 'Pim S.', n: 4 },
  ],
  byPriority: { P1: 2, P2: 8, P3: 30, P4: 15 },
  bySlaState: { ok: 40, at_risk: 5, breached: 2, paused: 12 },
};

/** A ticket whose first response was due `minutes` ago (negative: still to come). */
export function dueTicket(
  n: number,
  minutesPastDue: number,
  overrides: Partial<TicketDetail> = {},
) {
  const due = new Date(Date.now() - minutesPastDue * 60_000).toISOString();
  return makeTicket(n, {
    subject: `Ticket ${String(n)}`,
    createdAt: new Date(Date.now() - 4 * 3_600_000).toISOString(),
    firstResponseDueAt: due,
    status: 'open',
    org: { id: uuid(500), name: 'Acme Logistics' },
    ...overrides,
  });
}

export function makeAutonomy(overrides: Partial<AutonomyView> = {}): AutonomyView {
  const intent = (n: number, key: string, stage: 0 | 1 | 2, pinned = false) => ({
    id: uuid(700 + n),
    key,
    name: key.replaceAll('_', ' '),
    isActive: true,
    stage,
    effectiveStage: stage,
    pinned,
    updatedAt: AT,
  });
  return {
    stageCeiling: 2,
    switches: [
      { key: 'ai_stage_cap_pinned', on: false, reason: '', changedBy: null, changedAt: AT },
      { key: 'ai_kill_switch', on: false, reason: '', changedBy: null, changedAt: AT },
    ],
    intents: [
      intent(0, 'login_issue', 1),
      intent(1, 'billing', 2),
      intent(2, 'webhook_not_received', 2, true),
      intent(3, 'export_slow', 0),
    ],
    ...overrides,
  };
}

export const FULL_INTENTS: Intent[] = [
  {
    ...INTENT,
    id: uuid(700),
    key: 'login_issue',
    name: 'Login issue',
    autonomyStage: 1,
    defaultPriority: 'P2',
  },
  { ...INTENT, id: uuid(701), key: 'billing', name: 'Billing question', autonomyStage: 2 },
  {
    ...INTENT,
    id: uuid(702),
    key: 'webhook_not_received',
    name: 'Webhook not received',
    autonomyStage: 2,
    allowedTools: ['gcp_logs', 'git_search'],
  },
];

export const ORG: Organization = {
  id: uuid(500),
  name: 'Acme Logistics',
  tier: 'gold',
  slaPolicyId: uuid(300),
  domains: ['acme.example.com', 'acme-logistics.example.com'],
  lineGroupIds: [],
  healthScore: null,
  primaryContactId: null,
  notes: 'Pilot customer.',
  status: 'active',
  createdAt: AT,
  updatedAt: AT,
};

export const CONTACT: Contact = {
  id: uuid(600),
  orgId: uuid(500),
  name: 'Riley Requester',
  emails: ['riley@acme.example.com'],
  lineUserId: 'U-example',
  phone: null,
  verifiedAt: AT,
  roleInOrg: 'Operations',
  notificationPrefs: {},
  createdAt: AT,
  updatedAt: AT,
};

export const POLICY: SlaPolicy = {
  id: uuid(300),
  name: 'Gold',
  tier: 'gold',
  targets: {
    P1: { first_response_min: 15, resolution_min: 240, calendar: '24x7' },
    P2: { first_response_min: 60, resolution_min: 480, calendar: 'business' },
  },
  businessCalendarId: uuid(310),
  createdAt: AT,
  updatedAt: AT,
};

export const CALENDAR: CalendarView = {
  id: uuid(310),
  name: 'Bangkok office hours',
  timezone: 'Asia/Bangkok',
  hours: {
    sun: [],
    mon: [{ start: '09:00', end: '18:00' }],
    tue: [{ start: '09:00', end: '18:00' }],
    wed: [{ start: '09:00', end: '18:00' }],
    thu: [{ start: '09:00', end: '18:00' }],
    fri: [{ start: '09:00', end: '18:00' }],
    sat: [],
  },
  holidays: [
    { date: '2026-12-31', name: 'New Year’s Eve', checked: false },
    { date: '2027-01-01', name: 'New Year’s Day', checked: true },
  ],
  isDefault: true,
  createdAt: AT,
  updatedAt: AT,
};

export const QUEUE: TeamQueue = {
  id: uuid(800),
  name: 'Support',
  assignmentMode: 'round_robin',
  isDefault: true,
  members: [
    { userId: PEOPLE.mana.id, name: 'Mana K.', role: 'lead', status: 'active' },
    { userId: PEOPLE.pim.id, name: 'Pim S.', role: 'agent', status: 'active' },
  ],
  createdAt: AT,
  updatedAt: AT,
};

export function auditEntry(n: number, overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: uuid(1000 + n),
    createdAt: new Date(Date.now() - n * 3_600_000).toISOString(),
    actorType: 'user',
    actorId: PEOPLE.mana.id,
    action: 'autonomy.stage_set',
    outcome: 'success',
    targetType: 'intent',
    targetId: uuid(700),
    before: { stage: 1 },
    after: { stage: 2 },
    ip: '203.0.113.7',
    requestId: `req-${String(n)}`,
    metadata: {},
    ...overrides,
  };
}

export interface ConsoleOptions {
  role?: Role;
  stats?: TicketStats | MockHandler;
  autonomy?: AutonomyView;
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
    'GET /v1/tickets/stats': typeof stats === 'function' ? stats : { json: stats },
    'GET /v1/tickets': { json: { items: tickets, nextCursor: null } },
    'GET /v1/autonomy': { json: autonomy },
    'GET /v1/users': { json: { users: USERS } },
    'GET /v1/queues': { json: { queues: [QUEUE] } },
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
        entries: [
          {
            id: 'h1',
            change: 'stage',
            fromStage: 1,
            toStage: 2,
            pinned: null,
            reason: 'eval run passed',
            changedBy: PEOPLE.mana.id,
            changedByName: 'Mana K.',
            changedAt: AT,
          },
        ],
      },
    },
  };
  // The first matching route wins, so a test's own routes go first and replace same-named defaults.
  return mockApi({
    ...overrides,
    ...Object.fromEntries(Object.entries(defaults).filter(([key]) => !(key in overrides))),
  });
}
