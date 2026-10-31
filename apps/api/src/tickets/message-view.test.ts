import type { schema } from '@watchtower/db';
import { describe, expect, it } from 'vitest';

import { toMessage, toTimelineEvent } from './message-view.js';

type MessageRow = typeof schema.message.$inferSelect;
type EventRow = typeof schema.ticketEvent.$inferSelect;

const USER = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const TICKET = '33333333-3333-4333-8333-333333333333';

function message(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    ticketId: TICKET,
    channelAccountId: null,
    direction: 'outbound',
    externalId: null,
    threadKey: null,
    senderContactId: null,
    senderUserId: USER,
    bodyText: 'hello',
    bodyHtml: null,
    bodyRedacted: null,
    attachments: [],
    visibility: 'public',
    deliveryStatus: 'delivered',
    createdAt: new Date('2026-11-02T03:00:00Z'),
    ...overrides,
  };
}

const context = {
  ticketKey: 'OPS-1234',
  channel: 'portal' as const,
  senderUserName: 'Somchai Staff',
  senderUserRole: 'agent',
  senderContactName: 'Ana Customer',
};

describe('toMessage', () => {
  it('shows staff who wrote a reply', () => {
    const view = toMessage(message(), { ...context, audience: 'staff' });
    expect(view.sender).toEqual({ type: 'user', id: USER, name: 'Somchai Staff' });
    expect(view.ticketKey).toBe('OPS-1234');
  });

  it('shows a client the support team, not the employee', () => {
    const view = toMessage(message(), { ...context, audience: 'client' });
    expect(view.sender).toEqual({ type: 'user', id: null, name: null });
    expect(JSON.stringify(view)).not.toContain(USER);
    expect(JSON.stringify(view)).not.toContain('Somchai');
  });

  it('keeps the names of the client own colleagues', () => {
    const colleague = toMessage(message({ direction: 'inbound' }), {
      ...context,
      senderUserRole: 'client',
      senderUserName: 'Colleague',
      audience: 'client',
    });
    expect(colleague.sender).toEqual({ type: 'user', id: USER, name: 'Colleague' });
    const contact = toMessage(message({ senderUserId: null, senderContactId: CONTACT }), {
      ...context,
      audience: 'client',
    });
    expect(contact.sender).toEqual({ type: 'contact', id: CONTACT, name: 'Ana Customer' });
  });

  it('describes a message without a sender as the system', () => {
    const view = toMessage(message({ senderUserId: null }), { ...context, audience: 'staff' });
    expect(view.sender).toEqual({ type: 'system', id: null, name: null });
  });
});

describe('toTimelineEvent', () => {
  const row: EventRow = {
    id: '55555555-5555-4555-8555-555555555555',
    createdAt: new Date('2026-11-02T03:00:00Z'),
    ticketId: TICKET,
    type: 'ticket.status_changed',
    actorType: 'user',
    actorId: USER,
    visibility: 'public',
    payload: { from: 'new', to: 'triage', reason: 'staff only', internalId: 'x' },
  };

  it('gives staff the whole event', () => {
    const view = toTimelineEvent(row, {
      ticketKey: 'OPS-1',
      actorName: 'Somchai',
      audience: 'staff',
    });
    expect(view.payload).toEqual(row.payload);
    expect(view.actor).toEqual({ type: 'user', id: USER, name: 'Somchai' });
  });

  it('gives a client only the allowed keys of the payload and no actor', () => {
    const view = toTimelineEvent(row, {
      ticketKey: 'OPS-1',
      actorName: 'Somchai',
      audience: 'client',
    });
    expect(view.payload).toEqual({ from: 'new', to: 'triage' });
    expect(view.actor).toEqual({ type: 'user', id: null, name: null });
  });

  it('gives a client nothing from an event type it does not know', () => {
    const view = toTimelineEvent(
      { ...row, type: 'sla.paused', payload: { reason: 'x' } },
      { ticketKey: 'OPS-1', actorName: null, audience: 'client' },
    );
    expect(view.payload).toEqual({});
  });
});
