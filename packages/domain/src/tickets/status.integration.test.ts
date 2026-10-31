import { schema } from '@watchtower/db';
import type { TicketStatus } from '@watchtower/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DomainError } from '../errors.js';
import {
  addOrg,
  addPolicy,
  auditRows,
  eventTypes,
  recordingNotifier,
  startDomainTest,
  type DomainTestEnv,
} from '../testing/support.js';

let env: DomainTestEnv;

beforeAll(async () => {
  env = await startDomainTest();
  await addPolicy(
    env,
    {
      P1: { first_response_min: 15, resolution_min: 120, calendar: '24x7' },
      P3: { first_response_min: 60, resolution_min: 240, calendar: '24x7' },
    },
    'standard',
  );
});
afterAll(async () => {
  await env.close();
});

const T0 = new Date('2030-01-07T10:00:00.000Z');
const minutesAfter = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

async function openTicket(priority: 'P1' | 'P3' = 'P3') {
  const org = await addOrg(env);
  const { value } = await env.tx((tx) =>
    env.domain.tickets.create(tx, env.ctx(undefined, { now: () => T0 }), {
      orgId: org.id,
      subject: 'a',
      body: 'b',
      priority,
    }),
  );
  return value.ticket;
}

const move = (ref: string, status: TicketStatus, at: Date, notifier = recordingNotifier()) =>
  env.tx((tx) =>
    env.domain.tickets.changeStatus(tx, env.ctx(undefined, { now: () => at, notifier }), {
      ref,
      status,
      reason: 'testing',
    }),
  );

const refusal = async (work: Promise<unknown>): Promise<DomainError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

describe('tickets.changeStatus', () => {
  it('moves along the workflow, audits once, and returns a ticket.updated event', async () => {
    const ticket = await openTicket();
    const notifier = recordingNotifier();
    const result = await move(ticket.id, 'open', minutesAfter(1), notifier);
    expect(result.value.status).toBe('open');
    expect(result.audited).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ type: 'ticket.updated', ticketId: ticket.id });
    expect(
      (await auditRows(env, 'ticket.status_change')).filter((row) => row.targetId === ticket.id),
    ).toHaveLength(1);
    // The domain always offers the change; the notifier decides whether the customer hears of it.
    expect(notifier.calls).toEqual([`statusChange:OPS-${String(ticket.number)}:new>open`]);
  });

  it('refuses what the workflow does not allow, and a status of a merged ticket', async () => {
    const ticket = await openTicket();
    expect((await refusal(move(ticket.id, 'new', minutesAfter(1)))).code).toBe(
      'invalid_transition',
    );
    expect((await refusal(move(ticket.id, 'merged', minutesAfter(1)))).code).toBe(
      'invalid_transition',
    );
    expect((await refusal(move('OPS-0', 'open', minutesAfter(1)))).code).toBe('not_found');
    expect((await refusal(move('not a ticket', 'open', minutesAfter(1)))).code).toBe('not_found');
  });

  it('follows a workflow a head changed, at once', async () => {
    const ticket = await openTicket();
    await env.db.owner.db
      .delete(schema.ticketStatusTransition)
      .where(
        and(
          eq(schema.ticketStatusTransition.fromStatus, 'new'),
          eq(schema.ticketStatusTransition.toStatus, 'open'),
        ),
      );
    expect((await refusal(move(ticket.id, 'open', minutesAfter(1)))).code).toBe(
      'invalid_transition',
    );
    await env.db.owner.db
      .insert(schema.ticketStatusTransition)
      .values({ fromStatus: 'new', toStatus: 'open' });
    expect((await move(ticket.id, 'open', minutesAfter(1))).value.status).toBe('open');
  });

  it('stops the SLA clock on waiting_on_customer and restarts it with the remaining time', async () => {
    const ticket = await openTicket('P3');
    const waiting = await move(ticket.id, 'waiting_on_customer', minutesAfter(10));
    expect(waiting.value.slaPausedAt).toEqual(minutesAfter(10));
    expect(await eventTypes(env, ticket.id)).toContain('sla.paused');

    const resumed = await move(ticket.id, 'open', minutesAfter(40));
    expect(resumed.value.slaPausedAt).toBeNull();
    // 30 minutes of waiting push both targets back by 30 minutes (24x7 clock).
    const original = ticket.resolutionDueAt;
    expect(original).toBeInstanceOf(Date);
    expect(resumed.value.resolutionDueAt?.getTime()).toBe((original?.getTime() ?? 0) + 30 * 60_000);
    expect(resumed.value.firstResponseDueAt?.getTime()).toBe(
      (ticket.firstResponseDueAt?.getTime() ?? 0) + 30 * 60_000,
    );
    expect(await eventTypes(env, ticket.id)).toContain('sla.resumed');
  });

  it('counts a reopen when a finished ticket goes back to work', async () => {
    const ticket = await openTicket();
    await move(ticket.id, 'open', minutesAfter(1));
    const resolved = await move(ticket.id, 'resolved', minutesAfter(2));
    expect(resolved.value.resolvedAt).toEqual(minutesAfter(2));
    const reopened = await move(ticket.id, 'open', minutesAfter(3));
    expect(reopened.value).toMatchObject({ status: 'open', resolvedAt: null, reopenCount: 1 });
    expect(await eventTypes(env, ticket.id)).toEqual(
      expect.arrayContaining(['ticket.reopened', 'ticket.status_changed']),
    );
  });

  it('revokes the tracking links when closing and tells the notifier in order', async () => {
    const ticket = await openTicket();
    await move(ticket.id, 'open', minutesAfter(1));
    const notifier = recordingNotifier();
    await move(ticket.id, 'closed', minutesAfter(2), notifier);
    expect(notifier.calls).toEqual([
      `closeLinks:${ticket.id}`,
      `statusChange:OPS-${String(ticket.number)}:open>closed`,
    ]);
  });
});
