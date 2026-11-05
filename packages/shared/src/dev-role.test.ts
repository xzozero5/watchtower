import { describe, expect, it } from 'vitest';

import { MANUAL_CHANNELS, NO_OUTBOUND_CHANNELS, hasOutboundChannel } from './channels.js';
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  ROLES,
  STAFF_ROLES,
  WORKSPACE_ROLES,
  isStaffRole,
} from './rbac.js';
import type { RealtimeEvent } from './realtime.js';
import { realtimeEventFor } from './realtime.js';
import {
  CONFIRMATION_STATUSES,
  DEV_STATUSES,
  createManualTicketSchema,
  isDevStatusMove,
  statusChangeNeedsNote,
} from './ticket-manual.js';
import { TICKET_STATUSES } from './ticketing.js';

const dev = DEFAULT_ROLE_PERMISSIONS.dev;
const ID = '00000000-0000-4000-8000-000000000001';

describe('the dev role (T-137)', () => {
  it('is a role, signs in with the workspace roles, and is not a staff role', () => {
    expect(ROLES).toContain('dev');
    expect(WORKSPACE_ROLES).toEqual([...STAFF_ROLES, 'dev']);
    // Assignment, round robin and on-shift alerts read STAFF_ROLES: a dev must never be in it.
    expect(isStaffRole('dev')).toBe(false);
    expect(STAFF_ROLES as readonly string[]).not.toContain('dev');
  });

  it('reads masked, does the developer work and investigates; nothing else', () => {
    expect([...dev].toSorted()).toEqual(
      [
        'assistant.use',
        'auth.session.self',
        'investigate.run',
        // T-303b: a developer reads the procedure of an intent (ADR-026).
        'procedure.read',
        'ticket.dev.work',
        'ticket.read.masked',
      ].toSorted(),
    );
    for (const refused of [
      'ticket.read',
      'ticket.handle',
      'ticket.reply',
      'ticket.create',
      'ai.draft.review',
      'investigate.adhoc',
      'incident.create',
      'incident.manage',
      'shift.clock',
      'handoff.write',
      'handoff.ack',
      'shift.note.write',
    ] as const) {
      expect(dev).not.toContain(refused);
    }
  });

  it('is the only role with the masked read, and no other role is given the developer work', () => {
    for (const role of ROLES) {
      if (role === 'dev') continue;
      expect(DEFAULT_ROLE_PERMISSIONS[role]).not.toContain('ticket.read.masked');
      expect(DEFAULT_ROLE_PERMISSIONS[role]).not.toContain('ticket.dev.work');
    }
    expect(Object.keys(PERMISSIONS)).toContain('ticket.read.masked');
  });

  it('lets only a lead and a head free a ticket from a developer', () => {
    for (const role of ROLES) {
      const has = DEFAULT_ROLE_PERMISSIONS[role].includes('ticket.dev.release.any');
      expect([role, has]).toEqual([role, role === 'lead' || role === 'head']);
    }
  });

  it('files tickets by hand only for agent, lead and head', () => {
    for (const role of STAFF_ROLES) {
      expect(DEFAULT_ROLE_PERMISSIONS[role]).toContain('ticket.create');
      expect(DEFAULT_ROLE_PERMISSIONS[role]).toContain('ticket.handle');
    }
    expect(dev).not.toContain('ticket.create');
  });
});

describe('status moves around waiting_on_dev (T-137)', () => {
  it('lets a dev move between open and waiting_on_dev only', () => {
    const allowed = TICKET_STATUSES.flatMap((from) =>
      TICKET_STATUSES.filter((to) => isDevStatusMove(from, to)).map((to) => `${from}>${to}`),
    );
    expect(allowed.toSorted()).toEqual(
      DEV_STATUSES.flatMap((from) =>
        DEV_STATUSES.filter((to) => to !== from).map((to) => `${from}>${to}`),
      ).toSorted(),
    );
  });

  it('asks for a note when a ticket goes to waiting_on_dev, and when a dev hands it back', () => {
    expect(statusChangeNeedsNote('open', 'waiting_on_dev')).toBe(true);
    expect(statusChangeNeedsNote('triage', 'waiting_on_dev', true)).toBe(true);
    expect(statusChangeNeedsNote('waiting_on_dev', 'open', true)).toBe(true);
    // An agent resolving what a developer fixed does not owe a second note.
    expect(statusChangeNeedsNote('waiting_on_dev', 'resolved')).toBe(false);
    expect(statusChangeNeedsNote('open', 'resolved')).toBe(false);
  });
});

