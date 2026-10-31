import type {
  ClientTicket,
  Intent,
  Message,
  Organization,
  SessionInfo,
  TicketDetail,
  TicketSummary,
  TimelineEntry,
} from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MagicLinkService } from '../auth/magic-link.service.js';
import { startHarness, uniqueEmail, type Harness } from '../testing/harness.js';
import {
  apiIntent,
  apiOrg,
  fileClientTicket,
  fileTicket,
  signIn,
  timelineOf,
  type ApiErrorBody,
  type Page,
  type Persona,
} from '../testing/ticketing.js';

// Who may see and do what: organization scope for clients, internal notes, roles, and the lookup
// that lets a client sign in from an organization's email domain.

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let clientA: Persona;
let clientB: Persona;
let orgA: string;
let orgB: string;
let ticketA: TicketDetail;
let ticketB: TicketDetail;

const SECRET_NOTE = 'secret-internal-note-4417';
const SECRET_THAI_NOTE = 'บันทึกภายในลับเฉพาะทีมงาน-9982';
const pool = () => h.db.owner.pool;

const CLIENT_TICKET_KEYS = [
  'createdAt',
  'id',
  'intent',
  'key',
  'mergedIntoKey',
  'number',
  'priority',
  'requesterName',
  'resolvedAt',
  'status',
  'subject',
  'updatedAt',
];

beforeAll(async () => {
  h = await startHarness();
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent', undefined, 'Visible Agent Name');
  orgA = (await apiOrg(lead, { name: 'Org A' })).id;
  orgB = (await apiOrg(lead, { name: 'Org B' })).id;
  clientA = await signIn(h, 'client', orgA, 'Client A');
  clientB = await signIn(h, 'client', orgB, 'Client B');

  ticketA = await fileTicket(agent, orgA, {
    subject: 'Org A problem',
    body: 'Org A customer text',
  });
  await agent.client.post(`/v1/tickets/${ticketA.id}/notes`, { body: SECRET_NOTE });
  await agent.client.post(`/v1/tickets/${ticketA.id}/notes`, { body: SECRET_THAI_NOTE });
  await agent.client.post(`/v1/tickets/${ticketA.id}/replies`, { body: 'Public answer for org A' });
  await agent.client.post(`/v1/tickets/${ticketA.id}/assign`, { assigneeId: agent.userId });
  await agent.client.patch(`/v1/tickets/${ticketA.id}`, { tags: ['internal-tag'] });
  ticketB = await fileTicket(agent, orgB, {
    subject: 'Org B problem',
    body: 'Org B customer text',
  });
});

afterAll(async () => {
  await h.close();
});

