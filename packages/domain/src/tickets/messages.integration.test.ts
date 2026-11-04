import { schema } from '@watchtower/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DomainError } from '../errors.js';
import type { PolicyGate } from '../policy.js';
import {
  addOrg,
  addPolicy,
  addStaff,
  auditRows,
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
    { P3: { first_response_min: 60, resolution_min: 240, calendar: '24x7' } },
    'standard',
  );
});
afterAll(async () => {
  await env.close();
});

const T0 = new Date('2030-01-07T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

async function ticketWithRequester() {
  const org = await addOrg(env);
  const { value } = await env.tx((tx) =>
    env.domain.tickets.create(tx, env.ctx(undefined, { now: () => T0 }), {
      orgId: org.id,
      subject: 'a',
      body: 'b',
      requester: { email: `${crypto.randomUUID()}@example.test`, name: 'Requester' },
    }),
  );
  return { org, ticket: value.ticket, contactId: value.ticket.requesterContactId ?? '' };
}

async function setStatus(id: string, patch: Partial<typeof schema.ticket.$inferInsert>) {
  await env.db.owner.db.update(schema.ticket).set(patch).where(eq(schema.ticket.id, id));
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

describe('tickets.reply by staff', () => {
  it('is the first response, written as outbound, with one audit row and the notice to the customer', async () => {
    const { ticket } = await ticketWithRequester();
    const staff = await addStaff(env);
    const notifier = recordingNotifier();
    const result = await env.tx((tx) =>
      env.domain.tickets.reply(
        tx,
        env.ctx(staff.actor, { now: () => new Date(T0.getTime() + 5 * 60_000), notifier }),
        {
          ref: ticket.id,
          reply: { body: 'We are looking' },
          sender: { kind: 'staff', userId: staff.id },
        },
      ),
    );
    expect(result.value.message).toMatchObject({
      direction: 'outbound',
      visibility: 'public',
      deliveryStatus: 'delivered',
    });
    expect(result.value.ticket.firstRespondedAt).toEqual(new Date(T0.getTime() + 5 * 60_000));
    expect(result.events.map((event) => event.type)).toEqual(['message.created', 'ticket.updated']);
    expect(result.audited).toBe(true);
    expect(notifier.calls).toEqual([`staffReply:OPS-${String(ticket.number)}:new`]);
    const replies = (await auditRows(env, 'ticket.reply')).filter(
      (row) => row.targetId === ticket.id,
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]?.metadata).toMatchObject({ firstResponse: true });
  });

  it('sets the status in the same request, sends one notice, and fails whole on a bad transition', async () => {
    const { ticket } = await ticketWithRequester();
    const staff = await addStaff(env);
    const notifier = recordingNotifier();
    const ok = await env.tx((tx) =>
      env.domain.tickets.reply(tx, env.ctx(staff.actor, { notifier }), {
        ref: ticket.id,
        reply: { body: 'Done', setStatus: 'resolved' },
        sender: { kind: 'staff', userId: staff.id },
      }),
    );
    expect(ok.value.ticket.status).toBe('resolved');
    // The status change is silent (the reply carries it), so only the reply notice goes.
    expect(notifier.calls).toEqual([`staffReply:OPS-${String(ticket.number)}:resolved`]);

    const { ticket: other } = await ticketWithRequester();
    const error = await refusal(
      env.tx((tx) =>
        env.domain.tickets.reply(tx, env.ctx(staff.actor), {
          ref: other.id,
          reply: { body: 'x', setStatus: 'merged' },
          sender: { kind: 'staff', userId: staff.id },
        }),
      ),
    );
    expect(error.code).toBe('invalid_transition');
    const messages = await env.db.owner.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.ticketId, other.id));
    expect(messages).toHaveLength(1);
  });

  it('refuses a merged or closed ticket', async () => {
    const { ticket } = await ticketWithRequester();
    const staff = await addStaff(env);
    const reply = () =>
      env.tx((tx) =>
        env.domain.tickets.reply(tx, env.ctx(staff.actor), {
          ref: ticket.id,
          reply: { body: 'x' },
          sender: { kind: 'staff', userId: staff.id },
        }),
      );
    await setStatus(ticket.id, { status: 'closed' });
    expect((await refusal(reply())).code).toBe('ticket_not_open');
    await markMerged(env, ticket.id);
    expect((await refusal(reply())).code).toBe('ticket_not_open');
  });
});

