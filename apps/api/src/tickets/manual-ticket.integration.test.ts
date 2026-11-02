import {
  MANUAL_CHANNELS,
  type ManualTicketResult,
  type SimilarTickets,
  type TicketDetail,
} from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, uniqueEmail, type Harness } from '../testing/harness.js';
import {
  apiOrg,
  fileTicket,
  signIn,
  timelineOf,
  type ApiErrorBody,
  type Page,
  type Persona,
} from '../testing/ticketing.js';

// T-136: a ticket filed by hand. Who may, what it needs, the contact, the SLA clock, the confirmation
// email, the channels that cannot be replied on, and the audit trail.

let h: Harness;
let agent: Persona;
let lead: Persona;
let head: Persona;
let dev: Persona;
let client: Persona;
let orgId: string;
let otherOrgId: string;

const pool = () => h.db.owner.pool;
const PATH = '/v1/tickets/manual';

function body(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orgId,
    channel: 'phone',
    subject: 'Dashboard login fails after the password reset',
    body: 'The customer called: the dashboard rejects the new password.',
    requester: { email: uniqueEmail('caller', 'customer.example'), name: 'Caller Person' },
    ...fields,
  };
}

async function rows<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await pool().query<T>(text, values)).rows;
}

beforeAll(async () => {
  h = await startHarness();
  agent = await signIn(h, 'agent');
  lead = await signIn(h, 'lead');
  head = await signIn(h, 'head');
  dev = await signIn(h, 'dev');
  orgId = (await apiOrg(lead, { name: 'Manual Org' })).id;
  otherOrgId = (await apiOrg(lead, { name: 'Other Manual Org' })).id;
  client = await signIn(h, 'client', orgId, 'Manual Client');
});

afterAll(async () => {
  await h.close();
});

describe('who may file a ticket by hand', () => {
  it('lets an agent, a lead and a head, and refuses a developer, a client and a stranger', async () => {
    for (const who of [agent, lead, head]) {
      const response = await who.client.post<ManualTicketResult>(PATH, body());
      expect(response.status).toBe(201);
      expect(response.body.ticket.channel).toBe('phone');
    }
    for (const who of [dev, client]) {
      expect((await who.client.post(PATH, body())).status).toBe(403);
    }
    const stranger = await h.client().post(PATH, body());
    expect(stranger.status).toBe(401);
  });
});

describe('what it needs', () => {
  it('requires the organization, the channel, the subject, the text and one way to name the contact', async () => {
    for (const missing of ['orgId', 'channel', 'subject', 'body', 'requester']) {
      const rest = Object.fromEntries(Object.entries(body()).filter(([key]) => key !== missing));
      const response = await agent.client.post<ApiErrorBody>(PATH, rest);
      expect([missing, response.status]).toEqual([missing, 400]);
    }
    const both = await agent.client.post(
      PATH,
      body({ requesterContactId: '00000000-0000-4000-8000-000000000001' }),
    );
    expect(both.status).toBe(400);
  });

  it('takes the four manual channels and no other', async () => {
    for (const channel of MANUAL_CHANNELS) {
      const response = await agent.client.post<ManualTicketResult>(PATH, body({ channel }));
      expect(response.status).toBe(201);
      expect(response.body.ticket.channel).toBe(channel);
    }
    for (const channel of ['gmail', 'line', 'portal', 'internal', 'sms']) {
      expect([channel, (await agent.client.post(PATH, body({ channel }))).status]).toEqual([
        channel,
        400,
      ]);
    }
  });

  it('refuses a contact of another organization', async () => {
    const stranger = await agent.client.post<ManualTicketResult>(PATH, body({ orgId: otherOrgId }));
    expect(stranger.status).toBe(201);
    const crossed = await agent.client.post<ApiErrorBody>(
      PATH,
      body({
        requester: undefined,
        requesterContactId: stranger.body.contact.id,
      }),
    );
    expect(crossed.status).toBe(400);
  });
});

