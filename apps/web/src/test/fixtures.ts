import {
  DEFAULT_ROLE_PERMISSIONS,
  formatTicketKey,
  type ClientTicket,
  type Message,
  type Role,
  type SessionInfo,
  type TicketDetail,
  type TimelineEntry,
} from '@watchtower/shared';

/** A valid RFC 4122 v4-shaped uuid for fixture number `n`. */
export function uuid(n: number): string {
  return `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const NOW = '2026-11-02T03:00:00.000Z';

export function makeSession(
  role: Role = 'agent',
  overrides: Partial<SessionInfo> = {},
): SessionInfo {
  return {
    user: {
      id: uuid(900),
      email: `${role}@example.com`,
      name: role === 'client' ? 'Casey Customer' : 'Alex Agent',
      role,
      orgId: role === 'client' ? uuid(500) : null,
    },
    permissions: [...DEFAULT_ROLE_PERMISSIONS[role]],
    sessionId: uuid(901),
    authMethod: 'dev',
    csrfToken: 'csrf-token-for-tests',
    accessExpiresAt: '2026-11-02T03:15:00.000Z',
    ...overrides,
  };
}

export function makeTicket(n: number, overrides: Partial<TicketDetail> = {}): TicketDetail {
  return {
    id: uuid(n),
    number: n,
    key: formatTicketKey(n),
    subject: `Subject of ticket ${String(n)}`,
    status: 'open',
    priority: 'P3',
    channel: 'portal',
    org: { id: uuid(500), name: 'Example Org' },
    requester: { id: uuid(600), name: 'Riley Requester', email: 'riley@example.com' },
    intent: { id: uuid(700), key: 'login_issue', name: 'Login issue' },
    assignee: null,
    queue: null,
    slaPolicyId: null,
    firstResponseDueAt: null,
    resolutionDueAt: null,
    slaPausedAt: null,
    firstRespondedAt: null,
    resolvedAt: null,
    closedAt: null,
    parentTicketId: null,
    mergedIntoKey: null,
    tags: [],
    customFields: {},
    autonomyStageAtCreation: null,
    aiHandled: false,
    reopenCount: 0,
    csatScore: null,
    createdAt: NOW,
    updatedAt: NOW,
    mergedTickets: [],
    ...overrides,
  };
}

export function makeClientTicket(n: number, overrides: Partial<ClientTicket> = {}): ClientTicket {
  return {
    id: uuid(n),
    number: n,
    key: formatTicketKey(n),
    subject: `Customer subject ${String(n)}`,
    status: 'open',
    priority: 'P3',
    intent: null,
    requesterName: 'Casey Customer',
    mergedIntoKey: null,
    resolvedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeMessage(
  n: number,
  ticket: { id: string; key: string },
  overrides: Partial<Message> = {},
): Extract<TimelineEntry, { kind: 'message' }> {
  return {
    kind: 'message',
    id: uuid(2000 + n),
    ticketId: ticket.id,
    ticketKey: ticket.key,
    channel: 'portal',
    direction: 'inbound',
    visibility: 'public',
    sender: { type: 'contact', id: uuid(600), name: 'Riley Requester' },
    bodyText: `Message body ${String(n)}`,
    deliveryStatus: 'not_applicable',
    attachments: [],
    createdAt: NOW,
    ...overrides,
  };
}

export const INTENT = {
  id: uuid(700),
  key: 'login_issue',
  name: 'Login issue',
  description: '',
  typicalEvidence: '',
  defaultPriority: 'P3' as const,
  slaPolicyId: null,
  allowedTools: [],
  replyTemplates: [
    {
      key: 'ask_details',
      name: 'Ask for details',
      body: 'Hello {{requester.name}}, about {{ticket.key}}: could you share more details? {{agent.name}}',
    },
    {
      key: 'needs_unknown',
      name: 'Has a gap',
      body: 'Hello {{requester.name}}, {{unknown.thing}}',
    },
  ],
  isActive: true,
  runbookArticleId: null,
  procedureVersionId: null,
  autonomyStage: 2,
  createdAt: NOW,
  updatedAt: NOW,
};