describe('tickets.reply by the customer (append a message)', () => {
  const portalSender = (orgId: string, contactId: string) =>
    ({ kind: 'contact', contactId, orgId }) as const;

  it('restarts a ticket that waits on the customer, as inbound, with no notice back', async () => {
    const { org, ticket, contactId } = await ticketWithRequester();
    await setStatus(ticket.id, { status: 'waiting_on_customer', slaPausedAt: T0 });
    const notifier = recordingNotifier();
    const result = await env.tx((tx) =>
      env.domain.tickets.reply(
        tx,
        env.ctx(
          { type: 'anonymous', id: contactId },
          { now: () => new Date(T0.getTime() + 20 * 60_000), notifier },
        ),
        { ref: ticket.id, reply: { body: 'Here it is' }, sender: portalSender(org.id, contactId) },
      ),
    );
    expect(result.value.message).toMatchObject({
      direction: 'inbound',
      deliveryStatus: 'not_applicable',
      senderContactId: contactId,
    });
    expect(result.value.ticket).toMatchObject({ status: 'open', slaPausedAt: null });
    expect(notifier.calls).toEqual([]);
    // The reply and the automatic status change are two audit rows in one transaction.
    const audits = await auditRows(env);
    expect(
      audits
        .filter((row) => row.targetId === ticket.id)
        .map((row) => row.action)
        .toSorted(),
    ).toEqual(['ticket.create', 'ticket.reply', 'ticket.status_change']);
  });

  it('reopens a ticket resolved inside the window and refuses one resolved before it', async () => {
    const { org, ticket, contactId } = await ticketWithRequester();
    const resolvedAt = T0;
    await setStatus(ticket.id, { status: 'resolved', resolvedAt });
    const answer = (at: Date) =>
      env.tx((tx) =>
        env.domain.tickets.reply(
          tx,
          env.ctx({ type: 'anonymous', id: contactId }, { now: () => at }),
          {
            ref: ticket.id,
            reply: { body: 'Still broken' },
            sender: portalSender(org.id, contactId),
          },
        ),
      );

    const late = await refusal(answer(new Date(resolvedAt.getTime() + 8 * DAY)));
    expect(late.code).toBe('ticket_not_open');
    expect(late.message).toContain('7 days');

    const reopened = await answer(new Date(resolvedAt.getTime() + 6 * DAY));
    expect(reopened.value.ticket).toMatchObject({
      status: 'open',
      reopenCount: 1,
      resolvedAt: null,
    });
  });

  it('is not found for another organization or for another requester', async () => {
    const { org, ticket, contactId } = await ticketWithRequester();
    const stranger = await addOrg(env);
    const send = (sender: Parameters<typeof env.domain.tickets.reply>[2]['sender']) =>
      env.tx((tx) =>
        env.domain.tickets.reply(tx, env.ctx(), { ref: ticket.id, reply: { body: 'x' }, sender }),
      );
    expect((await refusal(send(portalSender(stranger.id, contactId)))).code).toBe('not_found');
    expect(
      (await refusal(send(portalSender(org.id, '00000000-0000-4000-8000-000000000000')))).code,
    ).toBe('not_found');
  });

  it('a signed-in client user is found or added as a contact of the organization', async () => {
    const { org, ticket } = await ticketWithRequester();
    const [user] = await env.db.owner.db
      .insert(schema.users)
      .values({
        email: 'client.user@example.test',
        name: 'Client User',
        role: 'client',
        orgId: org.id,
      })
      .returning({ id: schema.users.id });
    const sender = {
      kind: 'client',
      userId: user?.id ?? '',
      orgId: org.id,
      email: 'Client.User@example.test',
      name: 'Client User',
    } as const;
    const send = () =>
      env.tx((tx) =>
        env.domain.tickets.reply(tx, env.ctx({ type: 'user', id: user?.id ?? null }), {
          ref: ticket.id,
          reply: { body: 'from a user' },
          sender,
        }),
      );
    const first = await send();
    const second = await send();
    expect(first.value.message).toMatchObject({ direction: 'inbound', senderUserId: user?.id });
    expect(first.value.message.senderContactId).not.toBeNull();
    expect(second.value.message.senderContactId).toBe(first.value.message.senderContactId);
    const contacts = (await env.db.owner.db.select().from(schema.contact)).filter((row) =>
      row.emails.includes('client.user@example.test'),
    );
    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.orgId).toBe(org.id);
  });

  it('answers "no such ticket" to a client or contact writing on an internal ticket, and writes nothing (T-125a)', async () => {
    const { org, ticket, contactId } = await ticketWithRequester();
    await setStatus(ticket.id, { channel: 'internal' });
    const before = await env.db.owner.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.ticketId, ticket.id));
    const asContact = await refusal(
      env.tx((tx) =>
        env.domain.tickets.reply(tx, env.ctx({ type: 'anonymous', id: contactId }), {
          ref: ticket.id,
          reply: { body: 'hello?' },
          sender: portalSender(org.id, contactId),
        }),
      ),
    );
    expect(asContact.code).toBe('not_found');
    const asClient = await refusal(
      env.tx((tx) =>
        env.domain.tickets.reply(tx, env.ctx({ type: 'user', id: null }), {
          ref: ticket.id,
          reply: { body: 'hello?' },
          sender: {
            kind: 'client',
            userId: crypto.randomUUID(),
            orgId: org.id,
            email: 'someone@example.test',
            name: 'Someone',
          },
        }),
      ),
    );
    expect(asClient.code).toBe('not_found');
    const after = await env.db.owner.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.ticketId, ticket.id));
    expect(after).toHaveLength(before.length);
  });
});