describe('the contact and the SLA clock', () => {
  it('creates an unverified contact for a new address and finds the same one next time', async () => {
    const email = uniqueEmail('newcomer', 'customer.example');
    const first = await agent.client.post<ManualTicketResult>(
      PATH,
      body({ requester: { email, name: 'New Comer' } }),
    );
    expect(first.body.contact.created).toBe(true);
    const stored = await rows<{ verified_at: Date | null; emails: string[] }>(
      `SELECT verified_at, emails FROM contact WHERE id = $1`,
      [first.body.contact.id],
    );
    expect(stored[0]?.verified_at).toBeNull();
    expect(stored[0]?.emails).toEqual([email]);

    const again = await agent.client.post<ManualTicketResult>(
      PATH,
      body({ requester: { email: email.toUpperCase(), name: 'Other Spelling' } }),
    );
    expect(again.body.contact.created).toBe(false);
    expect(again.body.contact.id).toBe(first.body.contact.id);

    const picked = await agent.client.post<ManualTicketResult>(
      PATH,
      body({ requester: undefined, requesterContactId: first.body.contact.id }),
    );
    expect(picked.body.contact).toEqual({ id: first.body.contact.id, created: false });
  });

  it('starts the clock when the ticket is filed and ignores a date it is given', async () => {
    const before = Date.now();
    const response = await agent.client.post<ManualTicketResult>(
      PATH,
      body({ createdAt: '2020-01-01T00:00:00.000Z', receivedAt: '2020-01-01T00:00:00.000Z' }),
    );
    const after = Date.now();
    const created = Date.parse(response.body.ticket.createdAt);
    expect(created).toBeGreaterThanOrEqual(before - 1000);
    expect(created).toBeLessThanOrEqual(after + 1000);
    const due = response.body.ticket.firstResponseDueAt;
    if (due !== null) expect(Date.parse(due)).toBeGreaterThan(created);
    expect(response.body.ticket.status).toBe('new');
  });
});

describe('the confirmation email', () => {
  it('is not sent to a new address unless the box is ticked, and says why nothing was sent', async () => {
    const plain = await agent.client.post<ManualTicketResult>(PATH, body());
    expect(plain.body.contact.created).toBe(true);
    expect(plain.body.confirmation.status).toBe('not_requested');
    // Ticked, but there is no Gmail account to send through in this instance.
    const ticked = await agent.client.post<ManualTicketResult>(
      PATH,
      body({ sendConfirmation: true }),
    );
    expect(ticked.body.confirmation.status).toBe('no_email_account');
    const known = await agent.client.post<ManualTicketResult>(
      PATH,
      body({ requester: undefined, requesterContactId: plain.body.contact.id }),
    );
    expect(known.body.confirmation.status).toBe('no_email_account');
  });

  it('is queued through the policy gate as an automatic message once there is a Gmail account', async () => {
    const account = await rows<{ id: string }>(
      `INSERT INTO channel_account (type, name) VALUES ('gmail', 'Support mailbox') RETURNING id`,
    );
    const first = await agent.client.post<ManualTicketResult>(PATH, body());
    const known = await agent.client.post<ManualTicketResult>(
      PATH,
      body({ requester: undefined, requesterContactId: first.body.contact.id }),
    );
    expect(known.body.confirmation.status).toBe('queued');
    const deliveries = await rows<{ origin: string; channel: string; channel_account_id: string }>(
      `SELECT origin, channel, channel_account_id FROM outbound_delivery WHERE ticket_id = $1`,
      [known.body.ticket.id],
    );
    expect(deliveries).toEqual([
      { origin: 'system_template', channel: 'gmail', channel_account_id: account[0]?.id },
    ]);
    // The first response is a person's reply, not this acknowledgment.
    const detail = await agent.client.get<TicketDetail>(`/v1/tickets/${known.body.ticket.id}`);
    expect(detail.body.firstRespondedAt).toBeNull();

    const declined = await agent.client.post<ManualTicketResult>(
      PATH,
      body({
        requester: undefined,
        requesterContactId: first.body.contact.id,
        sendConfirmation: false,
      }),
    );
    expect(declined.body.confirmation.status).toBe('not_requested');
    const none = await rows(`SELECT 1 FROM outbound_delivery WHERE ticket_id = $1`, [
      declined.body.ticket.id,
    ]);
    expect(none).toHaveLength(0);
  });
});

