import { randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Effects } from './types.js';
import { notifyIn, notifyOpsAlert, notifyShiftAlerts } from './notifications.js';
import {
  addOrg,
  addQueue,
  addStaff,
  startDomainTest,
  type DomainTestEnv,
} from './testing/support.js';

let env: DomainTestEnv;

beforeAll(async () => {
  env = await startDomainTest();
});
afterAll(async () => {
  await env.close();
});

const notificationsOf = (userId: string) =>
  env.db.owner.db.select().from(schema.notification).where(eq(schema.notification.userId, userId));

async function createTicket(
  actorId: string | null,
  fields: { priority?: 'P1' | 'P3'; queueId?: string; assigneeId?: string } = {},
) {
  const org = await addOrg(env);
  const result = await env.tx((tx) =>
    env.domain.tickets.create(tx, env.ctx({ type: 'user', id: actorId }), {
      orgId: org.id,
      subject: 'Cannot sign in',
      body: 'Password rejected',
      requester: { email: `${randomUUID()}@example.test`, name: 'Requester' },
      priority: fields.priority ?? 'P3',
      ...(fields.queueId === undefined ? {} : { queueId: fields.queueId }),
      ...(fields.assigneeId === undefined ? {} : { assigneeId: fields.assigneeId }),
    }),
  );
  return result;
}

describe('a P1 ticket', () => {
  it('notifies the queue members, the assignee and the leads in the same transaction, and emits one event each', async () => {
    const agent = await addStaff(env, 'agent');
    const member = await addStaff(env, 'agent');
    const bystander = await addStaff(env, 'agent');
    const lead = await addStaff(env, 'lead');
    const queue = await addQueue(env, { members: [member.id] });
    const result = await createTicket(agent.id, {
      priority: 'P1',
      queueId: queue.id,
      assigneeId: agent.id,
    });

    expect(await notificationsOf(member.id)).toHaveLength(1);
    expect(await notificationsOf(lead.id)).toHaveLength(1);
    expect(await notificationsOf(bystander.id)).toHaveLength(0);
    // The person who did it, though assignee, is not told about what they just did.
    expect(await notificationsOf(agent.id)).toHaveLength(0);

    const [mine] = await notificationsOf(member.id);
    expect(mine).toMatchObject({
      kind: 'ticket.p1',
      severity: 'critical',
      queueId: queue.id,
      channel: result.value.ticket.channel,
      ticketId: result.value.ticket.id,
      readAt: null,
    });

    const addressed = result.events.filter((event) => event.type === 'notification.created');
    expect(addressed.map((event) => event.recipientId).toSorted()).toEqual(
      [member.id, ...(await leadsOf())].toSorted(),
    );
    // Ids only: not the subject, not the body.
    expect(JSON.stringify(addressed)).not.toContain('Cannot sign in');
  });

  it('does not notify for a P3 ticket, and does not make a ticket fail when nobody is to be told', async () => {
    const agent = await addStaff(env, 'agent');
    const lead = await addStaff(env, 'lead');
    const result = await createTicket(agent.id, { priority: 'P3' });
    expect(result.events.some((event) => event.type === 'notification.created')).toBe(false);
    expect(await notificationsOf(lead.id)).toHaveLength(0);
  });

  it('skips a lead who is disabled and a person who is not staff', async () => {
    const lead = await addStaff(env, 'lead');
    await env.db.owner.db
      .update(schema.users)
      .set({ status: 'disabled' })
      .where(eq(schema.users.id, lead.id));
    const org = await addOrg(env);
    const [clientUser] = await env.db.owner.db
      .insert(schema.users)
      .values({
        email: `${randomUUID()}@example.test`,
        name: 'Client',
        role: 'client',
        orgId: org.id,
      })
      .returning({ id: schema.users.id });
    const queue = await addQueue(env, { members: [] });
    await createTicket(null, { priority: 'P1', queueId: queue.id });
    expect(await notificationsOf(lead.id)).toHaveLength(0);
    // A client is never a recipient, even if someone passes their id in.
    const fx = new Effects();
    const made = await env.tx((tx) =>
      notifyIn(tx, env.ctx(), fx, {
        kind: 'ticket.assigned',
        severity: 'normal',
        recipients: [clientUser?.id ?? ''],
        dedupeKey: 'x',
      }),
    );
    expect(made).toBe(0);
    expect(fx.events).toEqual([]);
  });

  it('is raised when a ticket is updated to P1, once per person', async () => {
    const lead = await addStaff(env, 'lead');
    const created = await createTicket(null, { priority: 'P3' });
    const ticket = created.value.ticket;
    const before = (await notificationsOf(lead.id)).length;
    for (const priority of ['P1', 'P3', 'P1'] as const) {
      await env.tx((tx) =>
        env.domain.tickets.update(tx, env.ctx({ type: 'user', id: null }), {
          ref: ticket.id,
          patch: { priority },
        }),
      );
    }
    const after = (await notificationsOf(lead.id)).filter((row) => row.ticketId === ticket.id);
    expect(after).toHaveLength(1);
    expect((await notificationsOf(lead.id)).length).toBe(before + 1);
  });

  it('is rolled back with the ticket', async () => {
    const lead = await addStaff(env, 'lead');
    const org = await addOrg(env);
    const attempt = env.tx(async (tx) => {
      await env.domain.tickets.create(tx, env.ctx(), {
        orgId: org.id,
        subject: 'Will not stay',
        body: 'x',
        requester: { email: `${randomUUID()}@example.test`, name: 'R' },
        priority: 'P1',
      });
      throw new Error('boom');
    });
    await expect(attempt).rejects.toThrow('boom');
    expect(await notificationsOf(lead.id)).toHaveLength(0);
  });
});