describe('tickets.reply written by the AI (policy gate)', () => {
  const aiActor = { type: 'ai', id: null } as const;

  it('is refused when no gate is configured, and nothing is written', async () => {
    const { ticket } = await ticketWithRequester();
    const staff = await addStaff(env);
    const error = await refusal(
      env.tx((tx) =>
        env.domain.tickets.reply(tx, env.ctx(aiActor), {
          ref: ticket.id,
          reply: { body: 'automatic answer' },
          sender: { kind: 'staff', userId: staff.id },
        }),
      ),
    );
    expect(error.code).toBe('policy_denied');
    expect(error.details).toMatchObject({ reason: 'no_policy_gate' });
    const messages = await env.db.owner.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.ticketId, ticket.id));
    expect(messages).toHaveLength(1);
  });

  it('asks the gate and obeys its answer', async () => {
    const { ticket } = await ticketWithRequester();
    const staff = await addStaff(env);
    const asked: string[] = [];
    const gate = (allowed: boolean): PolicyGate => ({
      check: (request) => {
        asked.push(request.ticketId);
        return Promise.resolve(
          allowed ? { allowed, reason: 'test_allow' } : { allowed, reason: 'stage_below_3' },
        );
      },
      checkAiAction: () => Promise.resolve({ allowed, reason: 'test' }),
    });
    const reply = (policyGate: PolicyGate) =>
      env.tx((tx) =>
        env.domain.tickets.reply(tx, env.ctx(aiActor, { policyGate }), {
          ref: ticket.id,
          reply: { body: 'automatic answer' },
          sender: { kind: 'staff', userId: staff.id },
        }),
      );

    const denied = await refusal(reply(gate(false)));
    expect(denied).toMatchObject({ code: 'policy_denied', details: { reason: 'stage_below_3' } });
    expect((await reply(gate(true))).value.message.direction).toBe('outbound');
    expect(asked).toEqual([ticket.id, ticket.id]);
  });

  it('does not ask for a human reply', async () => {
    const { ticket } = await ticketWithRequester();
    const staff = await addStaff(env);
    const result = await env.tx((tx) =>
      env.domain.tickets.reply(tx, env.ctx(staff.actor), {
        ref: ticket.id,
        reply: { body: 'a person wrote this' },
        sender: { kind: 'staff', userId: staff.id },
      }),
    );
    expect(result.value.message.direction).toBe('outbound');
  });
});

