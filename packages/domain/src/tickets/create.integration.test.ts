import { schema } from '@watchtower/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DomainError } from '../errors.js';
import {
  addIntent,
  addOrg,
  addPolicy,
  addQueue,
  addStaff,
  auditRows,
  clockIn,
  eventTypes,
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

const refusal = async (work: Promise<unknown>): Promise<DomainError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

describe('tickets.create, staff path', () => {
  it('writes the ticket, first message, event log and one audit row, and returns the events', async () => {
    const org = await addOrg(env);
    const staff = await addStaff(env);
    const result = await env.tx((tx) =>
      env.domain.tickets.create(tx, env.ctx(staff.actor), {
        orgId: org.id,
        subject: 'Cannot sign in',
        body: 'Password rejected',
        requester: { email: 'Someone@Example.test', name: 'Someone' },
      }),
    );

    const { ticket, message, duplicate } = result.value;
    expect(duplicate).toBe(false);
    expect(ticket).toMatchObject({
      status: 'new',
      priority: 'P3',
      channel: 'portal',
      orgId: org.id,
    });
    expect(ticket.slaPolicyId).not.toBeNull();
    expect(ticket.firstResponseDueAt).toBeInstanceOf(Date);
    expect(message).toMatchObject({ direction: 'inbound', deliveryStatus: 'not_applicable' });

    expect(result.audited).toBe(true);
    expect(result.events.map((event) => event.type)).toEqual(['ticket.created', 'message.created']);
    expect(result.events[0]?.ticketKey).toBe(`OPS-${String(ticket.number)}`);
    expect(await eventTypes(env, ticket.id)).toContain('ticket.created');

    const creates = (await auditRows(env, 'ticket.create')).filter(
      (row) => row.targetId === ticket.id,
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      actorType: 'user',
      actorId: staff.id,
      ip: '203.0.113.7',
      requestId: 'req-test',
      outcome: 'success',
    });
  });

  it('finds the requester by address once and audits creating the contact', async () => {
    const org = await addOrg(env);
    const input = {
      orgId: org.id,
      subject: 'a',
      body: 'b',
      requester: { email: 'repeat@example.test', name: 'Repeat' },
    };
    const first = await env.tx((tx) => env.domain.tickets.create(tx, env.ctx(), input));
    const second = await env.tx((tx) => env.domain.tickets.create(tx, env.ctx(), input));
    expect(second.value.ticket.requesterContactId).toBe(first.value.ticket.requesterContactId);
    const contactAudits = (await auditRows(env, 'contact.create')).filter(
      (row) => row.targetId === first.value.ticket.requesterContactId,
    );
    expect(contactAudits).toHaveLength(1);
    // The audit log carries counts, never the address.
    expect(JSON.stringify(contactAudits[0])).not.toContain('repeat@example.test');
  });

  it('takes the priority and the SLA policy from the intent and the organization', async () => {
    const org = await addOrg(env);
    const intent = await addIntent(env, { defaultPriority: 'P2' });
    const { value } = await env.tx((tx) =>
      env.domain.tickets.create(tx, env.ctx(), {
        orgId: org.id,
        subject: 'a',
        body: 'b',
        intentKey: intent.key,
      }),
    );
    expect(value.ticket.priority).toBe('P2');
    expect(value.ticket.intentId).toBe(intent.id);
    expect(value.ticket.autonomyStageAtCreation).toBe(2);
  });

  it('refuses an unknown organization, an inactive one and an unknown intent', async () => {
    const inactive = await addOrg(env, { status: 'inactive' });
    const active = await addOrg(env);
    const open = (orgId: string, extra: Record<string, string> = {}) =>
      env.tx((tx) =>
        env.domain.tickets.create(tx, env.ctx(), { orgId, subject: 'a', body: 'b', ...extra }),
      );

    expect((await refusal(open('00000000-0000-4000-8000-000000000000'))).code).toBe('bad_request');
    expect((await refusal(open(inactive.id))).code).toBe('conflict');
    expect((await refusal(open(active.id, { intentKey: 'no-such-intent' }))).code).toBe(
      'bad_request',
    );
  });

  it('rolls the audit row back with the ticket when the transaction fails', async () => {
    const org = await addOrg(env);
    const before = (await auditRows(env, 'ticket.create')).length;
    await expect(
      env.tx(async (tx) => {
        await env.domain.tickets.create(tx, env.ctx(), { orgId: org.id, subject: 'a', body: 'b' });
        throw new Error('the caller failed after the domain succeeded');
      }),
    ).rejects.toThrow('the caller failed');
    expect((await auditRows(env, 'ticket.create')).length).toBe(before);
  });
});

