import { schema } from '@watchtower/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DomainError } from '../errors.js';
import {
  addIntent,
  addOrg,
  addPolicy,
  addQueue,
  addStaff,
  auditRows,
  eventTypes,
  markMerged,
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

async function openTicket(
  orgId?: string,
  fields: { priority?: 'P1' | 'P3'; queueId?: string } = {},
) {
  const id = orgId ?? (await addOrg(env)).id;
  const { value } = await env.tx((tx) =>
    env.domain.tickets.create(tx, env.ctx(undefined, { now: () => T0 }), {
      orgId: id,
      subject: 'a',
      body: 'b',
      ...fields,
    }),
  );
  return value.ticket;
}

const refusal = async (work: Promise<unknown>): Promise<DomainError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

describe('tickets.update', () => {
  it('recomputes the SLA from creation when the priority changes', async () => {
    const ticket = await openTicket(undefined, { priority: 'P3' });
    const { id } = ticket;
    const result = await env.tx((tx) =>
      env.domain.tickets.update(
        tx,
        env.ctx(undefined, { now: () => new Date(T0.getTime() + 600_000) }),
        {
          ref: id,
          patch: { priority: 'P1' },
        },
      ),
    );
    expect(result.value.priority).toBe('P1');
    expect(result.value.resolutionDueAt).toEqual(new Date(T0.getTime() + 120 * 60_000));
    expect(result.value.firstResponseDueAt).toEqual(new Date(T0.getTime() + 15 * 60_000));
    expect(result.events).toHaveLength(1);
    expect(result.audited).toBe(true);
    expect(await eventTypes(env, id)).toEqual(
      expect.arrayContaining(['ticket.updated', 'sla.recalculated']),
    );
  });

  it('applies the pauses that already ended when it recomputes', async () => {
    const ticket = await openTicket(undefined, { priority: 'P3' });
    const at = (minutes: number) => ({ now: () => new Date(T0.getTime() + minutes * 60_000) });
    await env.tx((tx) =>
      env.domain.tickets.changeStatus(tx, env.ctx(undefined, at(10)), {
        ref: ticket.id,
        status: 'waiting_on_customer',
      }),
    );
    await env.tx((tx) =>
      env.domain.tickets.changeStatus(tx, env.ctx(undefined, at(70)), {
        ref: ticket.id,
        status: 'open',
      }),
    );
    const result = await env.tx((tx) =>
      env.domain.tickets.update(tx, env.ctx(undefined, at(80)), {
        ref: ticket.id,
        patch: { priority: 'P1' },
      }),
    );
    // P1 resolves in 120 minutes from creation, and the 60 minutes spent waiting do not count.
    expect(result.value.resolutionDueAt).toEqual(new Date(T0.getTime() + 180 * 60_000));
  });

  it('writes nothing when the patch changes nothing', async () => {
    const ticket = await openTicket();
    const auditsBefore = (await auditRows(env)).length;
    const result = await env.tx((tx) =>
      env.domain.tickets.update(tx, env.ctx(), {
        ref: ticket.id,
        patch: { subject: ticket.subject, priority: 'P3' },
      }),
    );
    expect(result.value.id).toBe(ticket.id);
    expect(result.events).toEqual([]);
    expect(result.audited).toBe(false);
    expect((await auditRows(env)).length).toBe(auditsBefore);
  });

  it('changes intent and queue, and refuses an unknown intent, an unknown queue and a merged ticket', async () => {
    const ticket = await openTicket();
    const intent = await addIntent(env);
    const queue = await addQueue(env);
    const done = await env.tx((tx) =>
      env.domain.tickets.update(tx, env.ctx(), {
        ref: ticket.id,
        patch: { intentId: intent.id, queueId: queue.id, tags: ['vip'], customFields: { a: 1 } },
      }),
    );
    expect(done.value).toMatchObject({ intentId: intent.id, queueId: queue.id, tags: ['vip'] });
    expect(
      (
        await refusal(
          env.tx((tx) =>
            env.domain.tickets.update(tx, env.ctx(), {
              ref: ticket.id,
              patch: { intentId: '00000000-0000-4000-8000-000000000000' },
            }),
          ),
        )
      ).code,
    ).toBe('bad_request');
    expect(
      (
        await refusal(
          env.tx((tx) =>
            env.domain.tickets.update(tx, env.ctx(), {
              ref: ticket.id,
              patch: { queueId: '00000000-0000-4000-8000-000000000000' },
            }),
          ),
        )
      ).code,
    ).toBe('bad_request');
    await markMerged(env, ticket.id);
    expect(
      (
        await refusal(
          env.tx((tx) =>
            env.domain.tickets.update(tx, env.ctx(), { ref: ticket.id, patch: { subject: 'x' } }),
          ),
        )
      ).code,
    ).toBe('ticket_not_open');
  });
});

describe('tickets.assign', () => {
  it('assigns by hand, to active staff only', async () => {
    const ticket = await openTicket();
    const staff = await addStaff(env);
    const result = await env.tx((tx) =>
      env.domain.tickets.assign(tx, env.ctx(staff.actor), {
        ref: ticket.id,
        assignment: { assigneeId: staff.id },
      }),
    );
    expect(result.value.assigneeId).toBe(staff.id);
    expect(result.audited).toBe(true);
    expect(result.events[0]?.data).toMatchObject({ changed: ['assignee'] });
    expect(await eventTypes(env, ticket.id)).toContain('ticket.assigned');

    const error = await refusal(
      env.tx((tx) =>
        env.domain.tickets.assign(tx, env.ctx(), {
          ref: ticket.id,
          assignment: { assigneeId: '00000000-0000-4000-8000-000000000000' },
        }),
      ),
    );
    expect(error.code).toBe('bad_request');
  });

  it('round-robin hands the ticket to whoever is next, and takes the turn only when it moves', async () => {
    const a = await addStaff(env);
    const b = await addStaff(env);
    const [first = '', second = ''] = [a.id, b.id].toSorted();
    const queue = await addQueue(env, { mode: 'round_robin', members: [a.id, b.id] });
    const cursor = async () => {
      const [row] = await env.db.owner.db
        .select({ last: schema.teamQueue.lastAssignedUserId })
        .from(schema.teamQueue)
        .where(eq(schema.teamQueue.id, queue.id));
      return row?.last;
    };
    const roundRobin = (ref: string) =>
      env.tx((tx) =>
        env.domain.tickets.assign(tx, env.ctx(), {
          ref,
          assignment: { strategy: 'round_robin', queueId: queue.id },
        }),
      );

    // Creating on a round-robin queue takes the first turn.
    const ticket = await openTicket(undefined, { queueId: queue.id });
    expect(ticket.assigneeId).toBe(first);
    expect(await cursor()).toBe(first);

    // By hand to the member whose turn is next: asking round-robin now changes nothing, and the
    // turn is not used up.
    await env.tx((tx) =>
      env.domain.tickets.assign(tx, env.ctx(), {
        ref: ticket.id,
        assignment: { assigneeId: second },
      }),
    );
    const noop = await roundRobin(ticket.id);
    expect(noop.audited).toBe(false);
    expect(noop.events).toEqual([]);
    expect(await cursor()).toBe(first);

    // A ticket held by someone else moves to the member whose turn it is, and uses the turn.
    const other = await openTicket(undefined, { queueId: queue.id });
    expect(other.assigneeId).toBe(second);
    const moved = await roundRobin(other.id);
    expect(moved.value.assigneeId).toBe(first);
    expect(moved.audited).toBe(true);
    expect(await cursor()).toBe(first);
  });

  it('writes nothing when assigning what is already so', async () => {
    const staff = await addStaff(env);
    const ticket = await openTicket();
    const input = { ref: ticket.id, assignment: { assigneeId: staff.id } } as const;
    await env.tx((tx) => env.domain.tickets.assign(tx, env.ctx(), input));
    const again = await env.tx((tx) => env.domain.tickets.assign(tx, env.ctx(), input));
    expect(again.events).toEqual([]);
    expect(again.audited).toBe(false);
  });

  it('refuses round-robin without a queue, on an empty queue, and on a merged ticket', async () => {
    const ticket = await openTicket();
    const roundRobin = (ref: string, queueId?: string) =>
      env.tx((tx) =>
        env.domain.tickets.assign(tx, env.ctx(), {
          ref,
          assignment: { strategy: 'round_robin', ...(queueId === undefined ? {} : { queueId }) },
        }),
      );
    expect((await refusal(roundRobin(ticket.id))).code).toBe('bad_request');
    const empty = await addQueue(env, { mode: 'round_robin' });
    expect((await refusal(roundRobin(ticket.id, empty.id))).code).toBe('conflict');
    await markMerged(env, ticket.id);
    expect((await refusal(roundRobin(ticket.id, empty.id))).code).toBe('ticket_not_open');
  });
});

describe('tickets.merge', () => {
  it('merges the source into the target, moves its children, and tells the notifier', async () => {
    const org = await addOrg(env);
    const source = await openTicket(org.id);
    const target = await openTicket(org.id);
    const child = await openTicket(org.id);
    await env.db.owner.db
      .update(schema.ticket)
      .set({ parentTicketId: source.id, status: 'merged' })
      .where(eq(schema.ticket.id, child.id));

    const notifier = recordingNotifier();
    const result = await env.tx((tx) =>
      env.domain.tickets.merge(tx, env.ctx(undefined, { notifier }), {
        ref: source.id,
        merge: { intoTicketId: target.id, reason: 'duplicate' },
      }),
    );
    expect(result.value.source).toMatchObject({ status: 'merged', parentTicketId: target.id });
    expect(result.value.target.id).toBe(target.id);
    expect(notifier.calls).toEqual([
      `merged:OPS-${String(source.number)}>OPS-${String(target.number)}`,
    ]);
    expect(result.events.map((event) => event.data)).toEqual([
      expect.objectContaining({ changed: ['merge'] }),
      expect.objectContaining({ changed: ['status'] }),
      expect.objectContaining({ changed: ['merge'] }),
    ]);
    const [movedChild] = await env.db.owner.db
      .select()
      .from(schema.ticket)
      .where(eq(schema.ticket.id, child.id));
    expect(movedChild?.parentTicketId).toBe(target.id);
    expect(await eventTypes(env, source.id)).toContain('ticket.merged');
    expect(await eventTypes(env, target.id)).toContain('ticket.merge_received');
    expect(await eventTypes(env, child.id)).toContain('ticket.reparented');
    const actions = (await auditRows(env))
      .filter((row) => [source.id, child.id].includes(row.targetId ?? ''))
      .map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(['ticket.merge', 'ticket.reparent']));
  });

  it('refuses itself, another organization, a merged source or target, and a closed target', async () => {
    const org = await addOrg(env);
    const a = await openTicket(org.id);
    const b = await openTicket(org.id);
    const foreign = await openTicket();
    const merge = (ref: string, into: string) =>
      env.tx((tx) =>
        env.domain.tickets.merge(tx, env.ctx(), { ref, merge: { intoTicketId: into } }),
      );
    const setClosed = (id: string) =>
      env.db.owner.db
        .update(schema.ticket)
        .set({ status: 'closed' })
        .where(eq(schema.ticket.id, id));

    expect((await refusal(merge(a.id, a.id))).code).toBe('merge_not_allowed');
    expect((await refusal(merge(a.id, foreign.id))).code).toBe('merge_not_allowed');
    await setClosed(b.id);
    expect((await refusal(merge(a.id, b.id))).code).toBe('merge_not_allowed');
    await markMerged(env, b.id);
    expect((await refusal(merge(a.id, b.id))).code).toBe('merge_not_allowed');
    expect((await refusal(merge(b.id, a.id))).code).toBe('merge_not_allowed');
    expect((await refusal(merge(a.id, '00000000-0000-4000-8000-000000000000'))).code).toBe(
      'not_found',
    );
  });

  it('two merges of the same pair in opposite directions: one wins, the other is refused', async () => {
    const org = await addOrg(env);
    const a = await openTicket(org.id);
    const b = await openTicket(org.id);
    const merge = (ref: string, into: string) =>
      env.tx((tx) =>
        env.domain.tickets.merge(tx, env.ctx(), { ref, merge: { intoTicketId: into } }),
      );
    const outcomes = await Promise.allSettled([merge(a.id, b.id), merge(b.id, a.id)]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({
      code: 'merge_not_allowed',
    });
  });
});