describe('tickets.note', () => {
  it('is internal, never sent, audited, and refused on a merged ticket', async () => {
    const { ticket } = await ticketWithRequester();
    const staff = await addStaff(env);
    const notifier = recordingNotifier();
    const result = await env.tx((tx) =>
      env.domain.tickets.note(tx, env.ctx(staff.actor, { notifier }), {
        ref: ticket.id,
        note: { body: 'Customer is on a VPN' },
        sender: { userId: staff.id },
      }),
    );
    expect(result.value.message).toMatchObject({
      direction: 'internal',
      visibility: 'internal',
      deliveryStatus: 'not_applicable',
    });
    expect(result.value.ticket.firstRespondedAt).toBeNull();
    expect(result.events.map((event) => event.type)).toEqual(['message.created']);
    expect(result.events[0]?.data).toMatchObject({ visibility: 'internal' });
    expect(notifier.calls).toEqual([]);
    expect(
      (await auditRows(env, 'ticket.note')).filter((row) => row.targetId === ticket.id),
    ).toHaveLength(1);

    await markMerged(env, ticket.id);
    const error = await refusal(
      env.tx((tx) =>
        env.domain.tickets.note(tx, env.ctx(staff.actor), {
          ref: ticket.id,
          note: { body: 'x' },
          sender: { userId: staff.id },
        }),
      ),
    );
    expect(error.code).toBe('ticket_not_open');
  });
});

describe('the timeline clock', () => {
  // Messages and events are ordered together on screen. This process' clock (T0 is years away from
  // the database's) must not reorder them: tens of milliseconds did, between a host and Docker.
  it('stamps a message with the database clock, between the events around it', async () => {
    const { ticket } = await ticketWithRequester();
    await env.tx((tx) =>
      env.domain.tickets.changeStatus(tx, env.ctx(undefined, { now: () => T0 }), {
        ref: ticket.id,
        status: 'triage',
        reason: 'testing',
      }),
    );
    const staff = await addStaff(env);
    await env.tx((tx) =>
      env.domain.tickets.note(tx, env.ctx(staff.actor, { now: () => T0 }), {
        ref: ticket.id,
        note: { body: 'a note' },
        sender: { userId: staff.id },
      }),
    );

    const messages = await env.db.owner.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.ticketId, ticket.id));
    const events = await env.db.owner.db
      .select()
      .from(schema.ticketEvent)
      .where(eq(schema.ticketEvent.ticketId, ticket.id));
    const customer = messages.find((row) => row.direction === 'inbound');
    const note = messages.find((row) => row.direction === 'internal');
    const created = events.find((row) => row.type === 'ticket.created');
    const moved = events.find((row) => row.type === 'ticket.status_changed');

    expect(created?.createdAt.getTime()).toBeLessThanOrEqual(customer?.createdAt.getTime() ?? 0);
    expect(customer?.createdAt.getTime()).toBeLessThanOrEqual(moved?.createdAt.getTime() ?? 0);
    expect(moved?.createdAt.getTime()).toBeLessThanOrEqual(note?.createdAt.getTime() ?? 0);
  });
});