describe('channels with nothing to reply on', () => {
  it('refuses a public reply with its own code and accepts an internal note instead', async () => {
    for (const channel of MANUAL_CHANNELS) {
      const filed = await agent.client.post<ManualTicketResult>(PATH, body({ channel }));
      const reply = await agent.client.post<ApiErrorBody>(
        `/v1/tickets/${filed.body.ticket.id}/replies`,
        { body: 'We have fixed it.' },
      );
      expect([channel, reply.status, reply.body.code]).toEqual([
        channel,
        409,
        'channel_no_outbound',
      ]);
      const note = await agent.client.post(`/v1/tickets/${filed.body.ticket.id}/notes`, {
        body: 'Phoned the customer back and told them it is fixed.',
      });
      expect(note.status).toBe(201);
    }
  });

  it('owes no satisfaction survey, announces the ticket on Discord and shows it to the customer', async () => {
    const filed = await agent.client.post<ManualTicketResult>(PATH, body({ channel: 'walk_in' }));
    const id = filed.body.ticket.id;
    await agent.client.post(`/v1/tickets/${id}/status`, { status: 'open' });
    await agent.client.post(`/v1/tickets/${id}/status`, { status: 'resolved' });
    expect(await rows(`SELECT 1 FROM csat_survey WHERE ticket_id = $1`, [id])).toHaveLength(0);

    const discord = await rows(
      `SELECT 1 FROM outbox WHERE queue = 'discord' AND payload->>'ticketId' = $1`,
      [id],
    );
    expect(discord.length).toBeGreaterThan(0);

    // The organization's own people see it in their list, in the reduced shape: no channel, no SLA.
    const list = await client.client.get<Page<Record<string, unknown>>>('/v1/tickets');
    const row = list.body.items.find((item) => item.id === id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('channel');
    expect(row).not.toHaveProperty('firstResponseDueAt');
  });
});

describe('a ticket without a customer', () => {
  it('is internal, and only then; with a customer the default stays the portal', async () => {
    const nobody = await agent.client.post<TicketDetail>('/v1/tickets', {
      orgId,
      subject: 'Follow up on an alert',
      body: 'No customer asked for this.',
    });
    expect(nobody.body.channel).toBe('internal');
    const someone = await agent.client.post<TicketDetail>('/v1/tickets', {
      orgId,
      subject: 'A customer asked',
      body: 'Please help.',
      requester: { email: uniqueEmail('asker', 'customer.example'), name: 'Asker' },
    });
    expect(someone.body.channel).toBe('portal');
    // The customer never sees an internal ticket.
    const list = await client.client.get<Page<{ id: string }>>('/v1/tickets');
    expect(list.body.items.map((item) => item.id)).not.toContain(nobody.body.id);
  });
});

describe('duplicates while filing', () => {
  it('suggests an open ticket with a similar subject, the same requester first', async () => {
    const requester = { email: uniqueEmail('dup', 'customer.example'), name: 'Dup Person' };
    const original = await fileTicket(agent, orgId, {
      subject: 'Invoice export fails with a timeout',
      requester,
    });
    const elsewhere = await fileTicket(agent, orgId, {
      subject: 'Invoice export fails with a timeout error',
    });
    const query = new URLSearchParams({
      orgId,
      requesterContactId: original.requester?.id ?? '',
      subject: 'Invoice export failing with timeout',
    });
    const found = await agent.client.get<SimilarTickets>(`/v1/tickets/similar?${query.toString()}`);
    expect(found.status).toBe(200);
    const ids = found.body.items.map((item) => item.id);
    expect(ids).toContain(original.id);
    expect(ids).toContain(elsewhere.id);
    expect(ids.indexOf(original.id)).toBeLessThan(ids.indexOf(elsewhere.id));
    expect(found.body.items.find((item) => item.id === original.id)?.sameRequester).toBe(true);

    // Another organization's tickets are not suggested, and nothing unrelated is.
    const other = new URLSearchParams({ orgId: otherOrgId, subject: 'Invoice export failing' });
    expect(
      (await agent.client.get<SimilarTickets>(`/v1/tickets/similar?${other.toString()}`)).body
        .items,
    ).toEqual([]);
    const unrelated = new URLSearchParams({ orgId, subject: 'Zebra giraffe antelope' });
    expect(
      (await agent.client.get<SimilarTickets>(`/v1/tickets/similar?${unrelated.toString()}`)).body
        .items,
    ).toEqual([]);
    // Closed work is not a duplicate.
    await agent.client.post(`/v1/tickets/${original.id}/status`, { status: 'closed' });
    const after = await agent.client.get<SimilarTickets>(`/v1/tickets/similar?${query.toString()}`);
    expect(after.body.items.map((item) => item.id)).not.toContain(original.id);

    for (const who of [dev, client]) {
      expect((await who.client.get(`/v1/tickets/similar?${query.toString()}`)).status).toBe(403);
    }
    expect((await agent.client.get('/v1/tickets/similar?orgId=x&subject=ab')).status).toBe(400);
  });
});

describe('the audit trail', () => {
  it('records who filed the ticket, on which channel, and what happened to the confirmation', async () => {
    const filed = await lead.client.post<ManualTicketResult>(PATH, body({ channel: 'chat' }));
    const id = filed.body.ticket.id;
    const audit = await rows<{
      action: string;
      actor_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, actor_id, metadata FROM audit_log WHERE target_id = $1 ORDER BY created_at`,
      [id],
    );
    const created = audit.filter((row) => row.action === 'ticket.create');
    expect(created.length).toBeGreaterThan(0);
    expect(created.every((row) => row.actor_id === lead.userId)).toBe(true);
    const text = JSON.stringify(audit);
    expect(text).toContain('chat');
    expect(text).not.toContain('@customer.example');
    const timeline = await timelineOf(lead, id);
    expect(
      timeline.entries.some((entry) => entry.kind === 'event' && entry.type === 'ticket.created'),
    ).toBe(true);
  });
});