async function leadsOf(): Promise<string[]> {
  const rows = await env.db.owner.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.role, 'lead'), eq(schema.users.status, 'active')));
  return rows.map((row) => row.id);
}

describe('an assignment', () => {
  it('tells the new assignee, not the person who assigned to themselves, and not twice for a P1', async () => {
    const lead = await addStaff(env, 'lead');
    const agent = await addStaff(env, 'agent');
    const created = await createTicket(null, { priority: 'P3' });
    await env.tx((tx) =>
      env.domain.tickets.assign(tx, env.ctx(lead.actor), {
        ref: created.value.ticket.id,
        assignment: { assigneeId: agent.id },
      }),
    );
    const mine = await notificationsOf(agent.id);
    expect(mine.map((row) => row.kind)).toEqual(['ticket.assigned']);

    const self = await createTicket(null, { priority: 'P3' });
    await env.tx((tx) =>
      env.domain.tickets.assign(tx, env.ctx(agent.actor), {
        ref: self.value.ticket.id,
        assignment: { assigneeId: agent.id },
      }),
    );
    expect(await notificationsOf(agent.id)).toHaveLength(1);

    // A P1 handed to someone: the P1 alert covers it.
    const urgent = await createTicket(lead.id, { priority: 'P1', assigneeId: agent.id });
    const forUrgent = (await notificationsOf(agent.id)).filter(
      (row) => row.ticketId === urgent.value.ticket.id,
    );
    expect(forUrgent.map((row) => row.kind)).toEqual(['ticket.p1']);
  });

  it('stays silent for a person who turned the kind off', async () => {
    const lead = await addStaff(env, 'lead');
    const quiet = await addStaff(env, 'agent');
    await env.db.owner.db
      .insert(schema.notificationPreference)
      .values({ userId: quiet.id, kind: 'ticket.assigned', inApp: false });
    const created = await createTicket(null, { priority: 'P3' });
    await env.tx((tx) =>
      env.domain.tickets.assign(tx, env.ctx(lead.actor), {
        ref: created.value.ticket.id,
        assignment: { assigneeId: quiet.id },
      }),
    );
    expect(await notificationsOf(quiet.id)).toHaveLength(0);
  });
});