describe('tickets.create, portal path', () => {
  it('is idempotent on the submission id: the second call writes nothing', async () => {
    const org = await addOrg(env);
    const anonymous = { type: 'anonymous', id: null } as const;
    const input = {
      orgId: org.id,
      subject: 'From the form',
      body: 'Please help',
      channel: 'portal',
      externalId: 'portal:challenge-1',
      requester: { email: 'form@example.test', name: 'Form' },
    } as const;

    const first = await env.tx((tx) => env.domain.tickets.create(tx, env.ctx(anonymous), input));
    const again = await env.tx((tx) => env.domain.tickets.create(tx, env.ctx(anonymous), input));

    expect(first.value.duplicate).toBe(false);
    expect(again.value.duplicate).toBe(true);
    expect(again.value.ticket.id).toBe(first.value.ticket.id);
    expect(again.events).toEqual([]);
    expect(again.audited).toBe(false);
    const tickets = await env.db.owner.db.select().from(schema.ticket);
    expect(tickets.filter((row) => row.orgId === org.id)).toHaveLength(1);
    expect(first.audited).toBe(true);
    expect(
      (await auditRows(env, 'ticket.create')).find((row) => row.targetId === first.value.ticket.id),
    ).toMatchObject({ actorType: 'anonymous', actorId: null });
  });

  it('handles two identical submissions at once', async () => {
    const org = await addOrg(env);
    const anonymous = { type: 'anonymous', id: null } as const;
    const input = {
      orgId: org.id,
      subject: 'Race',
      body: 'b',
      externalId: 'portal:challenge-race',
      requester: { email: 'race@example.test', name: 'Race' },
    };
    const results = await Promise.all([
      env.tx((tx) => env.domain.tickets.create(tx, env.ctx(anonymous), input)),
      env.tx((tx) => env.domain.tickets.create(tx, env.ctx(anonymous), input)),
    ]);
    expect(results.map((result) => result.value.duplicate).toSorted()).toEqual([false, true]);
    expect(results[0].value.ticket.id).toBe(results[1].value.ticket.id);
  });
});

describe('tickets.create, assignment', () => {
  it('hands tickets of a round-robin queue to its members in turn', async () => {
    const a = await addStaff(env);
    const b = await addStaff(env);
    const queue = await addQueue(env, { mode: 'round_robin', members: [a.id, b.id] });
    await clockIn(env, a.id);
    await clockIn(env, b.id);
    const org = await addOrg(env);
    const assignees: (string | null)[] = [];
    for (let i = 0; i < 4; i += 1) {
      const { value } = await env.tx((tx) =>
        env.domain.tickets.create(tx, env.ctx(), {
          orgId: org.id,
          subject: `t${String(i)}`,
          body: 'b',
          queueId: queue.id,
        }),
      );
      assignees.push(value.ticket.assigneeId);
    }
    const [first, second] = [a.id, b.id].toSorted();
    expect(assignees).toEqual([first, second, first, second]);
  });

  it('assigns the named person, who must be active staff', async () => {
    const staff = await addStaff(env);
    const org = await addOrg(env);
    const ok = await env.tx((tx) =>
      env.domain.tickets.create(tx, env.ctx(), {
        orgId: org.id,
        subject: 'a',
        body: 'b',
        assigneeId: staff.id,
      }),
    );
    expect(ok.value.ticket.assigneeId).toBe(staff.id);
    expect(await eventTypes(env, ok.value.ticket.id)).toContain('ticket.assigned');

    const error = await refusal(
      env.tx((tx) =>
        env.domain.tickets.create(tx, env.ctx(), {
          orgId: org.id,
          subject: 'a',
          body: 'b',
          assigneeId: '00000000-0000-4000-8000-000000000000',
        }),
      ),
    );
    expect(error.code).toBe('bad_request');
  });
});
