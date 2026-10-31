import { describe, expect, it } from 'vitest';

import { realtimeEventFor, realtimeEventSchema, type RealtimeEvent } from './realtime.js';

const ORG_A = '0b3f7a9c-1e0d-4c53-9a5e-6f2f3f4c9d10';
const ORG_B = '7c1a2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const IDS = {
  id: '11111111-1111-4111-8111-111111111111',
  ticketId: '22222222-2222-4222-8222-222222222222',
  messageId: '33333333-3333-4333-8333-333333333333',
};

function ticketEvent(
  type: 'ticket.created' | 'ticket.updated',
  changed: string[],
  orgId = ORG_A,
): RealtimeEvent {
  return {
    id: IDS.id,
    type,
    occurredAt: '2026-11-02T03:00:00.000Z',
    orgId,
    ticketId: IDS.ticketId,
    ticketKey: 'OPS-1001',
    data: {
      subject: 'Cannot log in',
      status: 'open',
      priority: 'P2',
      assigneeId: '44444444-4444-4444-8444-444444444444',
      queueId: '55555555-5555-4555-8555-555555555555',
      changed,
    },
  };
}

const updated = (changed: string[], orgId = ORG_A) => ticketEvent('ticket.updated', changed, orgId);

function message(visibility: 'public' | 'internal', orgId = ORG_A): RealtimeEvent {
  return {
    id: IDS.id,
    type: 'message.created',
    occurredAt: '2026-11-02T03:00:00.000Z',
    orgId,
    ticketId: IDS.ticketId,
    ticketKey: 'OPS-1001',
    data: {
      messageId: IDS.messageId,
      direction: visibility === 'internal' ? 'internal' : 'outbound',
      visibility,
    },
  };
}

describe('realtimeEventFor', () => {
  it('gives staff every event unchanged', () => {
    for (const event of [updated(['assignee']), message('internal'), message('public', ORG_B)]) {
      expect(realtimeEventFor({ kind: 'staff' }, event)).toEqual(event);
    }
  });

  it('never gives a client an internal note, in their own organization or any other', () => {
    expect(realtimeEventFor({ kind: 'client', orgId: ORG_A }, message('internal'))).toBeNull();
    expect(realtimeEventFor({ kind: 'client', orgId: ORG_B }, message('internal'))).toBeNull();
  });

  it('gives a client public messages of their own organization only', () => {
    expect(realtimeEventFor({ kind: 'client', orgId: ORG_A }, message('public'))).toEqual(
      message('public'),
    );
    expect(realtimeEventFor({ kind: 'client', orgId: ORG_B }, message('public'))).toBeNull();
  });

  it('drops staff-only fields and staff-only changes from ticket updates for a client', () => {
    const forClient = realtimeEventFor(
      { kind: 'client', orgId: ORG_A },
      updated(['status', 'assignee', 'tags']),
    );
    expect(forClient).not.toBeNull();
    expect(forClient?.type === 'ticket.updated' && forClient.data).toEqual({
      subject: 'Cannot log in',
      status: 'open',
      priority: 'P2',
      changed: ['status'],
    });
    expect(JSON.stringify(forClient)).not.toContain('4444');
    expect(JSON.stringify(forClient)).not.toContain('5555');
  });

  it('says nothing to a client when only internal fields changed', () => {
    expect(
      realtimeEventFor({ kind: 'client', orgId: ORG_A }, updated(['assignee', 'tags', 'sla'])),
    ).toBeNull();
  });

  it('tells a client about a new ticket of their organization without staff fields', () => {
    const created = ticketEvent('ticket.created', []);
    const forClient = realtimeEventFor({ kind: 'client', orgId: ORG_A }, created);
    expect(forClient?.type === 'ticket.created' && forClient.data.assigneeId).toBeUndefined();
    expect(realtimeEventFor({ kind: 'client', orgId: ORG_B }, created)).toBeNull();
  });

  it('is what the schema accepts', () => {
    expect(realtimeEventSchema.safeParse(updated(['status'])).success).toBe(true);
    expect(realtimeEventSchema.safeParse({ ...updated([]), type: 'ticket.deleted' }).success).toBe(
      false,
    );
  });
});