describe('shift alerts', () => {
  it('tells the leads once per no-show and per handoff, with a count, and agents never', async () => {
    const lead = await addStaff(env, 'lead');
    const head = await addStaff(env, 'head');
    const agent = await addStaff(env, 'agent');
    const entry = randomUUID();
    const handoff = randomUUID();
    const overview = {
      noShows: [{ id: entry }],
      unacknowledged: {
        items: [
          { handoffId: handoff, overdue: true },
          { handoffId: handoff, overdue: true },
          { handoffId: randomUUID(), overdue: false },
        ],
      },
    };
    const run = () =>
      env.tx((tx) =>
        notifyShiftAlerts(tx, env.ctx({ type: 'system', id: null }), new Effects(), overview),
      );
    const first = await run();
    expect(first).toBeGreaterThanOrEqual(4);
    expect(await run()).toBe(0);

    for (const person of [lead, head]) {
      const rows = await notificationsOf(person.id);
      expect(rows.map((row) => row.kind).toSorted()).toEqual([
        'shift.handoff_overdue',
        'shift.no_show',
      ]);
      expect(rows.find((row) => row.kind === 'shift.handoff_overdue')?.data).toEqual({
        handoffId: handoff,
        count: 2,
      });
      expect(rows.every((row) => row.ticketId === null && row.severity === 'high')).toBe(true);
    }
    expect(await notificationsOf(agent.id)).toHaveLength(0);
  });

  it('makes nothing when nothing is overdue', async () => {
    const made = await env.tx((tx) =>
      notifyShiftAlerts(tx, env.ctx(), new Effects(), {
        noShows: [],
        unacknowledged: { items: [{ handoffId: randomUUID(), overdue: false }] },
      }),
    );
    expect(made).toBe(0);
  });
});

describe('a system notice for the heads (T-176)', () => {
  const systemCtx = () => env.ctx({ type: 'system', id: null });

  it('tells every active head, not a lead or an agent, and emits one realtime event each', async () => {
    const head = await addStaff(env, 'head');
    const lead = await addStaff(env, 'lead');
    const agent = await addStaff(env, 'agent');
    // Earlier tests may have left a notice of this kind inside the hour: this one is its own kind.
    const result = await notifyOpsAlert(env.db.owner.db, systemCtx(), {
      kind: 'ops.smtp_auth_failed',
      data: { responseCode: 535 },
    });
    expect(result.created).toBeGreaterThanOrEqual(1);
    const mine = await notificationsOf(head.id);
    expect(mine.filter((row) => row.kind === 'ops.smtp_auth_failed')).toHaveLength(1);
    expect(mine[0]?.severity).toBe('high');
    expect(await notificationsOf(lead.id)).toEqual([]);
    expect(await notificationsOf(agent.id)).toEqual([]);
    expect(result.events.some((event) => event.type === 'notification.created')).toBe(true);
  });

  it('makes at most one per kind per hour, and another kind is not held back by it', async () => {
    const head = await addStaff(env, 'head');
    const start = Date.now();
    const ctxAt = (offsetMinutes: number) =>
      env.ctx(
        { type: 'system', id: null },
        { now: () => new Date(start + offsetMinutes * 60_000) },
      );
    const first = await notifyOpsAlert(env.db.owner.db, ctxAt(0), { kind: 'ops.outbox_dead' });
    const again = await notifyOpsAlert(env.db.owner.db, ctxAt(30), { kind: 'ops.outbox_dead' });
    expect(first.created).toBeGreaterThanOrEqual(1);
    expect(again.created).toBe(0);
    expect(again.events).toEqual([]);
    const other = await notifyOpsAlert(env.db.owner.db, ctxAt(30), {
      kind: 'ops.upload_quota_global',
    });
    expect(other.created).toBeGreaterThanOrEqual(1);
    const later = await notifyOpsAlert(env.db.owner.db, ctxAt(61), { kind: 'ops.outbox_dead' });
    expect(later.created).toBeGreaterThanOrEqual(1);
    const mine = (await notificationsOf(head.id)).filter((row) => row.kind === 'ops.outbox_dead');
    expect(mine.length).toBeGreaterThanOrEqual(1);
  });

  it('two at once make one', async () => {
    await addStaff(env, 'head');
    // The first test made one of this kind just now: a clock five hours ahead starts a fresh hour.
    const far = env.ctx(
      { type: 'system', id: null },
      { now: () => new Date(Date.now() + 5 * 3600_000) },
    );
    const [a, b] = await Promise.all([
      notifyOpsAlert(env.db.owner.db, far, { kind: 'ops.smtp_auth_failed' }),
      notifyOpsAlert(env.db.owner.db, far, { kind: 'ops.smtp_auth_failed' }),
    ]);
    expect([a.created > 0, b.created > 0].filter(Boolean)).toHaveLength(1);
  });
});
