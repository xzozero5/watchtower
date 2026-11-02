import { randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import { MANUAL_CHANNELS, NO_OUTBOUND_CHANNELS } from '@watchtower/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPolicyGate } from '../autonomy/gate.js';
import { DomainError } from '../errors.js';
import {
  addOrg,
  addPolicy,
  addQueue,
  addStaff,
  auditRows,
  clockIn,
  startDomainTest,
  type DomainTestEnv,
} from '../testing/support.js';

// T-136 (a ticket filed by hand) and T-137 (the developer's part of a ticket), at the domain level.
let env: DomainTestEnv;
const FIRST_RESPONSE_MINUTES = 90;
const T0 = new Date('2030-01-07T10:00:00.000Z');
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

beforeAll(async () => {
  env = await startDomainTest();
  await addPolicy(
    env,
    {
      P3: { first_response_min: FIRST_RESPONSE_MINUTES, resolution_min: 600, calendar: '24x7' },
    },
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

async function addContact(
  orgId: string,
  fields: Partial<typeof schema.contact.$inferInsert> = {},
): Promise<typeof schema.contact.$inferSelect> {
  const [row] = await env.db.owner.db
    .insert(schema.contact)
    .values({
      orgId,
      name: `Contact ${randomUUID()}`,
      emails: [`${randomUUID()}@customer.example`],
      ...fields,
    })
    .returning();
  if (!row) throw new Error('contact insert returned no row');
  return row;
}

async function addGmailAccount(): Promise<string> {
  const [row] = await env.db.owner.db
    .insert(schema.channelAccount)
    .values({ type: 'gmail', name: 'Support mailbox' })
    .returning({ id: schema.channelAccount.id });
  if (!row) throw new Error('account insert returned no row');
  return row.id;
}

const GATE = (): ReturnType<typeof createPolicyGate> => createPolicyGate({ db: env.database.db });

const manual = async (
  input: {
    orgId: string;
    channel?: (typeof MANUAL_CHANNELS)[number];
    requesterContactId?: string;
    requester?: { email: string; name: string };
    sendConfirmation?: boolean;
  },
  now: Date = T0,
) => {
  const agent = await addStaff(env, 'agent');
  return env.tx((tx) =>
    env.domain.tickets.createManual(
      tx,
      env.ctx(agent.actor, { now: () => now, policyGate: GATE() }),
      {
        subject: 'Cannot log in',
        body: 'The customer called to say the dashboard rejects the password.',
        channel: 'phone',
        ...input,
      },
    ),
  );
};

describe('a ticket filed by hand (T-136)', () => {
  it('takes every manual channel, has no channel account, and starts the SLA now', async () => {
    const org = await addOrg(env);
    const contact = await addContact(org.id);
    for (const channel of MANUAL_CHANNELS) {
      const { value } = await manual({ orgId: org.id, requesterContactId: contact.id, channel });
      expect(value.ticket.channel).toBe(channel);
      expect(value.ticket.channelAccountId).toBeNull();
      expect(value.ticket.status).toBe('new');
      expect(value.ticket.requesterContactId).toBe(contact.id);
      expect(value.ticket.createdAt).toEqual(T0);
      expect(value.ticket.firstResponseDueAt).toEqual(at(FIRST_RESPONSE_MINUTES));
      expect(value.message.direction).toBe('inbound');
      expect(value.message.bodyText).toContain('dashboard');
    }
  });

  it('finds a new address by its contact or creates it unverified, and says which', async () => {
    const org = await addOrg(env);
    const address = `${randomUUID()}@customer.example`;
    const first = await manual({
      orgId: org.id,
      requester: { email: address.toUpperCase(), name: 'First Person' },
    });
    expect(first.value.contactCreated).toBe(true);
    expect(first.value.contact.verifiedAt).toBeNull();
    expect(first.value.contact.emails).toEqual([address]);
    const again = await manual({
      orgId: org.id,
      requester: { email: address, name: 'Someone Else' },
    });
    expect(again.value.contactCreated).toBe(false);
    expect(again.value.contact.id).toBe(first.value.contact.id);
    expect(again.value.contact.name).toBe('First Person');
  });

  it('files an internal ticket only when there is no customer, and a manual one only with a customer', async () => {
    const org = await addOrg(env);
    const contact = await addContact(org.id);
    const agent = await addStaff(env, 'agent');
    const create = (input: Record<string, unknown>) =>
      env.tx((tx) =>
        env.domain.tickets.create(tx, env.ctx(agent.actor), {
          orgId: org.id,
          subject: 's',
          body: 'b',
          ...input,
        }),
      );

    const nobody = await create({});
    expect(nobody.value.ticket.channel).toBe('internal');
    expect(nobody.value.ticket.channelAccountId).toBeNull();
    const someone = await create({ requesterContactId: contact.id });
    expect(someone.value.ticket.channel).toBe('portal');
    expect(someone.value.ticket.channelAccountId).not.toBeNull();

    expect(
      (await refusal(create({ channel: 'internal', requesterContactId: contact.id }))).code,
    ).toBe('bad_request');
    for (const channel of MANUAL_CHANNELS) {
      expect((await refusal(create({ channel }))).code).toBe('bad_request');
    }
  });

  it('sends no confirmation when there is no Gmail account, then queues it once there is one', async () => {
    const org = await addOrg(env);
    const known = await addContact(org.id);
    const before = await manual({ orgId: org.id, requesterContactId: known.id });
    expect(before.value.confirmation).toBe('no_email_account');
    // The ticket stands whatever happens to the email.
    expect(before.value.ticket.id).toBeTruthy();

    const accountId = await addGmailAccount();
    const sent = await manual({ orgId: org.id, requesterContactId: known.id });
    expect(sent.value.confirmation).toBe('queued');

    const [delivery] = await env.db.owner.db
      .select()
      .from(schema.outboundDelivery)
      .where(eq(schema.outboundDelivery.ticketId, sent.value.ticket.id));
    expect(delivery?.channel).toBe('gmail');
    expect(delivery?.channelAccountId).toBe(accountId);
    expect(delivery?.origin).toBe('system_template');
    expect(delivery?.createdBy).toBeNull();
    // The inbound first message and the automatic acknowledgment: no AI text, no person's words.
    const outbound = await env.db.owner.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.ticketId, sent.value.ticket.id));
    expect(outbound.filter((row) => row.direction === 'outbound')).toHaveLength(1);
    // The audit row names the delivery and the contact, never the address.
    const rows = (await auditRows(env, 'ticket.confirmation_queued')).filter(
      (row) => row.targetId === sent.value.ticket.id,
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain('@');
    // It is not a first response: only a person's reply counts.
    expect(sent.value.ticket.firstRespondedAt).toBeNull();
  });

  it('asks for a tick before writing to a new address, and respects a refusal for a known one', async () => {
    await addGmailAccount();
    const org = await addOrg(env);
    const stranger = { email: `${randomUUID()}@customer.example`, name: 'New Person' };
    const untouched = await manual({ orgId: org.id, requester: stranger });
    expect(untouched.value.contactCreated).toBe(true);
    expect(untouched.value.confirmation).toBe('not_requested');

    const ticked = await manual({
      orgId: org.id,
      requester: { email: `${randomUUID()}@customer.example`, name: 'Ticked Person' },
      sendConfirmation: true,
    });
    expect(ticked.value.confirmation).toBe('queued');

    const known = await addContact(org.id);
    const declined = await manual({
      orgId: org.id,
      requesterContactId: known.id,
      sendConfirmation: false,
    });
    expect(declined.value.confirmation).toBe('not_requested');
    const deliveries = await env.db.owner.db
      .select()
      .from(schema.outboundDelivery)
      .where(eq(schema.outboundDelivery.ticketId, declined.value.ticket.id));
    expect(deliveries).toHaveLength(0);
  });

  it('writes to nobody when the contact has no address, and when the gate refuses', async () => {
    await addGmailAccount();
    const org = await addOrg(env);
    const lineOnly = await addContact(org.id, { emails: [], lineUserId: `U${randomUUID()}` });
    const result = await manual({ orgId: org.id, requesterContactId: lineOnly.id });
    expect(result.value.confirmation).toBe('no_address');

    // No policy gate at all is a refusal (fail closed), and the ticket is still filed.
    const known = await addContact(org.id);
    const agent = await addStaff(env, 'agent');
    const gateless = await env.tx((tx) =>
      env.domain.tickets.createManual(
        tx,
        env.ctx(agent.actor, { now: () => T0, policyGate: undefined }),
        {
          orgId: org.id,
          subject: 's',
          body: 'b',
          channel: 'walk_in',
          requesterContactId: known.id,
        },
      ),
    );
    expect(gateless.value.confirmation).toBe('blocked_by_policy');
    expect(gateless.value.ticket.channel).toBe('walk_in');
  });

  it('refuses a public reply where nothing could be delivered, and keeps the internal note', async () => {
    const org = await addOrg(env);
    const contact = await addContact(org.id);
    const agent = await addStaff(env, 'agent');
    const portal = await env.tx((tx) =>
      env.domain.tickets.create(tx, env.ctx(agent.actor), {
        orgId: org.id,
        subject: 's',
        body: 'b',
        requesterContactId: contact.id,
      }),
    );
    for (const channel of NO_OUTBOUND_CHANNELS) {
      const ticket = await env.tx((tx) =>
        channel === 'internal'
          ? env.domain.tickets.create(tx, env.ctx(agent.actor), {
              orgId: org.id,
              subject: 's',
              body: 'b',
              channel: 'internal',
            })
          : env.domain.tickets.createManual(tx, env.ctx(agent.actor), {
              orgId: org.id,
              subject: 's',
              body: 'b',
              channel: channel as (typeof MANUAL_CHANNELS)[number],
              requesterContactId: contact.id,
              sendConfirmation: false,
            }),
      );
      const id = 'ticket' in ticket.value ? ticket.value.ticket.id : '';
      const error = await refusal(
        env.tx((tx) =>
          env.domain.tickets.reply(tx, env.ctx(agent.actor), {
            ref: id,
            reply: { body: 'We fixed it.' },
            sender: { kind: 'staff', userId: agent.id },
          }),
        ),
      );
      expect(error.code).toBe('channel_no_outbound');
      const note = await env.tx((tx) =>
        env.domain.tickets.note(tx, env.ctx(agent.actor), {
          ref: id,
          note: { body: 'Called the customer back and told them it is fixed.' },
          sender: { userId: agent.id },
        }),
      );
      expect(note.value.message.visibility).toBe('internal');
    }
    // A channel with an adapter still replies.
    const ok = await env.tx((tx) =>
      env.domain.tickets.reply(tx, env.ctx(agent.actor), {
        ref: portal.value.ticket.id,
        reply: { body: 'Hello' },
        sender: { kind: 'staff', userId: agent.id },
      }),
    );
    expect(ok.value.message.direction).toBe('outbound');
  });

  it('owes no satisfaction survey for a ticket on a manual channel', async () => {
    const org = await addOrg(env);
    const contact = await addContact(org.id);
    const agent = await addStaff(env, 'agent');
    const { value } = await manual({ orgId: org.id, requesterContactId: contact.id });
    for (const status of ['open', 'resolved'] as const) {
      await env.tx((tx) =>
        env.domain.tickets.changeStatus(tx, env.ctx(agent.actor), {
          ref: value.ticket.id,
          status,
        }),
      );
    }
    const surveys = await env.db.owner.db
      .select()
      .from(schema.csatSurvey)
      .where(eq(schema.csatSurvey.ticketId, value.ticket.id));
    expect(surveys).toHaveLength(0);
  });
});

describe('the developer part of a ticket (T-137)', () => {
  async function assignedTicket() {
    const org = await addOrg(env);
    const contact = await addContact(org.id);
    const agent = await addStaff(env, 'agent');
    const created = await env.tx((tx) =>
      env.domain.tickets.create(tx, env.ctx(agent.actor), {
        orgId: org.id,
        subject: 's',
        body: 'b',
        requesterContactId: contact.id,
        assigneeId: agent.id,
      }),
    );
    const opened = await env.tx((tx) =>
      env.domain.tickets.changeStatus(tx, env.ctx(agent.actor), {
        ref: created.value.ticket.id,
        status: 'open',
      }),
    );
    return { ticket: opened.value, agent };
  }

  const move = (
    ref: string,
    status: 'open' | 'waiting_on_dev' | 'resolved',
    actor: { type: 'user'; id: string },
    options: { reason?: string; asDev?: boolean } = {},
  ) =>
    env.tx((tx) =>
      env.domain.tickets.changeStatus(tx, env.ctx(actor), { ref, status, ...options }),
    );

  it('needs a note to hand a ticket to a developer, and saves it as an internal note', async () => {
    const { ticket, agent } = await assignedTicket();
    expect((await refusal(move(ticket.id, 'waiting_on_dev', agent.actor))).code).toBe(
      'bad_request',
    );
    const note = 'Looks like a deploy regression; needs a developer to read the logs.';
    const result = await move(ticket.id, 'waiting_on_dev', agent.actor, { reason: note });
    // The queue and the assignee do not move: the agent stays accountable (AC-7).
    expect(result.value.assigneeId).toBe(agent.id);
    expect(result.value.queueId).toBe(ticket.queueId);
    const messages = await env.db.owner.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.ticketId, ticket.id));
    const saved = messages.find((row) => row.bodyText === note);
    expect(saved?.visibility).toBe('internal');
    expect(saved?.direction).toBe('internal');
    expect(saved?.senderUserId).toBe(agent.id);
    // The customer cannot tell open from waiting_on_dev, so the move is not a public event.
    const events = await env.db.owner.db
      .select()
      .from(schema.ticketEvent)
      .where(eq(schema.ticketEvent.ticketId, ticket.id));
    const changed = events.filter(
      (row) =>
        row.type === 'ticket.status_changed' &&
        (row.payload as { to?: string }).to === 'waiting_on_dev',
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]?.visibility).toBe('internal');
  });

  it('keeps a developer to open and waiting_on_dev, with a note to hand it back', async () => {
    const { ticket, agent } = await assignedTicket();
    const dev = await addStaff(env, 'dev');
    await move(ticket.id, 'waiting_on_dev', dev.actor, { reason: 'Reproduced', asDev: true });
    expect((await refusal(move(ticket.id, 'open', dev.actor, { asDev: true }))).code).toBe(
      'bad_request',
    );
    expect(
      (await refusal(move(ticket.id, 'resolved', dev.actor, { reason: 'done', asDev: true }))).code,
    ).toBe('forbidden');
    const back = await move(ticket.id, 'open', dev.actor, { reason: 'Fixed', asDev: true });
    expect(back.value.status).toBe('open');
    // An agent is not held to the developer's two statuses.
    const resolved = await move(ticket.id, 'resolved', agent.actor);
    expect(resolved.value.status).toBe('resolved');
  });

  it('refuses to hand a ticket to a developer inside a public reply', async () => {
    const { ticket, agent } = await assignedTicket();
    const error = await refusal(
      env.tx((tx) =>
        env.domain.tickets.reply(tx, env.ctx(agent.actor), {
          ref: ticket.id,
          reply: { body: 'We are looking into it.', setStatus: 'waiting_on_dev' },
          sender: { kind: 'staff', userId: agent.id },
        }),
      ),
    );
    expect(error.code).toBe('bad_request');
  });

  it('lets a developer pick a ticket up for themselves only, and never moves the assignee', async () => {
    const { ticket, agent } = await assignedTicket();
    const dev = await addStaff(env, 'dev');
    const other = await addStaff(env, 'dev');
    const picked = await env.tx((tx) =>
      env.domain.tickets.devPickUp(tx, env.ctx(dev.actor), { ref: ticket.id }),
    );
    expect(picked.value.devOwnerId).toBe(dev.id);
    expect(picked.value.assigneeId).toBe(agent.id);
    // Picking up is not a status change and not the agent's hand-off.
    expect(picked.value.status).toBe(ticket.status);
    // Again is fine; another developer is a conflict; someone else cannot let it go.
    const again = await env.tx((tx) =>
      env.domain.tickets.devPickUp(tx, env.ctx(dev.actor), { ref: ticket.id }),
    );
    expect(again.value.devOwnerId).toBe(dev.id);
    expect(
      (
        await refusal(
          env.tx((tx) =>
            env.domain.tickets.devPickUp(tx, env.ctx(other.actor), { ref: ticket.id }),
          ),
        )
      ).code,
    ).toBe('conflict');
    expect(
      (
        await refusal(
          env.tx((tx) =>
            env.domain.tickets.devRelease(tx, env.ctx(other.actor), { ref: ticket.id }),
          ),
        )
      ).code,
    ).toBe('forbidden');
    // Not a person: nobody picks up for the system.
    expect(
      (
        await refusal(
          env.tx((tx) =>
            env.domain.tickets.devPickUp(tx, env.ctx({ type: 'system', id: null }), {
              ref: ticket.id,
            }),
          ),
        )
      ).code,
    ).toBe('forbidden');
    const released = await env.tx((tx) =>
      env.domain.tickets.devRelease(tx, env.ctx(dev.actor), { ref: ticket.id }),
    );
    expect(released.value.devOwnerId).toBeNull();
    const audits = (await auditRows(env)).filter((row) => row.targetId === ticket.id);
    expect(audits.map((row) => row.action)).toEqual(
      expect.arrayContaining(['ticket.dev_pickup', 'ticket.dev_release']),
    );
  });

  it('links an incident and a deploy that exist, once each, and unlinks them', async () => {
    const { ticket } = await assignedTicket();
    const dev = await addStaff(env, 'dev');
    const [incident] = await env.db.owner.db
      .insert(schema.incident)
      .values({ title: 'Checkout outage', severity: 'SEV2' })
      .returning({ id: schema.incident.id });
    const [deploy] = await env.db.owner.db
      .insert(schema.deploy)
      .values({
        serviceSlug: 'api',
        version: 'v1.2.3',
        env: 'prod',
        source: 'ci',
        externalId: randomUUID(),
      })
      .returning({ id: schema.deploy.id });
    if (!incident || !deploy) throw new Error('fixtures');
    const link = (kind: 'incident' | 'deploy', targetId: string) =>
      env.tx((tx) =>
        env.domain.tickets.linkAdd(tx, env.ctx(dev.actor), {
          ref: ticket.id,
          link: { kind, targetId },
        }),
      );

    const first = await link('incident', incident.id);
    expect(first.value.created).toBe(true);
    expect((await link('incident', incident.id)).value.created).toBe(false);
    await link('deploy', deploy.id);
    expect((await refusal(link('incident', randomUUID()))).code).toBe('bad_request');
    expect((await refusal(link('deploy', incident.id))).code).toBe('bad_request');
    // Linking creates nothing and changes nothing on the incident.
    const [after] = await env.db.owner.db
      .select()
      .from(schema.incident)
      .where(eq(schema.incident.id, incident.id));
    expect(after?.title).toBe('Checkout outage');
    const [unchanged] = await env.db.owner.db
      .select({ incidentId: schema.ticket.incidentId })
      .from(schema.ticket)
      .where(eq(schema.ticket.id, ticket.id));
    expect(unchanged?.incidentId).toBeNull();

    await env.tx((tx) =>
      env.domain.tickets.linkRemove(tx, env.ctx(dev.actor), {
        ref: ticket.id,
        linkId: first.value.linkId,
      }),
    );
    expect(
      (
        await refusal(
          env.tx((tx) =>
            env.domain.tickets.linkRemove(tx, env.ctx(dev.actor), {
              ref: ticket.id,
              linkId: first.value.linkId,
            }),
          ),
        )
      ).code,
    ).toBe('not_found');
    const left = await env.db.owner.db
      .select()
      .from(schema.ticketLink)
      .where(eq(schema.ticketLink.ticketId, ticket.id));
    expect(left.map((row) => row.kind)).toEqual(['deploy']);
  });
});

describe('assignment never reaches a developer (T-137)', () => {
  it('refuses a developer as assignee and skips them in a round-robin queue', async () => {
    const dev = await addStaff(env, 'dev');
    const agent = await addStaff(env, 'agent');
    const org = await addOrg(env);
    const refused = await refusal(
      env.tx((tx) =>
        env.domain.tickets.create(tx, env.ctx(agent.actor), {
          orgId: org.id,
          subject: 's',
          body: 'b',
          assigneeId: dev.id,
        }),
      ),
    );
    expect(refused.code).toBe('bad_request');

    const queue = await addQueue(env, { mode: 'round_robin', members: [dev.id, agent.id] });
    await clockIn(env, dev.id);
    await clockIn(env, agent.id);
    const contact = await addContact(org.id);
    for (let turn = 0; turn < 4; turn += 1) {
      const created = await env.tx((tx) =>
        env.domain.tickets.create(tx, env.ctx(agent.actor), {
          orgId: org.id,
          subject: 's',
          body: 'b',
          requesterContactId: contact.id,
          queueId: queue.id,
        }),
      );
      expect(created.value.ticket.assigneeId).toBe(agent.id);
    }
  });
});
