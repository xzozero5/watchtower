import { schema } from '@watchtower/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pickLeastLoaded } from './assignment.js';
import {
  addOrg,
  addQueue,
  addStaff,
  clockIn,
  startDomainTest,
  type DomainTestEnv,
} from './testing/support.js';

// R-1.7 with shifts (T-111e): automatic assignment picks only people who are clocked in.

let env: DomainTestEnv;
let orgId: string;
let counter = 0;

beforeAll(async () => {
  env = await startDomainTest();
  orgId = (await addOrg(env)).id;
});
afterAll(async () => {
  await env.close();
});

async function fileTicket(queueId: string, requesterEmail?: string) {
  counter += 1;
  const { value } = await env.tx((tx) =>
    env.domain.tickets.create(tx, env.ctx(), {
      orgId,
      queueId,
      subject: `Ticket ${String(counter)}`,
      body: 'b',
      ...(requesterEmail === undefined ? {} : { requester: { email: requesterEmail, name: 'R' } }),
    }),
  );
  return value.ticket;
}

async function setStatus(ticketId: string, status: string): Promise<void> {
  await env.db.owner.db.update(schema.ticket).set({ status }).where(eq(schema.ticket.id, ticketId));
}

describe('pickLeastLoaded', () => {
  it('takes the fewest open tickets, and rotates among equals', () => {
    const people = [
      { id: 'a', open: 3 },
      { id: 'b', open: 1 },
      { id: 'c', open: 1 },
    ];
    expect(pickLeastLoaded(people, null)).toBe('b');
    expect(pickLeastLoaded(people, 'b')).toBe('c');
    expect(pickLeastLoaded(people, 'c')).toBe('b');
    expect(pickLeastLoaded([], null)).toBeNull();
  });
});