describe('what a developer hears in realtime (T-137)', () => {
  const ticketEvent: RealtimeEvent = {
    id: ID,
    type: 'ticket.updated',
    occurredAt: '2026-11-02T10:00:00.000Z',
    orgId: ID,
    ticketId: ID,
    ticketKey: 'OPS-7',
    data: {
      subject: 'Order for somchai@customer.example failed',
      status: 'open',
      priority: 'P2',
      changed: ['status'],
    },
  };

  it('never carries the subject of a ticket', () => {
    const heard = realtimeEventFor({ kind: 'dev', userId: ID }, ticketEvent);
    expect(heard?.type).toBe('ticket.updated');
    expect(JSON.stringify(heard)).not.toContain('somchai');
    expect(heard?.type === 'ticket.updated' && heard.data.subject).toBe('OPS-7');
  });

  it('hears no alert, and a notification only when it is addressed to them', () => {
    const alert: RealtimeEvent = {
      id: ID,
      type: 'alert.updated',
      occurredAt: ticketEvent.occurredAt,
      data: { alertId: ID, state: 'open', changed: ['state'], escalationLevel: 0 },
    };
    expect(realtimeEventFor({ kind: 'dev', userId: ID }, alert)).toBeNull();
    const note: RealtimeEvent = {
      id: ID,
      type: 'notification.created',
      occurredAt: ticketEvent.occurredAt,
      recipientId: ID,
      data: {
        notificationId: ID,
        kind: 'ticket.assigned',
        severity: 'normal',
        orgId: null,
        queueId: null,
        channel: null,
        ticketId: null,
        ticketKey: null,
      },
    };
    expect(realtimeEventFor({ kind: 'dev', userId: ID }, note)).not.toBeNull();
    expect(
      realtimeEventFor({ kind: 'dev', userId: '00000000-0000-4000-8000-000000000002' }, note),
    ).toBeNull();
  });
});

describe('a ticket filed by hand (T-136)', () => {
  const base = {
    orgId: ID,
    channel: 'phone',
    subject: 'Cannot log in',
    body: 'The customer called about a login error.',
  } as const;

  it('needs an organization, a channel, a subject, a body and exactly one way to name the contact', () => {
    expect(createManualTicketSchema.safeParse({ ...base, requesterContactId: ID }).success).toBe(
      true,
    );
    expect(
      createManualTicketSchema.safeParse({
        ...base,
        requester: { email: 'new@customer.example', name: 'New Person' },
      }).success,
    ).toBe(true);
    expect(createManualTicketSchema.safeParse(base).success).toBe(false);
    expect(
      createManualTicketSchema.safeParse({
        ...base,
        requesterContactId: ID,
        requester: { email: 'new@customer.example', name: 'New Person' },
      }).success,
    ).toBe(false);
    for (const missing of ['orgId', 'channel', 'subject', 'body'] as const) {
      const rest = Object.fromEntries(Object.entries(base).filter(([key]) => key !== missing));
      expect(createManualTicketSchema.safeParse({ ...rest, requesterContactId: ID }).success).toBe(
        false,
      );
    }
  });

  it('accepts the manual channels and refuses every channel that has an account, and internal', () => {
    for (const channel of MANUAL_CHANNELS) {
      expect(
        createManualTicketSchema.safeParse({ ...base, channel, requesterContactId: ID }).success,
      ).toBe(true);
    }
    for (const channel of ['gmail', 'line', 'portal', 'discord', 'webhook', 'internal']) {
      expect(
        createManualTicketSchema.safeParse({ ...base, channel, requesterContactId: ID }).success,
      ).toBe(false);
    }
  });

  it('has nothing to reply on for the manual channels and internal, and does for the others', () => {
    for (const channel of NO_OUTBOUND_CHANNELS) expect(hasOutboundChannel(channel)).toBe(false);
    for (const channel of ['gmail', 'line', 'portal', 'discord', 'webhook']) {
      expect(hasOutboundChannel(channel)).toBe(true);
    }
  });

  it('reports what happened to the confirmation in a closed set of states', () => {
    expect(CONFIRMATION_STATUSES).toContain('queued');
    expect(CONFIRMATION_STATUSES).toContain('not_requested');
  });
});