describe('a client sees only their own organization', () => {
  it('lists their tickets in the reduced shape and no ticket of another organization', async () => {
    const list = await clientA.client.get<Page<ClientTicket>>('/v1/tickets');
    expect(list.status).toBe(200);
    expect(list.body.items.map((ticket) => ticket.id)).toEqual([ticketA.id]);
    for (const ticket of list.body.items) {
      expect(Object.keys(ticket).toSorted()).toEqual(CLIENT_TICKET_KEYS);
    }
    const text = JSON.stringify(list.body);
    expect(text).not.toContain('internal-tag');
    expect(text).not.toContain(agent.userId);
    expect(text).not.toContain('Visible Agent Name');
    expect(text).not.toContain(ticketB.id);
  });

  it('cannot widen the list with filters', async () => {
    const asked = await clientA.client.get<Page<ClientTicket>>(
      `/v1/tickets?orgId=${orgB}&assignee=unassigned&queueId=${orgB}&tag=internal-tag&channel=portal`,
    );
    expect(asked.status).toBe(200);
    expect(asked.body.items.map((ticket) => ticket.id)).toEqual([ticketA.id]);
    const sorted = await clientA.client.get<Page<ClientTicket>>('/v1/tickets?sort=due_asc');
    expect(sorted.status).toBe(200);
    expect(sorted.body.items.every((ticket) => ticket.id === ticketA.id)).toBe(true);
  });

  it('gives the other organization the same protection, and its own tickets', async () => {
    const list = await clientB.client.get<Page<ClientTicket>>('/v1/tickets');
    expect(list.body.items.map((ticket) => ticket.id)).toEqual([ticketB.id]);
    expect((await clientB.client.get(`/v1/tickets/${ticketA.id}`)).status).toBe(404);
    expect((await clientB.client.get(`/v1/tickets/${ticketA.id}/timeline`)).status).toBe(404);
    expect(JSON.stringify(list.body)).not.toContain('Org A');
  });

  it('answers 404, and the same 404 as for a ticket that does not exist, for another organization', async () => {
    const otherById = await clientA.client.get<ApiErrorBody>(`/v1/tickets/${ticketB.id}`);
    const otherByKey = await clientA.client.get<ApiErrorBody>(`/v1/tickets/${ticketB.key}`);
    const missing = await clientA.client.get<ApiErrorBody>('/v1/tickets/OPS-999999999');
    expect(otherById.status).toBe(404);
    expect(otherByKey.status).toBe(404);
    expect(otherById.body).toEqual(missing.body);
    expect(otherByKey.body).toEqual(missing.body);
    expect(JSON.stringify(otherById.body)).not.toContain('Org B');
  });

  it('cannot read, reply to or look into the timeline of another organization ticket', async () => {
    expect((await clientA.client.get(`/v1/tickets/${ticketB.id}/timeline`)).status).toBe(404);
    expect(
      (await clientA.client.post(`/v1/tickets/${ticketB.id}/replies`, { body: 'let me in' }))
        .status,
    ).toBe(404);
    const stored = await pool().query('SELECT 1 FROM message WHERE ticket_id = $1', [ticketB.id]);
    expect(stored.rowCount).toBe(1); // only the original message
  });

  it('cannot file a ticket for another organization or set staff-only fields', async () => {
    const post = (body: Record<string, unknown>) =>
      clientA.client.post<ApiErrorBody>('/v1/tickets', { subject: 'x', body: 'x', ...body });
    expect((await post({ orgId: orgB })).status).toBe(403);
    for (const field of [
      { priority: 'P1' },
      { assigneeId: agent.userId },
      { queueId: orgB },
      { tags: ['x'] },
      { customFields: { a: 1 } },
      { requester: { email: 'someone@example.com', name: 'S' } },
      { requesterContactId: orgB },
    ]) {
      const response = await post(field);
      expect(response.status, JSON.stringify(field)).toBe(403);
    }
  });

  it('files a ticket for its own organization, as itself, and staff see it', async () => {
    const created = await fileClientTicket(clientA, { orgId: orgA });
    expect(Object.keys(created).toSorted()).toEqual(CLIENT_TICKET_KEYS);
    expect(created).toMatchObject({ status: 'new', requesterName: 'Client A' });
    const staffView = await agent.client.get<TicketDetail>(`/v1/tickets/${created.id}`);
    expect(staffView.body).toMatchObject({
      org: { id: orgA },
      channel: 'portal',
      priority: 'P3',
      requester: { name: 'Client A', email: clientA.email },
    });
    // The client's message is on the ticket as their own.
    const timeline = await timelineOf(clientA, created.id);
    const first = timeline.entries.find((entry) => entry.kind === 'message');
    expect(first).toMatchObject({
      direction: 'inbound',
      sender: { type: 'user', id: clientA.userId },
    });
  });

  it('shows an organization only its own record', async () => {
    const list = await clientA.client.get<Page<Organization>>('/v1/orgs');
    expect(list.body.items.map((org) => org.id)).toEqual([orgA]);
    expect((await clientA.client.get(`/v1/orgs/${orgA}`)).status).toBe(200);
    expect((await clientA.client.get(`/v1/orgs/${orgB}`)).status).toBe(404);
    expect((await agent.client.get(`/v1/orgs/${orgB}`)).status).toBe(200);
  });

  it('is kept out of every staff-only resource', async () => {
    for (const path of [
      '/v1/contacts',
      '/v1/queues',
      '/v1/sla-policies',
      '/v1/business-calendars',
      '/v1/ticket-workflow',
      '/v1/users',
      '/v1/audit-logs',
    ]) {
      expect((await clientA.client.get(path)).status, path).toBe(403);
    }
    for (const [method, path] of [
      ['patch', `/v1/tickets/${ticketA.id}`],
      ['post', `/v1/tickets/${ticketA.id}/status`],
      ['post', `/v1/tickets/${ticketA.id}/assign`],
      ['post', `/v1/tickets/${ticketA.id}/merge`],
      ['post', `/v1/tickets/${ticketA.id}/notes`],
      ['post', '/v1/orgs'],
      ['post', '/v1/queues'],
    ] as const) {
      const response = await clientA.client[method](path, {
        status: 'closed',
        body: 'x',
        name: 'x',
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
    // Nothing of that happened.
    const unchanged = await agent.client.get<TicketDetail>(`/v1/tickets/${ticketA.id}`);
    expect(unchanged.body.status).toBe('new');
  });

  it('gives a client the categories of the submit form, active ones, without settings', async () => {
    await apiIntent(lead, { key: 'client_visible_probe', name: 'Visible', description: 'Shown' });
    await apiIntent(lead, { key: 'client_hidden_probe', name: 'Hidden', isActive: false });
    const staff = await agent.client.get<{ intents: Intent[] }>('/v1/intents');
    expect(staff.body.intents.map((intent) => intent.key)).toEqual(
      expect.arrayContaining(['client_visible_probe', 'client_hidden_probe']),
    );
    expect(staff.body.intents[0]).toHaveProperty('autonomyStage');

    const client = await clientA.client.get<{ intents: Record<string, unknown>[] }>('/v1/intents');
    const keys = client.body.intents.map((intent) => intent.key);
    expect(keys).toContain('client_visible_probe');
    expect(keys).not.toContain('client_hidden_probe');
    for (const intent of client.body.intents) {
      expect(Object.keys(intent).toSorted()).toEqual(['description', 'id', 'key', 'name']);
    }
    expect(
      (await clientA.client.get(`/v1/intents/${client.body.intents[0]?.id as string}`)).status,
    ).toBe(403);
  });
});

describe('an internal note never reaches a client', () => {
  it('is not in the timeline of the client, whatever they ask for', async () => {
    const staff = await timelineOf(agent, ticketA.id);
    const staffText = JSON.stringify(staff);
    expect(staffText).toContain(SECRET_NOTE);
    expect(staffText).toContain(SECRET_THAI_NOTE);

    for (const query of ['', '?includeMerged=false', '?limit=500']) {
      const timeline = await timelineOf(clientA, ticketA.id, query);
      const text = JSON.stringify(timeline);
      expect(text, query).not.toContain(SECRET_NOTE);
      expect(text, query).not.toContain('secret-internal');
      expect(text, query).not.toContain(SECRET_THAI_NOTE);
      expect(
        timeline.entries.every(
          (entry) => entry.kind !== 'message' || entry.visibility === 'public',
        ),
      ).toBe(true);
      expect(
        timeline.entries.every((entry) => entry.kind !== 'event' || entry.visibility === 'public'),
      ).toBe(true);
    }
  });

  it('is not found by a client search, in either language, and is found by staff', async () => {
    const ask = async (who: Persona, q: string) =>
      (
        await who.client.get<Page<TicketSummary | ClientTicket>>(
          `/v1/tickets?q=${encodeURIComponent(q)}`,
        )
      ).body.items.map((ticket) => ticket.id);
    expect(await ask(clientA, SECRET_NOTE)).toEqual([]);
    expect(await ask(clientA, 'internal-note-4417')).toEqual([]);
    expect(await ask(clientA, 'บันทึกภายในลับ')).toEqual([]);
    expect(await ask(agent, SECRET_NOTE)).toEqual([ticketA.id]);
    expect(await ask(agent, 'บันทึกภายในลับ')).toEqual([ticketA.id]);
    // What the client may search is found.
    expect(await ask(clientA, 'Public answer')).toEqual([ticketA.id]);
    expect(await ask(clientA, 'Org A customer text')).toEqual([ticketA.id]);
  });

  it('does not appear in the response to the person who asked for the ticket', async () => {
    const detail = await clientA.client.get(`/v1/tickets/${ticketA.id}`);
    expect(JSON.stringify(detail.body)).not.toContain('secret');
  });

  it('is refused when a client tries to write one', async () => {
    const response = await clientA.client.post<ApiErrorBody>(`/v1/tickets/${ticketA.id}/notes`, {
      body: 'client note',
    });
    expect(response.status).toBe(403);
    const stored = await pool().query(`SELECT 1 FROM message WHERE body_text = 'client note'`);
    expect(stored.rowCount).toBe(0);
  });

  it('keeps staff identities and staff-only event details out of the client timeline', async () => {
    await agent.client.post(`/v1/tickets/${ticketA.id}/status`, {
      status: 'triage',
      reason: 'staff-only-reason-5521',
    });
    const timeline = await timelineOf(clientA, ticketA.id);
    const text = JSON.stringify(timeline);
    expect(text).not.toContain(agent.userId);
    expect(text).not.toContain('Visible Agent Name');
    expect(text).not.toContain('staff-only-reason-5521');
    expect(text).not.toContain('internal-tag');
    const reply = timeline.entries.find(
      (entry): entry is Extract<TimelineEntry, { kind: 'message' }> =>
        entry.kind === 'message' && entry.bodyText === 'Public answer for org A',
    );
    expect(reply?.sender).toEqual({ type: 'user', id: null, name: null });
    const status = timeline.entries.find(
      (entry) => entry.kind === 'event' && entry.type === 'ticket.status_changed',
    );
    expect(status).toMatchObject({
      payload: { from: 'new', to: 'triage' },
      actor: { id: null, name: null },
    });
    // Staff still see who and why.
    const staff = await timelineOf(agent, ticketA.id);
    expect(JSON.stringify(staff)).toContain('staff-only-reason-5521');
    expect(JSON.stringify(staff)).toContain('Visible Agent Name');
  });
});

describe('a client reply', () => {
  it('restarts a ticket that waits on the customer', async () => {
    const ticket = await fileTicket(agent, orgA, { priority: 'P1' });
    await agent.client.post(`/v1/tickets/${ticket.id}/status`, { status: 'waiting_on_customer' });
    const reply = await clientA.client.post<{ message: Message; ticket: ClientTicket }>(
      `/v1/tickets/${ticket.id}/replies`,
      { body: 'Here is the information you asked for.' },
    );
    expect(reply.status).toBe(201);
    expect(reply.body.message).toMatchObject({ direction: 'inbound', visibility: 'public' });
    expect(reply.body.ticket.status).toBe('open');
    const staff = await agent.client.get<TicketDetail>(`/v1/tickets/${ticket.id}`);
    expect(staff.body.slaPausedAt).toBeNull();
    expect(staff.body.firstRespondedAt).toBeNull(); // a customer message is not a response
  });

  it('may not set a status', async () => {
    const response = await clientA.client.post<ApiErrorBody>(`/v1/tickets/${ticketA.id}/replies`, {
      body: 'closing this myself',
      setStatus: 'closed',
    });
    expect(response.status).toBe(400);
  });

  it('reopens a ticket resolved in the last 7 days and counts it', async () => {
    const ticket = await fileTicket(agent, orgA);
    await agent.client.post(`/v1/tickets/${ticket.id}/status`, { status: 'resolved' });
    const reply = await clientA.client.post<{ ticket: ClientTicket }>(
      `/v1/tickets/${ticket.id}/replies`,
      {
        body: 'It happened again.',
      },
    );
    expect(reply.status).toBe(201);
    expect(reply.body.ticket.status).toBe('open');
    const staff = await agent.client.get<TicketDetail>(`/v1/tickets/${ticket.id}`);
    expect(staff.body).toMatchObject({ reopenCount: 1, resolvedAt: null, status: 'open' });
  });

  it('is refused once the ticket was resolved more than 7 days ago, or is closed or merged', async () => {
    const old = await fileTicket(agent, orgA);
    await agent.client.post(`/v1/tickets/${old.id}/status`, { status: 'resolved' });
    await pool().query(`UPDATE ticket SET resolved_at = now() - interval '8 days' WHERE id = $1`, [
      old.id,
    ]);
    const late = await clientA.client.post<ApiErrorBody>(`/v1/tickets/${old.id}/replies`, {
      body: 'Hello?',
    });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('ticket_not_open');

    const closed = await fileTicket(agent, orgA);
    await agent.client.post(`/v1/tickets/${closed.id}/status`, { status: 'closed' });
    expect(
      (await clientA.client.post<ApiErrorBody>(`/v1/tickets/${closed.id}/replies`, { body: 'x' }))
        .body.code,
    ).toBe('ticket_not_open');

    const target = await fileTicket(agent, orgA);
    const source = await fileTicket(agent, orgA);
    await agent.client.post(`/v1/tickets/${source.id}/merge`, { intoTicketId: target.id });
    expect(
      (await clientA.client.post<ApiErrorBody>(`/v1/tickets/${source.id}/replies`, { body: 'x' }))
        .body.code,
    ).toBe('ticket_not_open');
  });

  it('shows a client a merged ticket pointing at the one that stays', async () => {
    const target = await fileTicket(agent, orgA);
    const source = await fileTicket(agent, orgA);
    await agent.client.post(`/v1/tickets/${source.id}/merge`, { intoTicketId: target.id });
    const view = await clientA.client.get<ClientTicket>(`/v1/tickets/${source.id}`);
    expect(view.body).toMatchObject({ status: 'merged', mergedIntoKey: target.key });
    const event = (await timelineOf(clientA, source.id)).entries.find(
      (entry) => entry.kind === 'event' && entry.type === 'ticket.merged',
    );
    expect(event).toMatchObject({ payload: { intoKey: target.key } });
    expect(JSON.stringify(event)).not.toContain(target.id);
  });
});

describe('roles', () => {
  const org = () => ({ name: `Role org ${uniqueEmail('o')}` });
  const queue = () => ({ name: `Role queue ${uniqueEmail('q')}` });
  const intent = () => ({ key: `role_probe_${uniqueEmail('i').slice(2, 10)}`, name: 'Probe' });
  const calendar = () => ({ name: `Role calendar ${uniqueEmail('c')}` });
  const policy = () => ({ name: `Role policy ${uniqueEmail('p')}`, targets: {} });

  it.each([
    [
      'agent',
      {
        orgs: 403,
        contacts: 403,
        queues: 403,
        intents: 403,
        policies: 403,
        calendars: 403,
        workflow: 403,
      },
    ],
    [
      'lead',
      {
        orgs: 201,
        contacts: 201,
        queues: 201,
        intents: 201,
        policies: 403,
        calendars: 403,
        workflow: 403,
      },
    ],
    [
      'head',
      {
        orgs: 201,
        contacts: 201,
        queues: 201,
        intents: 201,
        policies: 201,
        calendars: 201,
        workflow: 200,
      },
    ],
  ] as const)('%s may manage exactly what the matrix says', async (role, expected) => {
    const who = await signIn(h, role);
    const created = await who.client.post<Organization | ApiErrorBody>('/v1/orgs', org());
    expect(created.status, 'orgs').toBe(expected.orgs);
    expect(
      (
        await who.client.post('/v1/contacts', {
          orgId: orgA,
          name: 'C',
          emails: [uniqueEmail('c')],
        })
      ).status,
      'contacts',
    ).toBe(expected.contacts);
    expect((await who.client.post('/v1/queues', queue())).status, 'queues').toBe(expected.queues);
    expect((await who.client.post('/v1/intents', intent())).status, 'intents').toBe(
      expected.intents,
    );
    expect((await who.client.post('/v1/sla-policies', policy())).status, 'policies').toBe(
      expected.policies,
    );
    expect((await who.client.post('/v1/business-calendars', calendar())).status, 'calendars').toBe(
      expected.calendars,
    );
    const workflow = await who.client.get<{ transitions: unknown[] }>('/v1/ticket-workflow');
    expect(workflow.status).toBe(200);
    expect((await who.client.put('/v1/ticket-workflow', workflow.body)).status, 'workflow').toBe(
      expected.workflow,
    );
  });
  it('writes a refusal to the audit log', async () => {
    const who = await signIn(h, 'agent');
    await who.client.post('/v1/queues', queue());
    const rows = await pool().query<{ outcome: string; metadata: { required: string[] } }>(
      `SELECT outcome, metadata FROM audit_log WHERE action = 'authz.denied' AND actor_id = $1`,
      [who.userId],
    );
    expect(rows.rows[0]).toMatchObject({
      outcome: 'denied',
      metadata: { required: ['queue.manage'] },
    });
  });

  it('refuses a request that is not signed in, or has no CSRF token', async () => {
    const anonymous = h.client();
    expect((await anonymous.get('/v1/tickets')).status).toBe(401);
    expect((await anonymous.get(`/v1/tickets/${ticketA.id}/timeline`)).status).toBe(401);
    expect((await anonymous.post('/v1/tickets', { subject: 'x', body: 'x' })).status).toBe(401);
    const noCsrf = await agent.client.post<ApiErrorBody>(
      `/v1/tickets/${ticketA.id}/notes`,
      { body: 'x' },
      { csrf: false },
    );
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.code).toBe('csrf_invalid');
  });

  it('lets only someone with ticket.reply answer as staff', async () => {
    // Remove the permission from the agent role and the same request is refused.
    const before = await head.client.get<{ roles: { role: string; permissions: string[] }[] }>(
      '/v1/rbac/roles',
    );
    const agentRole = before.body.roles.find((entry) => entry.role === 'agent');
    const without = (agentRole?.permissions ?? []).filter(
      (permission) => permission !== 'ticket.reply',
    );
    expect(
      (await head.client.put('/v1/rbac/roles/agent/permissions', { permissions: without })).status,
    ).toBe(200);
    try {
      const response = await agent.client.post<ApiErrorBody>(`/v1/tickets/${ticketB.id}/replies`, {
        body: 'x',
      });
      expect(response.status).toBe(403);
    } finally {
      await head.client.put('/v1/rbac/roles/agent/permissions', {
        permissions: agentRole?.permissions ?? [],
      });
    }
  });
});

describe('intents', () => {
  it('start at autonomy stage 2 and cannot be created or edited at another stage', async () => {
    const created = await lead.client.post<Intent>('/v1/intents', {
      key: 'stage_probe',
      name: 'Stage probe',
      autonomyStage: 4,
    });
    expect(created.status).toBe(201);
    expect(created.body.autonomyStage).toBe(2);

    const edited = await lead.client.patch<Intent>(`/v1/intents/${created.body.id}`, {
      name: 'Renamed',
      autonomyStage: 3,
      key: 'other_key',
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ name: 'Renamed', key: 'stage_probe', autonomyStage: 2 });
    const stored = await pool().query<{ autonomy_stage: number }>(
      `SELECT autonomy_stage FROM intent WHERE key = 'stage_probe'`,
    );
    expect(stored.rows[0]?.autonomy_stage).toBe(2);
  });

  it('keep a unique snake_case key and refuse deleting one a ticket uses', async () => {
    const used = await apiIntent(lead, { key: 'used_probe', name: 'Used' });
    expect(
      (await lead.client.post('/v1/intents', { key: 'used_probe', name: 'Again' })).status,
    ).toBe(409);
    expect((await lead.client.post('/v1/intents', { key: 'Not Snake', name: 'Bad' })).status).toBe(
      400,
    );
    expect((await lead.client.post('/v1/intents', { key: 'x', name: 'Short' })).status).toBe(400);

    await fileTicket(agent, orgA, { intentId: used.id });
    const blocked = await lead.client.delete<ApiErrorBody>(`/v1/intents/${used.id}`);
    expect(blocked.status).toBe(409);
    const unused = await apiIntent(lead, { key: 'unused_probe', name: 'Unused' });
    expect((await lead.client.delete(`/v1/intents/${unused.id}`)).status).toBe(204);
  });

  it('cannot be used by a ticket once inactive, nor when unknown', async () => {
    const inactive = await apiIntent(lead, { key: 'inactive_probe', name: 'Off', isActive: false });
    const post = (fields: Record<string, unknown>) =>
      agent.client.post<ApiErrorBody>('/v1/tickets', {
        orgId: orgA,
        subject: 's',
        body: 'b',
        ...fields,
      });
    expect((await post({ intentId: inactive.id })).status).toBe(400);
    expect((await post({ intentKey: 'inactive_probe' })).status).toBe(400);
    expect((await post({ intentKey: 'never_defined' })).status).toBe(400);
    expect((await post({ intentKey: 'stage_probe' })).status).toBe(201);
  });
});

describe('organizations and domains', () => {
  it('keeps a domain with one organization, lower-cased, and refuses public mailbox providers', async () => {
    const first = await lead.client.post<Organization>('/v1/orgs', {
      name: 'Domain Owner',
      domains: ['  Owner.Example '],
    });
    expect(first.status).toBe(201);
    expect(first.body.domains).toEqual(['owner.example']);

    const second = await lead.client.post<ApiErrorBody>('/v1/orgs', {
      name: 'Domain Thief',
      domains: ['other.example', 'owner.example'],
    });
    expect(second.status).toBe(409);

    const third = await apiOrg(lead, { name: 'Third', domains: ['third.example'] });
    const steal = await lead.client.patch(`/v1/orgs/${third.id}`, { domains: ['owner.example'] });
    expect(steal.status).toBe(409);
    expect(
      (
        await lead.client.patch(`/v1/orgs/${third.id}`, {
          domains: ['third.example', 'more.example'],
        })
      ).status,
    ).toBe(200);

    for (const free of ['gmail.com', 'GMAIL.COM', 'outlook.com', 'yahoo.co.th']) {
      const response = await lead.client.post('/v1/orgs', {
        name: `Free ${free}`,
        domains: [free],
      });
      expect(response.status, free).toBe(400);
    }
  });

  it('holds when two people claim the same domain at once', async () => {
    const [a, b] = await Promise.all([
      lead.client.post('/v1/orgs', { name: 'Race A', domains: ['race.example'] }),
      head.client.post('/v1/orgs', { name: 'Race B', domains: ['race.example'] }),
    ]);
    expect([a.status, b.status].toSorted()).toEqual([201, 409]);
  });

  it('pages and searches, edits, and deletes only an organization with no history', async () => {
    const created = await Promise.all(
      Array.from({ length: 5 }, (_unused, index) =>
        apiOrg(lead, { name: `Pageable ${String(index)} zebra` }),
      ),
    );
    const ids = new Set<string>();
    let cursor: string | null = null;
    do {
      const url: string = `/v1/orgs?q=zebra&limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const page = await agent.client.get<Page<Organization>>(url);
      for (const org of page.body.items) ids.add(org.id);
      cursor = page.body.nextCursor;
    } while (cursor !== null);
    expect(ids).toEqual(new Set(created.map((org) => org.id)));

    const target = created[0];
    if (!target) throw new Error('no org');
    expect(
      (await lead.client.patch(`/v1/orgs/${target.id}`, { tier: 'silver', healthScore: 80 }))
        .status,
    ).toBe(200);
    expect((await lead.client.patch(`/v1/orgs/${target.id}`, { tier: 'platinum' })).status).toBe(
      400,
    );
    expect((await lead.client.patch(`/v1/orgs/${target.id}`, {})).status).toBe(400);

    await fileTicket(agent, target.id);
    expect((await lead.client.delete(`/v1/orgs/${target.id}`)).status).toBe(409);
    const clean = created[1];
    if (!clean) throw new Error('no org');
    expect((await lead.client.delete(`/v1/orgs/${clean.id}`)).status).toBe(204);
    expect((await lead.client.get(`/v1/orgs/${clean.id}`)).status).toBe(404);
  });

  it('accepts a primary contact only from the same organization', async () => {
    const other = await apiOrg(lead);
    const contact = await lead.client.post<{ id: string }>('/v1/contacts', {
      orgId: other.id,
      name: 'Elsewhere',
      emails: [uniqueEmail('elsewhere')],
    });
    expect(
      (await lead.client.patch(`/v1/orgs/${orgA}`, { primaryContactId: contact.body.id })).status,
    ).toBe(400);
    expect(
      (await lead.client.patch(`/v1/orgs/${other.id}`, { primaryContactId: contact.body.id }))
        .status,
    ).toBe(200);
  });
});

describe('CLIENT_ORG_RESOLVER over organization.domains', () => {
  async function emailJobsFor(to: string) {
    await h.relayOutbox();
    const jobs = await h.emailQueue.getJobs([
      'waiting',
      'delayed',
      'active',
      'completed',
      'failed',
    ]);
    return jobs.filter((job) => (job.data as { to?: string }).to === to);
  }
  async function request(email: string): Promise<void> {
    expect((await h.client().post('/v1/auth/magic-link/request', { email })).status).toBe(202);
    await h.app.get(MagicLinkService).whenIdle();
  }

  it('creates a client of the organization that owns the domain, and nobody else', async () => {
    const org = await apiOrg(lead, {
      name: 'Portal Customer',
      domains: ['portal-customer.example'],
    });
    const newcomer = uniqueEmail('newcomer', 'portal-customer.example');
    const mixedCase = `Mixed-${uniqueEmail('case', 'Portal-Customer.Example')}`;
    const elsewhere = uniqueEmail('elsewhere', 'unclaimed.example');
    const subdomain = uniqueEmail('sub', 'eu.portal-customer.example');
    const lookalike = uniqueEmail('lookalike', 'notportal-customer.example');
    const suffix = uniqueEmail('suffix', 'portal-customer.example.evil.example');
    const freeMail = uniqueEmail('someone', 'gmail.com');
    for (const email of [newcomer, mixedCase, elsewhere, subdomain, lookalike, suffix, freeMail]) {
      await request(email);
    }

    const users = await pool().query<{ email: string; org_id: string; role: string }>(
      'SELECT email, org_id, role FROM users WHERE org_id = $1',
      [org.id],
    );
    expect(users.rows.map((row) => row.email).toSorted()).toEqual(
      [newcomer, mixedCase.toLowerCase()].toSorted(),
    );
    expect(users.rows.every((row) => row.role === 'client')).toBe(true);
    for (const email of [elsewhere, subdomain, lookalike, suffix, freeMail]) {
      expect(
        (await pool().query('SELECT 1 FROM users WHERE email = $1', [email])).rowCount,
        email,
      ).toBe(0);
      expect(await emailJobsFor(email), email).toHaveLength(0);
    }
    expect(await emailJobsFor(newcomer)).toHaveLength(1);
  });

  it('signs the new client in to that organization and no other', async () => {
    const org = await apiOrg(lead, { name: 'Magic Org', domains: ['magic-org.example'] });
    const email = uniqueEmail('first-visit', 'magic-org.example');
    await request(email);
    const [job] = await emailJobsFor(email);
    const link = (job?.data as { link: string }).link;
    const token = new URL(link).hash.replace('#token=', '');

    const client = h.client();
    const verified = await client.post<SessionInfo>('/v1/auth/magic-link/verify', { token });
    expect(verified.status).toBe(200);
    expect(verified.body.user).toMatchObject({ role: 'client', orgId: org.id });
    client.csrfToken = verified.body.csrfToken;

    const own = await agent.client.post<TicketDetail>('/v1/tickets', {
      orgId: org.id,
      subject: 'For the new client',
      body: 'Visible to them',
      requester: { email, name: 'First Visit' },
    });
    const list = await client.get<Page<ClientTicket>>('/v1/tickets');
    expect(list.body.items.map((ticket) => ticket.id)).toEqual([own.body.id]);
    expect((await client.get(`/v1/tickets/${ticketA.id}`)).status).toBe(404);
  });

  it('stops taking new people when the organization is inactive or gives the domain up', async () => {
    const org = await apiOrg(lead, { name: 'Closing Org', domains: ['closing.example'] });
    await lead.client.patch(`/v1/orgs/${org.id}`, { status: 'inactive' });
    const whileInactive = uniqueEmail('inactive', 'closing.example');
    await request(whileInactive);
    expect(
      (await pool().query('SELECT 1 FROM users WHERE email = $1', [whileInactive])).rowCount,
    ).toBe(0);

    await lead.client.patch(`/v1/orgs/${org.id}`, { status: 'active', domains: [] });
    const afterRelease = uniqueEmail('released', 'closing.example');
    await request(afterRelease);
    expect(
      (await pool().query('SELECT 1 FROM users WHERE email = $1', [afterRelease])).rowCount,
    ).toBe(0);
  });

  it('refuses a ticket for an inactive organization', async () => {
    const org = await apiOrg(lead, { name: 'Dormant' });
    await lead.client.patch(`/v1/orgs/${org.id}`, { status: 'inactive' });
    const response = await agent.client.post<ApiErrorBody>('/v1/tickets', {
      orgId: org.id,
      subject: 's',
      body: 'b',
    });
    expect(response.status).toBe(409);
  });
});