describe('round robin picks only people who are clocked in', () => {
  it('skips a member who is not clocked in, or who clocked out', async () => {
    const [a, b, c] = [await addStaff(env), await addStaff(env), await addStaff(env)];
    const queue = await addQueue(env, { mode: 'round_robin', members: [a.id, b.id, c.id] });
    await clockIn(env, a.id);
    await clockIn(env, b.id);
    // c never clocked in.
    const sorted = [a.id, b.id].toSorted();
    const first = await fileTicket(queue.id);
    const second = await fileTicket(queue.id);
    const third = await fileTicket(queue.id);
    expect([first, second, third].map((t) => t.assigneeId)).toEqual([
      sorted[0],
      sorted[1],
      sorted[0],
    ]);

    await env.db.owner.db
      .update(schema.shiftSession)
      .set({ clockedOutAt: new Date() })
      .where(eq(schema.shiftSession.userId, a.id));
    const afterOut = await fileTicket(queue.id);
    expect(afterOut.assigneeId).toBe(b.id);
  });

  it('leaves the ticket unassigned when nobody is clocked in, and refuses an assign request', async () => {
    const a = await addStaff(env);
    const queue = await addQueue(env, { mode: 'round_robin', members: [a.id] });
    const ticket = await fileTicket(queue.id);
    expect(ticket.assigneeId).toBeNull();
    await expect(
      env.tx((tx) =>
        env.domain.tickets.assign(tx, env.ctx(), {
          ref: ticket.id,
          assignment: { strategy: 'round_robin' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('does not count a clock in that was forgotten for more than 16 hours', async () => {
    const a = await addStaff(env);
    const b = await addStaff(env);
    const queue = await addQueue(env, { mode: 'round_robin', members: [a.id, b.id] });
    await clockIn(env, a.id, new Date(Date.now() - 17 * 3_600_000));
    await clockIn(env, b.id);
    const tickets = [await fileTicket(queue.id), await fileTicket(queue.id)];
    expect(tickets.map((t) => t.assigneeId)).toEqual([b.id, b.id]);
  });

  it('does not stop a manual assignment to someone who is off shift', async () => {
    const off = await addStaff(env);
    const queue = await addQueue(env, { mode: 'manual', members: [off.id] });
    const ticket = await fileTicket(queue.id);
    const assigned = await env.tx((tx) =>
      env.domain.tickets.assign(tx, env.ctx(), {
        ref: ticket.id,
        assignment: { assigneeId: off.id },
      }),
    );
    expect(assigned.value.assigneeId).toBe(off.id);
  });
});

describe('load balanced', () => {
  it('gives the ticket to the clocked-in member with the fewest open tickets, not counting finished ones', async () => {
    const [a, b] = [await addStaff(env), await addStaff(env)];
    const loaded = await addQueue(env, { mode: 'manual', members: [a.id, b.id] });
    // a holds two open tickets and one resolved; b holds one open.
    for (const owner of [a.id, a.id, b.id]) {
      const t = await fileTicket(loaded.id);
      await env.tx((tx) =>
        env.domain.tickets.assign(tx, env.ctx(), { ref: t.id, assignment: { assigneeId: owner } }),
      );
    }
    const done = await fileTicket(loaded.id);
    await env.tx((tx) =>
      env.domain.tickets.assign(tx, env.ctx(), { ref: done.id, assignment: { assigneeId: b.id } }),
    );
    await setStatus(done.id, 'resolved');

    await clockIn(env, a.id);
    await clockIn(env, b.id);
    const queue = await addQueue(env, { mode: 'load_balanced', members: [a.id, b.id] });
    const next = await fileTicket(queue.id);
    expect(next.assigneeId).toBe(b.id); // 1 open vs 2
    // b now holds 2, equal to a: the tie rotates, so a is next.
    const after = await fileTicket(queue.id);
    expect(after.assigneeId).toBe(a.id);
  });

  it('ignores a member who is off shift even when they carry nothing', async () => {
    const [busy, idle] = [await addStaff(env), await addStaff(env)];
    const queue = await addQueue(env, { mode: 'load_balanced', members: [busy.id, idle.id] });
    await clockIn(env, busy.id);
    const ticket = await fileTicket(queue.id);
    expect(ticket.assigneeId).toBe(busy.id);
  });
});

describe('stay with the last handler', () => {
  it('returns a requester to the person who handled their last ticket, if they are on shift', async () => {
    const [a, b] = [await addStaff(env), await addStaff(env)];
    await clockIn(env, a.id);
    await clockIn(env, b.id);
    const queue = await addQueue(env, { mode: 'stay_with_last_handler', members: [a.id, b.id] });
    const email = `stay-${String(counter)}@example.test`;
    const first = await fileTicket(queue.id, email);
    expect(first.assigneeId).not.toBeNull();
    const handler = first.assigneeId ?? '';
    // Make the handler the busiest: load alone would send the next ticket to the other person.
    for (let i = 0; i < 3; i += 1) {
      const filler = await fileTicket(queue.id);
      await env.tx((tx) =>
        env.domain.tickets.assign(tx, env.ctx(), {
          ref: filler.id,
          assignment: { assigneeId: handler },
        }),
      );
    }
    const again = await fileTicket(queue.id, email);
    expect(again.assigneeId).toBe(handler);

    // Another requester has no history: load decides, so the other person gets it.
    const stranger = await fileTicket(queue.id, `other-${String(counter)}@example.test`);
    expect(stranger.assigneeId).not.toBe(handler);
  });

  it('falls back to load when the last handler is off shift', async () => {
    const [a, b] = [await addStaff(env), await addStaff(env)];
    await clockIn(env, b.id); // only b is on shift
    const queue = await addQueue(env, { mode: 'stay_with_last_handler', members: [a.id, b.id] });
    const email = `fallback-${String(counter)}@example.test`;
    const first = await fileTicket(queue.id, email);
    await env.tx((tx) =>
      env.domain.tickets.assign(tx, env.ctx(), { ref: first.id, assignment: { assigneeId: a.id } }),
    );
    const again = await fileTicket(queue.id, email);
    expect(again.assigneeId).toBe(b.id);
  });

  it('works on request for an existing ticket, without counting that ticket as the last one', async () => {
    const [a, b] = [await addStaff(env), await addStaff(env)];
    await clockIn(env, a.id);
    await clockIn(env, b.id);
    const queue = await addQueue(env, { mode: 'manual', members: [a.id, b.id] });
    const email = `request-${String(counter)}@example.test`;
    const previous = await fileTicket(queue.id, email);
    await env.tx((tx) =>
      env.domain.tickets.assign(tx, env.ctx(), {
        ref: previous.id,
        assignment: { assigneeId: b.id },
      }),
    );
    const current = await fileTicket(queue.id, email);
    await env.tx((tx) =>
      env.domain.tickets.assign(tx, env.ctx(), {
        ref: current.id,
        assignment: { assigneeId: a.id },
      }),
    );
    const moved = await env.tx((tx) =>
      env.domain.tickets.assign(tx, env.ctx(), {
        ref: current.id,
        assignment: { strategy: 'stay_with_last_handler' },
      }),
    );
    // The latest other ticket of this requester is `previous`, held by b; `current` itself is ignored.
    expect(moved.value.assigneeId).toBe(b.id);
  });
});
