import { randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import { INCIDENTS_AUDIT_ACTIONS } from '@watchtower/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPolicyGate } from '../autonomy/gate.js';
import { DomainError } from '../errors.js';
import { addOrg, addPolicy, addStaff, auditRows, startDomainTest } from '../testing/support.js';
import type { DomainTestEnv } from '../testing/support.js';
import type { Actor, DomainContext } from '../types.js';

// R-3.14 and N3 against a real Postgres: anyone may draft an update, only a person sends it, the person
// confirms how many customers it reaches, and it goes through the normal reply path one ticket at a time.

let env: DomainTestEnv;
let gmailId: string;
let lineId: string;
const AI: Actor = { type: 'ai', id: 'ai-run-1' };
const SYSTEM: Actor = { type: 'system', id: null };
const owner = () => env.db.owner.db;

beforeAll(async () => {
  env = await startDomainTest();
  await addPolicy(
    env,
    { P3: { first_response_min: 60, resolution_min: 240, calendar: '24x7' } },
    'standard',
  );
  const accounts = await owner()
    .insert(schema.channelAccount)
    .values([
      { type: 'gmail', name: 'Support mailbox' },
      { type: 'line', name: 'Support LINE OA' },
    ])
    .returning();
  gmailId = accounts.find((account) => account.type === 'gmail')?.id ?? '';
  lineId = accounts.find((account) => account.type === 'line')?.id ?? '';
});
afterAll(async () => {
  await env.close();
});

const ctxOf = (actor: Actor): DomainContext =>
  env.ctx(actor, { policyGate: createPolicyGate({ db: env.database.db }) });

async function openIncident() {
  const person = await addStaff(env, 'lead');
  const { value } = await env.tx((tx) =>
    env.domain.incidents.create(tx, ctxOf(person.actor), {
      title: 'Checkout errors',
      severity: 'SEV2',
      serviceIds: [],
      alertIds: [],
      ticketIds: [],
      orgIds: [],
    }),
  );
  return { incidentId: value.incidentId, person };
}

type Kind = 'portal' | 'gmail' | 'line' | 'internal' | 'closed' | 'gmail-without-account';

async function linkedTicket(incidentId: string, kind: Kind): Promise<string> {
  const org = await addOrg(env);
  const { value } = await env.tx((tx) =>
    env.domain.tickets.create(tx, ctxOf({ type: 'user', id: null }), {
      orgId: org.id,
      subject: 'Checkout is failing',
      body: 'We cannot pay.',
      requester: { email: `${randomUUID()}@customer.example.test`, name: 'Requester' },
    }),
  );
  const id = value.ticket.id;
  const channel = kind === 'closed' ? 'portal' : kind === 'gmail-without-account' ? 'gmail' : kind;
  const accountId = kind === 'gmail' ? gmailId : kind === 'line' ? lineId : null;
  await owner()
    .update(schema.ticket)
    .set({
      incidentId,
      channel,
      ...(accountId === null ? {} : { channelAccountId: accountId }),
      ...(kind === 'closed' ? { status: 'closed', closedAt: new Date() } : {}),
    })
    .where(eq(schema.ticket.id, id));
  return id;
}

const draft = async (
  incidentId: string,
  actor: Actor,
  body = 'We are fixing it and will update you.',
) =>
  (await env.tx((tx) => env.domain.incidents.draftComm(tx, ctxOf(actor), { incidentId, body })))
    .value.commId;

const send = (incidentId: string, commId: string, actor: Actor, confirmRecipients: number) =>
  env.domain.incidents.sendComm(env.database.db, ctxOf(actor), {
    incidentId,
    commId,
    confirmRecipients,
  });

const commRow = async (commId: string) =>
  (await owner().select().from(schema.incidentComm).where(eq(schema.incidentComm.id, commId)))[0];

const messagesOf = (ticketId: string) =>
  owner()
    .select()
    .from(schema.message)
    .where(and(eq(schema.message.ticketId, ticketId), eq(schema.message.direction, 'outbound')));

const refusal = async (work: Promise<unknown>): Promise<DomainError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

describe('drafting', () => {
  it('a person or the AI may draft; the system may not; a draft goes nowhere', async () => {
    const { incidentId, person } = await openIncident();
    const ticketId = await linkedTicket(incidentId, 'portal');
    const human = await draft(incidentId, person.actor);
    const ai = await draft(incidentId, AI, 'Draft by the AI');
    expect(await commRow(human)).toMatchObject({
      origin: 'human',
      status: 'draft',
      draftedBy: person.id,
    });
    expect(await commRow(ai)).toMatchObject({
      origin: 'ai',
      status: 'draft',
      draftedBy: null,
      sentBy: null,
    });
    expect((await refusal(draft(incidentId, SYSTEM))).code).toBe('policy_denied');
    expect(await messagesOf(ticketId)).toHaveLength(0);
    expect(
      (await auditRows(env, INCIDENTS_AUDIT_ACTIONS.incidentCommDraft)).filter(
        (row) => row.targetId === incidentId,
      ),
    ).toHaveLength(2);
  });

  it('shows who would be told: open tickets on customer channels, and why the others are left out', async () => {
    const { incidentId } = await openIncident();
    for (const kind of ['portal', 'portal', 'gmail', 'line', 'internal', 'closed'] as const) {
      await linkedTicket(incidentId, kind);
    }
    expect(await env.domain.incidents.previewComm(env.database.db, incidentId)).toEqual({
      recipients: 4,
      skippedChannel: 1,
      skippedClosed: 1,
    });
  });
});

describe('sending (N3)', () => {
  it('the AI and the system cannot send, whoever drafted it, and nothing is sent', async () => {
    const { incidentId, person } = await openIncident();
    const ticketId = await linkedTicket(incidentId, 'portal');
    const commId = await draft(incidentId, AI);
    for (const actor of [AI, SYSTEM]) {
      const error = await refusal(send(incidentId, commId, actor, 1));
      expect(error).toMatchObject({ code: 'policy_denied', details: { reason: 'human_required' } });
    }
    expect(await messagesOf(ticketId)).toHaveLength(0);
    expect((await commRow(commId))?.status).toBe('draft');

    // A person sends the AI's draft: allowed, and it is the person who is on the record.
    const result = await send(incidentId, commId, person.actor, 1);
    expect(result).toMatchObject({ recipients: 1, sent: 1, failed: 0 });
    expect(await commRow(commId)).toMatchObject({
      origin: 'ai',
      status: 'sent',
      sentBy: person.id,
      confirmedRecipients: 1,
    });
  });

  it('the database itself refuses a comm that is sending without the person and the count', async () => {
    const { incidentId } = await openIncident();
    const commId = await draft(incidentId, AI);
    await expect(
      owner()
        .update(schema.incidentComm)
        .set({ status: 'sending' })
        .where(eq(schema.incidentComm.id, commId)),
    ).rejects.toThrow();
    await expect(
      owner()
        .update(schema.incidentComm)
        .set({ status: 'sent', sentAt: new Date() })
        .where(eq(schema.incidentComm.id, commId)),
    ).rejects.toThrow();
  });

  it('refuses when the audience is not the count the person confirmed, and sends nothing', async () => {
    const { incidentId, person } = await openIncident();
    const first = await linkedTicket(incidentId, 'portal');
    await linkedTicket(incidentId, 'portal');
    const commId = await draft(incidentId, person.actor);
    const wrong = await refusal(send(incidentId, commId, person.actor, 5));
    expect(wrong).toMatchObject({
      code: 'conflict',
      details: { reason: 'recipient_count_mismatch', actual: 2 },
    });
    expect(await messagesOf(first)).toHaveLength(0);
    // A ticket linked after the person looked changes the audience: they must look again.
    await linkedTicket(incidentId, 'portal');
    expect((await refusal(send(incidentId, commId, person.actor, 2))).details).toMatchObject({
      actual: 3,
    });
    expect((await commRow(commId))?.status).toBe('draft');
    expect(await send(incidentId, commId, person.actor, 3)).toMatchObject({
      recipients: 3,
      sent: 3,
    });
  });

  it('tells each ticket once, through the reply path: Gmail and LINE are scheduled with the dispatcher', async () => {
    const { incidentId, person } = await openIncident();
    const portal = await linkedTicket(incidentId, 'portal');
    const gmail = await linkedTicket(incidentId, 'gmail');
    const line = await linkedTicket(incidentId, 'line');
    await linkedTicket(incidentId, 'internal');
    const commId = await draft(
      incidentId,
      person.actor,
      'The checkout is back; sorry for the trouble.',
    );

    const result = await send(incidentId, commId, person.actor, 3);
    expect(result).toMatchObject({ recipients: 3, sent: 3, failed: 0 });

    for (const ticketId of [portal, gmail, line]) {
      const sent = await messagesOf(ticketId);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        bodyText: 'The checkout is back; sorry for the trouble.',
        visibility: 'public',
        senderUserId: person.id,
      });
    }
    // Gmail and LINE wait in the dispatcher's queue with its undo window; the portal shows at once.
    const gmailMessage = (await messagesOf(gmail))[0];
    const deliveries = await owner()
      .select()
      .from(schema.outboundDelivery)
      .where(eq(schema.outboundDelivery.messageId, gmailMessage?.id ?? ''));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ state: 'scheduled', origin: 'human', channel: 'gmail' });
    expect((await messagesOf(portal))[0]?.deliveryStatus).not.toBe('scheduled');

    const deliveryRows = await owner()
      .select()
      .from(schema.incidentCommDelivery)
      .where(eq(schema.incidentCommDelivery.commId, commId));
    expect(deliveryRows.map((row) => row.state)).toEqual(['sent', 'sent', 'sent']);
    expect(deliveryRows.every((row) => row.messageId !== null)).toBe(true);

    const row = await commRow(commId);
    expect(row).toMatchObject({ status: 'sent', sentBy: person.id, confirmedRecipients: 3 });
    expect(row?.sentAt).not.toBeNull();
    const timeline = await owner()
      .select()
      .from(schema.incidentTimeline)
      .where(eq(schema.incidentTimeline.incidentId, incidentId));
    expect(timeline.find((entry) => entry.type === 'comms_sent')?.payload).toMatchObject({
      recipients: 3,
      sent: 3,
      failed: 0,
    });
    expect(
      (await auditRows(env, INCIDENTS_AUDIT_ACTIONS.incidentCommSend)).filter(
        (entry) => entry.targetId === incidentId,
      ),
    ).toHaveLength(1);
    // Sent is final.
    expect((await refusal(send(incidentId, commId, person.actor, 3))).code).toBe('conflict');
  });

  it('a ticket that cannot be answered is recorded failed with a code and the others still get it', async () => {
    const { incidentId, person } = await openIncident();
    const fine = await linkedTicket(incidentId, 'portal');
    const broken = await linkedTicket(incidentId, 'gmail-without-account');
    const commId = await draft(incidentId, person.actor);
    const result = await send(incidentId, commId, person.actor, 2);
    expect(result).toMatchObject({ recipients: 2, sent: 1, failed: 1 });
    expect(await messagesOf(fine)).toHaveLength(1);
    expect(await messagesOf(broken)).toHaveLength(0);
    const failed = await owner()
      .select()
      .from(schema.incidentCommDelivery)
      .where(
        and(
          eq(schema.incidentCommDelivery.commId, commId),
          eq(schema.incidentCommDelivery.state, 'failed'),
        ),
      );
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ ticketId: broken, messageId: null });
    expect(failed[0]?.reason).toBeTruthy();
  });

  it('a send that stopped half way is finished by sending again, without telling anyone twice', async () => {
    const { incidentId, person } = await openIncident();
    const done = await linkedTicket(incidentId, 'portal');
    const waiting = await linkedTicket(incidentId, 'portal');
    const commId = await draft(incidentId, person.actor);
    // The state a crash leaves: the person confirmed 2, one ticket was told, the comm is still sending.
    await owner()
      .update(schema.incidentComm)
      .set({
        status: 'sending',
        sentBy: person.id,
        confirmedRecipients: 2,
        recipientTicketIds: [done, waiting],
      })
      .where(eq(schema.incidentComm.id, commId));
    await env.tx((tx) =>
      env.domain.tickets.reply(tx, ctxOf(person.actor), {
        ref: done,
        reply: { body: 'We are fixing it and will update you.' },
        sender: { kind: 'staff', userId: person.id },
      }),
    );
    await owner()
      .insert(schema.incidentCommDelivery)
      .values({ commId, ticketId: done, state: 'sent' });

    const result = await send(incidentId, commId, person.actor, 2);
    expect(result.recipients).toBe(2);
    expect(await messagesOf(done)).toHaveLength(1);
    expect(await messagesOf(waiting)).toHaveLength(1);
    expect((await commRow(commId))?.status).toBe('sent');
  });

  it('keeps the audience that was confirmed: a ticket linked after it gets nothing when the send is resumed (review)', async () => {
    const { incidentId, person } = await openIncident();
    const confirmed = await linkedTicket(incidentId, 'portal');
    const commId = await draft(incidentId, person.actor);
    // The person confirmed 1; the first attempt stops before telling anyone (the process dies).
    await owner()
      .update(schema.incidentComm)
      .set({
        status: 'sending',
        sentBy: person.id,
        confirmedRecipients: 1,
        recipientTicketIds: [confirmed],
      })
      .where(eq(schema.incidentComm.id, commId));
    // Meanwhile somebody links another ticket to the incident.
    const late = await linkedTicket(incidentId, 'portal');

    // Resuming with a count that is not the confirmed one is refused ...
    expect((await refusal(send(incidentId, commId, person.actor, 2))).details).toMatchObject({
      reason: 'recipient_count_mismatch',
      actual: 1,
    });
    expect(await messagesOf(late)).toHaveLength(0);
    // ... and resuming with the confirmed count tells exactly the confirmed ticket.
    const result = await send(incidentId, commId, person.actor, 1);
    expect(result).toMatchObject({ recipients: 1, sent: 1, failed: 0 });
    expect(await messagesOf(confirmed)).toHaveLength(1);
    expect(await messagesOf(late)).toHaveLength(0);
    expect((await commRow(commId))?.recipientTicketIds).toEqual([confirmed]);
  });

  it('records the confirmed audience when it starts: the list and the count agree, and the database insists', async () => {
    const { incidentId, person } = await openIncident();
    const a = await linkedTicket(incidentId, 'portal');
    const b = await linkedTicket(incidentId, 'portal');
    const commId = await draft(incidentId, person.actor);
    await send(incidentId, commId, person.actor, 2);
    const row = await commRow(commId);
    expect(row?.recipientTicketIds?.toSorted()).toEqual([a, b].toSorted());
    expect(row?.confirmedRecipients).toBe(2);
    // A comm cannot be made `sending` with a list that is not the count it names.
    const other = await draft(incidentId, person.actor);
    await expect(
      owner()
        .update(schema.incidentComm)
        .set({
          status: 'sending',
          sentBy: person.id,
          confirmedRecipients: 2,
          recipientTicketIds: [a],
        })
        .where(eq(schema.incidentComm.id, other)),
    ).rejects.toThrow();
  });

  it('two presses at the same moment tell every ticket once', async () => {
    const { incidentId, person } = await openIncident();
    const tickets = await Promise.all(
      Array.from({ length: 4 }, () => linkedTicket(incidentId, 'portal')),
    );
    const commId = await draft(incidentId, person.actor);
    const outcomes = await Promise.allSettled([
      send(incidentId, commId, person.actor, 4),
      send(incidentId, commId, person.actor, 4),
    ]);
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
    for (const ticketId of tickets) expect(await messagesOf(ticketId)).toHaveLength(1);
    expect((await commRow(commId))?.status).toBe('sent');
  });
});
