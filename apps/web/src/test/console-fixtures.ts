import type {
  AuditLogEntry,
  AutonomyState,
  BusinessCalendarRecord,
  TicketStats,
  Contact,
  Intent,
  Organization,
  SlaPolicy,
  TeamQueue,
  TicketDetail,
  User,
} from '@watchtower/shared';

import { INTENT, makeTicket, uuid } from './fixtures';

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

const NO_SLA = { ok: 0, at_risk: 0, breached: 0, paused: 0 };
const bucket = (count: number, open = count, sla: Partial<typeof NO_SLA> = {}) => ({
  count,
  open,
  sla: { ...NO_SLA, ...sla },
});

export const STATS: TicketStats = {
  generatedAt: AT,
  total: bucket(55, 55, { ok: 36, at_risk: 5, breached: 2, paused: 12 }),
  byStatus: [
    { status: 'new', ...bucket(4) },
    { status: 'triage', ...bucket(2) },
    { status: 'open', ...bucket(31) },
    { status: 'waiting_on_customer', ...bucket(12) },
    { status: 'waiting_on_dev', ...bucket(6) },
  ],
  byQueue: [
    { queueId: uuid(800), ...bucket(22) },
    { queueId: uuid(801), ...bucket(9) },
    { queueId: null, ...bucket(3) },
  ],
  byAssignee: [
    { assigneeId: null, ...bucket(3) },
    { assigneeId: PEOPLE.mana.id, ...bucket(9, 9, { at_risk: 2 }) },
    { assigneeId: PEOPLE.pim.id, ...bucket(4) },
  ],
  byPriority: [
    { priority: 'P1', ...bucket(2) },
    { priority: 'P2', ...bucket(8) },
    { priority: 'P3', ...bucket(30) },
    { priority: 'P4', ...bucket(15) },
  ],
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

export function makeAutonomy(overrides: Partial<AutonomyState> = {}): AutonomyState {
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
      {
        key: 'ai_stage_cap_pinned',
        on: false,
        reason: '',
        changedBy: null,
        changedByName: null,
        changedAt: AT,
      },
      {
        key: 'ai_kill_switch',
        on: false,
        reason: '',
        changedBy: null,
        changedByName: null,
        changedAt: AT,
      },
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
  contactCount: 1,
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
  lineLinkedVia: 'staff_code',
  lineVerified: false,
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

export const CALENDAR: BusinessCalendarRecord = {
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
    {
      date: '2026-12-31',
      name: 'New Year’s Eve',
      checked: false,
      checkedAt: null,
      checkedBy: null,
    },
    {
      date: '2027-01-01',
      name: 'New Year’s Day',
      checked: true,
      checkedAt: AT,
      checkedBy: PEOPLE.head.id,
    },
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
