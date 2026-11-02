import {
  DEFAULT_ROLE_PERMISSIONS,
  REALTIME_PATH,
  maskEmail,
  type RealtimeEvent,
  type TicketAiInsight,
  type TicketDetail,
  type TicketSummary,
  type TimelineEntry,
} from '@watchtower/shared';
import { WebSocket, type RawData } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orgPeopleNames } from '../masking/org-names.js';
import { MASKED_TEXT_UNAVAILABLE, createMaskingSession } from '../masking/pii-masker.js';
import { startHarness, uniqueEmail, type Harness } from '../testing/harness.js';
import {
  apiOrg,
  fileTicket,
  signIn,
  sleep,
  timelineOf,
  type ApiErrorBody,
  type Page,
  type Persona,
} from '../testing/ticketing.js';

// T-137: the developer reads every ticket with personal data masked, writes internal notes, moves a ticket
// between open and waiting_on_dev, picks up and links, and can do nothing that touches the customer. The
// masking is checked on every route a developer reaches, on the realtime feed and on what the AI brief says.

let h: Harness;
let agent: Persona;
let lead: Persona;
let dev: Persona;
let otherDev: Persona;
let client: Persona;
let orgId: string;
let ticket: TicketDetail;

const pool = () => h.db.owner.pool;

// Personal data of the customer, in every place a ticket holds some.
const EMAIL = 'somchai.private@customer.example';
const PHONE = '0812345678';
const GIVEN = 'Somchai';
const FAMILY = 'Privatename';
const NAME = `${GIVEN} ${FAMILY}`;
const ATTACHMENT = 'passport-somchai.pdf';
const SECRETS = [EMAIL, EMAIL.split('@')[0] ?? EMAIL, PHONE, GIVEN, FAMILY, ATTACHMENT];

function leaks(value: unknown): string[] {
  const text = JSON.stringify(value);
  return SECRETS.filter((secret) => text.includes(secret));
}

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await pool().query<T>(text, values)).rows;
}

beforeAll(async () => {
  h = await startHarness({ env: { REALTIME_REVALIDATE_SECONDS: '1' } });
  agent = await signIn(h, 'agent', undefined, 'Visible Agent');
  lead = await signIn(h, 'lead');
  dev = await signIn(h, 'dev', undefined, 'Dev One');
  otherDev = await signIn(h, 'dev', undefined, 'Dev Two');
  orgId = (await apiOrg(lead, { name: 'Dev Org' })).id;
  client = await signIn(h, 'client', orgId, 'Client Person');

  ticket = await fileTicket(agent, orgId, {
    subject: `Login failed for ${EMAIL}`,
    body: `Please call ${NAME} on ${PHONE}. My address is ${EMAIL}.`,
    requester: { email: EMAIL, name: NAME },
    customFields: { contactEmail: EMAIL },
    tags: [`owner-${EMAIL}`],
  });
  await sql(`UPDATE contact SET phone = $1 WHERE id = $2`, [PHONE, ticket.requester?.id]);
  await agent.client.post(`/v1/tickets/${ticket.id}/notes`, {
    body: `${NAME} confirmed ${PHONE} and ${EMAIL} by phone.`,
  });
  await sql(
    `UPDATE message SET attachments = $1::jsonb WHERE ticket_id = $2 AND direction = 'inbound'`,
    [
      JSON.stringify([
        { name: ATTACHMENT, contentType: 'application/pdf', size: 1234, url: `https://x/${EMAIL}` },
      ]),
      ticket.id,
    ],
  );
  const draft = await sql<{ id: string }>(
    `INSERT INTO ai_draft (ticket_id, body_text, status) VALUES ($1, $2, 'draft') RETURNING id`,
    [ticket.id, `Dear ${NAME}, we will call ${PHONE}.`],
  );
  await sql(
    `INSERT INTO ai_ticket_insight
       (ticket_id, state, stage, generated_at, summary, intent_key, intent_confidence, intent_reason,
        next_step_kind, next_step_label, evidence, draft_id, report)
     VALUES ($1, 'draft_ready', 2, now(), $2, 'access_issue', 0.8, $3, 'reply', $4, $5::jsonb, $6, $7::jsonb)`,
    [
      ticket.id,
      `${NAME} cannot sign in; reachable on ${PHONE}`,
      `The customer ${EMAIL} wrote about a password`,
      `Call ${NAME}`,
      JSON.stringify([
        {
          id: 'e1',
          kind: 'log',
          title: `Log lines for ${EMAIL}`,
          snippet: `login failed user=${EMAIL} phone=${PHONE}`,
          confidence: 0.7,
          href: `https://logs.example/?q=${EMAIL}`,
        },
        {
          id: 'e2',
          kind: 'kb',
          title: 'Reset a password',
          snippet: 'Use the reset link.',
          confidence: 0.9,
          href: '/kb/reset-a-password',
        },
      ]),
      draft[0]?.id,
      JSON.stringify({
        findings: [{ text: `${NAME} was locked out`, evidenceIds: ['e1'] }],
        likelyCause: `Account of ${EMAIL} is locked`,
        confidence: 0.6,
        openQuestions: [`Is ${PHONE} still current?`],
        tools: [{ name: 'kb.search', status: 'ok', mock: true }],
        promptVersion: 'v1',
      }),
    ],
  );
});

afterAll(async () => {
  for (const socket of sockets) socket.ws.terminate();
  await h.close();
});

describe('what a developer is', () => {
  it('has the permissions of the role and no others', () => {
    expect([...dev.session.permissions].toSorted()).toEqual(
      [...DEFAULT_ROLE_PERMISSIONS.dev].toSorted(),
    );
    expect(dev.session.user.role).toBe('dev');
  });

  it('is never offered a ticket: assigning to a developer is refused', async () => {
    const response = await agent.client.post<ApiErrorBody>(`/v1/tickets/${ticket.id}/assign`, {
      assigneeId: dev.userId,
    });
    expect(response.status).toBe(400);
  });
});

describe('every read a developer can make is masked', () => {
  it('masks the list, with no text search', async () => {
    const list = await dev.client.get<Page<TicketSummary>>('/v1/tickets');
    expect(list.status).toBe(200);
    const row = list.body.items.find((item) => item.id === ticket.id);
    expect(row).toBeDefined();
    expect(leaks(list.body)).toEqual([]);
    expect(row?.customFields).toEqual({});
    expect(row?.subject).not.toBe(ticket.subject);
    // A staff list shows the same ticket in full.
    const staff = await agent.client.get<Page<TicketSummary>>('/v1/tickets');
    expect(leaks(staff.body).length).toBeGreaterThan(0);

    // Searching the text would be an oracle on the hidden data: only a ticket number works.
    const guess = await dev.client.get<ApiErrorBody>(`/v1/tickets?q=${GIVEN.toLowerCase()}`);
    expect(guess.status).toBe(400);
    const byTag = await dev.client.get<ApiErrorBody>(`/v1/tickets?tag=owner-${EMAIL}`);
    expect(byTag.status).toBe(400);
    const byNumber = await dev.client.get<Page<TicketSummary>>(`/v1/tickets?q=${ticket.key}`);
    expect(byNumber.status).toBe(200);
    expect(byNumber.body.items.map((item) => item.id)).toEqual([ticket.id]);
  });

  it('masks the detail: address, name, custom fields and tags', async () => {
    const detail = await dev.client.get<TicketDetail>(`/v1/tickets/${ticket.key}`);
    expect(detail.status).toBe(200);
    expect(detail.body.masked).toBe(true);
    expect(leaks(detail.body)).toEqual([]);
    expect(detail.body.requester?.email).toBe(maskEmail(EMAIL));
    expect(detail.body.requester?.name).not.toContain(GIVEN);
    expect(detail.body.customFields).toEqual({});
    // The assignee and the org are not personal data of the customer.
    expect(detail.body.org.id).toBe(orgId);
  });

  it('masks the conversation: text, the customer name, attachment names and links', async () => {
    const page = await dev.client.get<{ entries: TimelineEntry[] }>(
      `/v1/tickets/${ticket.id}/timeline`,
    );
    expect(page.status).toBe(200);
    expect(leaks(page.body)).toEqual([]);
    const messages = page.body.entries.filter((entry) => entry.kind === 'message');
    expect(messages.length).toBeGreaterThan(1);
    const inbound = messages.find((entry) => entry.direction === 'inbound');
    // Masked, not erased: the shape of what was said is still there for a developer to read.
    expect(inbound?.bodyText).toMatch(/\[EMAIL_\d+\]/);
    expect(inbound?.bodyText).toMatch(/\[PHONE_\d+\]/);
    expect(inbound?.bodyText).toMatch(/\[NAME_\d+\]/);
    expect(inbound?.attachments.every((attachment) => !('url' in attachment))).toBe(true);
    // The internal note is readable: masked, not hidden.
    expect(messages.some((entry) => entry.visibility === 'internal')).toBe(true);
    const full = await timelineOf(agent, ticket.id);
    expect(leaks(full).length).toBeGreaterThan(0);
  });

  it('masks the duplicates', async () => {
    const response = await dev.client.get<{ items: TicketSummary[] }>(
      `/v1/tickets/${ticket.id}/duplicates`,
    );
    expect(response.status).toBe(200);
    expect(leaks(response.body)).toEqual([]);
  });

  it('masks the AI brief and leaves out the draft reply', async () => {
    const brief = await dev.client.get<TicketAiInsight>(`/v1/tickets/${ticket.id}/ai`);
    expect(brief.status).toBe(200);
    expect(leaks(brief.body)).toEqual([]);
    expect(brief.body.draft).toBeUndefined();
    expect(brief.body.evidence).toHaveLength(2);
    // An internal path stays, an external link (a query string can carry an identifier) goes.
    expect(brief.body.evidence.map((card) => card.href)).toEqual([
      undefined,
      '/kb/reset-a-password',
    ]);
    expect(brief.body.report?.findings.length).toBeGreaterThan(0);
    // Staff get the whole brief, draft included.
    const staff = await agent.client.get<TicketAiInsight>(`/v1/tickets/${ticket.id}/ai`);
    expect(staff.body.draft?.body).toContain(NAME);
  });

  it('reads back what a developer writes masked too', async () => {
    const note = await dev.client.post<{ message: { bodyText: string }; ticket: TicketDetail }>(
      `/v1/tickets/${ticket.id}/notes`,
      { body: `Checked the logs for ${EMAIL}; the user ${NAME} was locked out.` },
    );
    expect(note.status).toBe(201);
    expect(leaks(note.body)).toEqual([]);
    // The agent sees the note as written.
    const entries = (await timelineOf(agent, ticket.id)).entries;
    expect(
      entries.some((entry) => entry.kind === 'message' && entry.bodyText.includes(EMAIL)),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.kind === 'message' && entry.sender.id === dev.userId && entry.bodyText !== '',
      ),
    ).toBe(true);
  });
});

describe('what a developer cannot do', () => {
  it('has no way to reach the customer or the people who handle tickets', async () => {
    const id = ticket.id;
    const refused: [string, string, unknown?][] = [
      ['post', `/v1/tickets/${id}/replies`, { body: 'Hello customer' }],
      ['post', `/v1/tickets/${id}/assign`, { assigneeId: agent.userId }],
      ['post', `/v1/tickets/${id}/merge`, { intoTicketId: id }],
      ['patch', `/v1/tickets/${id}`, { priority: 'P1' }],
      ['post', '/v1/tickets', { orgId, subject: 's', body: 'b' }],
      [
        'post',
        '/v1/tickets/manual',
        {
          orgId,
          channel: 'phone',
          subject: 's',
          body: 'b',
          requesterContactId: ticket.requester?.id,
        },
      ],
      ['post', `/v1/tickets/${id}/ai/requests`, { kind: 'draft' }],
      ['post', `/v1/tickets/${id}/ai/drafts/${id}/reject`, { reason: 'wrong_intent' }],
      ['get', '/v1/tickets/stats'],
      ['get', '/v1/tickets/similar?orgId=' + orgId + '&subject=anything'],
      ['get', '/v1/contacts'],
      ['get', '/v1/orgs'],
      ['get', '/v1/notifications'],
      ['get', '/v1/incidents'],
      ['post', '/v1/incidents', { title: 'x', severity: 'SEV3' }],
      ['get', '/v1/alerts'],
      ['get', '/v1/ticket-workflow'],
      ['get', '/v1/audit-logs'],
      ['get', '/v1/users'],
    ];
    for (const [method, path, body] of refused) {
      const response =
        method === 'get'
          ? await dev.client.get(path)
          : method === 'patch'
            ? await dev.client.patch(path, body)
            : await dev.client.post(path, body);
      expect([path, response.status]).toEqual([path, 403]);
    }
  });
});

describe('open and waiting_on_dev', () => {
  async function fresh(): Promise<TicketDetail> {
    const made = await fileTicket(agent, orgId, { subject: 'Needs a developer' });
    await agent.client.post(`/v1/tickets/${made.id}/status`, { status: 'open' });
    return made;
  }

  it('lets an agent hand a ticket over only with a note, and keeps the queue and the assignee', async () => {
    const made = await fresh();
    await agent.client.post(`/v1/tickets/${made.id}/assign`, { assigneeId: agent.userId });
    const without = await agent.client.post<ApiErrorBody>(`/v1/tickets/${made.id}/status`, {
      status: 'waiting_on_dev',
    });
    expect(without.status).toBe(400);
    const note = 'Regression after the last deploy; please look at the gateway logs.';
    const moved = await agent.client.post<TicketDetail>(`/v1/tickets/${made.id}/status`, {
      status: 'waiting_on_dev',
      reason: note,
    });
    expect(moved.status).toBe(200);
    expect(moved.body.status).toBe('waiting_on_dev');
    expect(moved.body.assignee?.id).toBe(agent.userId);
    expect(moved.body.queue).toEqual(made.queue);
    const entries = (await timelineOf(dev, made.id)).entries;
    expect(entries.some((entry) => entry.kind === 'message' && entry.bodyText === note)).toBe(true);
  });

  it('keeps a developer to the two statuses and asks for a note on the way back', async () => {
    const made = await fresh();
    const to = (who: Persona, body: Record<string, unknown>) =>
      who.client.post<TicketDetail & ApiErrorBody>(`/v1/tickets/${made.id}/status`, body);
    expect((await to(dev, { status: 'waiting_on_dev' })).status).toBe(400);
    expect((await to(dev, { status: 'waiting_on_dev', reason: 'On it' })).status).toBe(200);
    expect((await to(dev, { status: 'open' })).status).toBe(400);
    expect((await to(dev, { status: 'resolved', reason: 'Done' })).status).toBe(403);
    expect((await to(dev, { status: 'closed', reason: 'Done' })).status).toBe(403);
    const back = await to(dev, { status: 'open', reason: 'Fixed in the next release' });
    expect(back.status).toBe(200);
    expect(back.body.status).toBe('open');
  });

  it('is invisible to the customer: no event, no email, only the same "in progress"', async () => {
    const owner = await signIn(h, 'client', orgId, 'Visible Client');
    const filed = await owner.client.post<TicketDetail>('/v1/tickets', {
      subject: 'Our reports are empty',
      body: 'Nothing shows up.',
    });
    expect(filed.status).toBe(201);
    await agent.client.post(`/v1/tickets/${filed.body.id}/status`, { status: 'open' });
    await agent.client.post(`/v1/tickets/${filed.body.id}/status`, {
      status: 'waiting_on_dev',
      reason: 'Needs a developer',
    });
    await dev.client.post(`/v1/tickets/${filed.body.id}/status`, {
      status: 'open',
      reason: 'Back to support',
    });
    const seen = await owner.client.get<{ entries: TimelineEntry[] }>(
      `/v1/tickets/${filed.body.id}/timeline`,
    );
    expect(JSON.stringify(seen.body)).not.toContain('waiting_on_dev');
    expect(JSON.stringify(seen.body)).not.toContain('Needs a developer');
    await h.relayOutbox();
    const jobs = await h.emailQueue.getJobs(['waiting', 'delayed', 'active', 'completed']);
    for (const job of jobs) {
      expect(JSON.stringify(h.openEmail(job))).not.toContain('waiting_on_dev');
    }
  });
});

describe('picking up and linking', () => {
  it('lets a developer pick a ticket up for themselves, once, and only they let it go', async () => {
    const made = await fileTicket(agent, orgId, { subject: 'Pick me up' });
    await agent.client.post(`/v1/tickets/${made.id}/assign`, { assigneeId: agent.userId });
    // An agent has no developer work to claim.
    expect((await agent.client.post(`/v1/tickets/${made.id}/dev-owner`)).status).toBe(403);

    const picked = await dev.client.post<TicketDetail>(`/v1/tickets/${made.id}/dev-owner`);
    expect(picked.status).toBe(200);
    expect(picked.body.devOwner?.id).toBe(dev.userId);
    expect(picked.body.assignee?.id).toBe(agent.userId);

    const mine = await dev.client.get<Page<TicketSummary>>('/v1/tickets?devOwner=me');
    expect(mine.body.items.map((item) => item.id)).toContain(made.id);
    const theirs = await otherDev.client.get<Page<TicketSummary>>('/v1/tickets?devOwner=me');
    expect(theirs.body.items.map((item) => item.id)).not.toContain(made.id);
    const free = await dev.client.get<Page<TicketSummary>>('/v1/tickets?devOwner=unassigned');
    expect(free.body.items.map((item) => item.id)).not.toContain(made.id);

    expect((await otherDev.client.post(`/v1/tickets/${made.id}/dev-owner`)).status).toBe(409);
    expect((await otherDev.client.delete(`/v1/tickets/${made.id}/dev-owner`)).status).toBe(403);
    const released = await dev.client.delete<TicketDetail>(`/v1/tickets/${made.id}/dev-owner`);
    expect(released.status).toBe(200);
    expect(released.body.devOwner).toBeNull();
  });

  it('links an incident and a deploy that exist and shows them to everyone who reads the ticket', async () => {
    const incident = await sql<{ id: string }>(
      `INSERT INTO incident (title, severity) VALUES ($1, 'SEV2') RETURNING id`,
      [`Outage affecting ${EMAIL}`],
    );
    const deploy = await sql<{ id: string }>(
      `INSERT INTO deploy (service_slug, version, env, source, external_id)
       VALUES ('gateway', 'v2.0.1', 'prod', 'ci', $1) RETURNING id`,
      [uniqueEmail('deploy')],
    );
    const made = await fileTicket(agent, orgId, { subject: 'Link me' });
    const link = (who: Persona, kind: string, targetId: string | undefined) =>
      who.client.post<TicketDetail & ApiErrorBody>(`/v1/tickets/${made.id}/references`, {
        kind,
        targetId,
      });
    const first = await link(dev, 'incident', incident[0]?.id);
    expect(first.status).toBe(200);
    expect((await link(agent, 'deploy', deploy[0]?.id)).status).toBe(200);
    expect((await link(dev, 'incident', incident[0]?.id)).status).toBe(200);
    expect((await link(dev, 'deploy', incident[0]?.id)).status).toBe(400);

    const seenByDev = await dev.client.get<TicketDetail>(`/v1/tickets/${made.id}`);
    expect(seenByDev.body.references?.map((item) => item.kind).toSorted()).toEqual([
      'deploy',
      'incident',
    ]);
    expect(leaks(seenByDev.body)).toEqual([]);
    const seenByAgent = await agent.client.get<TicketDetail>(`/v1/tickets/${made.id}`);
    expect(JSON.stringify(seenByAgent.body.references)).toContain(EMAIL);

    const incidentLink = seenByDev.body.references?.find((item) => item.kind === 'incident');
    const removed = await dev.client.delete<TicketDetail>(
      `/v1/tickets/${made.id}/references/${incidentLink?.id ?? ''}`,
    );
    expect(removed.status).toBe(200);
    expect(removed.body.references?.map((item) => item.kind)).toEqual(['deploy']);
    // A client never sees it.
    expect((await client.client.get(`/v1/tickets/${made.id}/references`)).status).toBe(404);
  });
});

describe('AI for a developer', () => {
  it('lets a developer ask for a new investigation but never a draft', async () => {
    const made = await fileTicket(agent, orgId, { subject: 'Investigate me' });
    const asked = await dev.client.post(`/v1/tickets/${made.id}/ai/requests`, {
      kind: 'investigate',
    });
    expect(asked.status).toBe(202);
    const draft = await dev.client.post(`/v1/tickets/${made.id}/ai/requests`, { kind: 'draft' });
    expect(draft.status).toBe(403);
  });
});

describe('the audit log', () => {
  it('records what a developer did, by whom', async () => {
    const rows = await sql<{ action: string }>(
      `SELECT DISTINCT action FROM audit_log WHERE actor_id = $1`,
      [dev.userId],
    );
    const actions = rows.map((row) => row.action);
    for (const action of [
      'ticket.note',
      'ticket.status_change',
      'ticket.dev_pickup',
      'ticket.dev_release',
      'ticket.reference_add',
      'ticket.reference_remove',
      'pii.read',
    ]) {
      expect(actions).toContain(action);
    }
  });
});

// --- the security review of T-137 ------------------------------------------------------------------

describe('what the first version let through (review)', () => {
  // Written the way a customer, or a redactor that is a little too clever, would put them.
  const BARE_PHONE = '66812345678';
  const US_PHONE = '4155552671';
  const ENCODED_EMAIL = 'a%40corp.example';
  // A client user: the magic-link sign-in names them after the local part of their address.
  const CLIENT_NAME = 'tanawat.secretlocal';
  const CLARA = 'Clara Clientperson';

  async function clientTicket(who: Persona, body: string): Promise<TicketDetail> {
    const response = await who.client.post<TicketDetail>('/v1/tickets', {
      subject: 'Question from a client user',
      body,
    });
    expect(response.status).toBe(201);
    return response.body;
  }

  it('hides the name of a client user as sender and as the actor of an event', async () => {
    for (const name of [CLIENT_NAME, CLARA]) {
      const person = await signIn(h, 'client', orgId, name);
      const made = await clientTicket(person, `This is ${name} writing about the dashboard.`);
      await person.client.post(`/v1/tickets/${made.id}/replies`, { body: `${name} again.` });
      const page = await dev.client.get<{ entries: TimelineEntry[] }>(
        `/v1/tickets/${made.id}/timeline`,
      );
      expect(page.status).toBe(200);
      const text = JSON.stringify(page.body);
      for (const piece of name.split(/[ .]/u)) expect(text, piece).not.toContain(piece);
      const senders = page.body.entries.flatMap((entry) =>
        entry.kind === 'message' && entry.sender.type === 'user' ? [entry.sender.name] : [],
      );
      expect(senders.length).toBeGreaterThan(0);
      // Staff see the name as it is.
      expect(JSON.stringify(await timelineOf(agent, made.id))).toContain(name);
    }
  });

  it('hides a phone number without a plus sign and an encoded address, in a message and a subject', async () => {
    const made = await fileTicket(agent, orgId, {
      subject: `Call ${BARE_PHONE} about ${ENCODED_EMAIL}`,
      body: `Reach me at ${US_PHONE} or at ${BARE_PHONE}; the form sent ${ENCODED_EMAIL}.`,
    });
    const list = await dev.client.get<Page<TicketSummary>>(`/v1/tickets?q=${made.key}`);
    const page = await dev.client.get<{ entries: TimelineEntry[] }>(
      `/v1/tickets/${made.id}/timeline`,
    );
    const detail = await dev.client.get<TicketDetail>(`/v1/tickets/${made.id}`);
    for (const body of [list.body, page.body, detail.body]) {
      const text = JSON.stringify(body);
      for (const secret of [BARE_PHONE, US_PHONE, ENCODED_EMAIL, 'corp.example']) {
        expect(text, secret).not.toContain(secret);
      }
    }
  });

  it('knows every person of the organization however many there are, on a list and on a detail', async () => {
    const bigOrg = (await apiOrg(lead, { name: 'Big Org' })).id;
    // More people than any small fixed cut-off, and the one named is the last to be added.
    await sql(
      `INSERT INTO contact (org_id, name, emails)
       SELECT $1, 'Filler' || n || ' Person' || n, ARRAY['filler' || n || '@big.example']
         FROM generate_series(1, 450) AS n`,
      [bigOrg],
    );
    await sql(
      `INSERT INTO contact (org_id, name, emails) VALUES ($1, 'Zeta Lastcontactname', $2)`,
      [bigOrg, ['zeta@big.example']],
    );
    const made = await fileTicket(agent, bigOrg, {
      subject: 'Please call Zeta Lastcontactname',
      body: 'Zeta Lastcontactname asked for a call.',
      requester: { email: uniqueEmail('someone', 'big.example'), name: 'Someone Else' },
    });
    const list = await dev.client.get<Page<TicketSummary>>('/v1/tickets?limit=200');
    const detail = await dev.client.get<TicketDetail>(`/v1/tickets/${made.id}`);
    const page = await dev.client.get<{ entries: TimelineEntry[] }>(
      `/v1/tickets/${made.id}/timeline`,
    );
    for (const body of [list.body, detail.body, page.body]) {
      expect(JSON.stringify(body)).not.toContain('Lastcontactname');
    }
    expect(list.body.items.some((item) => item.id === made.id)).toBe(true);

    // Past the limit the list of names is not complete, and a masked reader gets a notice, not text.
    const cut = await orgPeopleNames(h.db.owner.db, [bigOrg], 10);
    expect(cut.complete).toBe(false);
    expect(cut.names).toHaveLength(10);
    const closed = createMaskingSession('t', cut.names, cut.complete);
    expect(closed.text('Zeta Lastcontactname asked')).toBe(MASKED_TEXT_UNAVAILABLE);
    expect((await orgPeopleNames(h.db.owner.db, [bigOrg])).complete).toBe(true);

    // Each list under the limit and the two together over it is still cut short.
    const mixedOrg = (await apiOrg(lead, { name: 'Mixed Org' })).id;
    await sql(
      `INSERT INTO contact (org_id, name, emails)
       SELECT $1, 'Contact' || n || ' Name' || n, ARRAY['c' || n || '@mixed.example']
         FROM generate_series(1, 3) AS n`,
      [mixedOrg],
    );
    await sql(
      `INSERT INTO users (email, name, role, org_id)
       SELECT 'u' || n || '@mixed.example', 'Client' || n || ' User' || n, 'client', $1
         FROM generate_series(1, 3) AS n`,
      [mixedOrg],
    );
    const mixed = await orgPeopleNames(h.db.owner.db, [mixedOrg], 4);
    expect(mixed.complete).toBe(false);
    expect(mixed.names).toHaveLength(4);
    expect((await orgPeopleNames(h.db.owner.db, [mixedOrg], 6)).complete).toBe(true);
  });

  it('masks the AI one-liner of a list row before it is cut, so an address is never left in pieces', async () => {
    const made = await fileTicket(agent, orgId, { subject: 'Long summary' });
    // The address starts just before the 200 characters of the list row end.
    const filler = 'x'.repeat(190);
    await sql(
      `INSERT INTO ai_ticket_insight (ticket_id, state, stage, generated_at, summary)
       VALUES ($1, 'classified', 2, now(), $2)`,
      [made.id, `${filler} ${EMAIL} wrote.`],
    );
    const list = await dev.client.get<Page<TicketSummary>>(`/v1/tickets?q=${made.key}`);
    const row = list.body.items[0];
    expect(row?.ai?.summary).toBeDefined();
    expect(row?.ai?.summary?.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(list.body)).not.toContain('somchai');
    // Staff get the cut text, as before: the start of the address is in it.
    const staff = await agent.client.get<Page<TicketSummary>>(`/v1/tickets?q=${made.key}`);
    expect(staff.body.items[0]?.ai?.summary).toContain('somchai');
  });

  it('writes the investigation a developer asked for with no draft', async () => {
    const made = await fileTicket(agent, orgId, { subject: 'No draft for a developer' });
    expect(
      (await dev.client.post(`/v1/tickets/${made.id}/ai/requests`, { kind: 'investigate' })).status,
    ).toBe(202);
    // A second request for the same ticket waits a little: staff ask for another ticket.
    const other = await fileTicket(agent, orgId, { subject: 'No draft for staff, the control' });
    expect(
      (await agent.client.post(`/v1/tickets/${other.id}/ai/requests`, { kind: 'investigate' }))
        .status,
    ).toBe(202);
    const jobs = await sql<{ payload: { requestedBy: string; noDraft?: boolean } }>(
      `SELECT payload FROM outbox
        WHERE job_name = 'investigate' AND payload->>'ticketId' = ANY($1) AND payload->>'requestedBy' IS NOT NULL`,
      [[made.id, other.id]],
    );
    const by = (who: Persona) => jobs.find((job) => job.payload.requestedBy === who.userId);
    expect(by(dev)?.payload.noDraft).toBe(true);
    expect(by(agent)?.payload.noDraft).toBeUndefined();
  });
});

describe('who can let go of a developer', () => {
  it('lets the owner, a lead and a head, and nobody else', async () => {
    const made = await fileTicket(agent, orgId, { subject: 'Developer is away' });
    const head = await signIn(h, 'head');
    const pick = async () =>
      (await dev.client.post<TicketDetail>(`/v1/tickets/${made.id}/dev-owner`)).body.devOwner?.id;
    expect(await pick()).toBe(dev.userId);
    expect((await agent.client.delete(`/v1/tickets/${made.id}/dev-owner`)).status).toBe(403);
    expect((await otherDev.client.delete(`/v1/tickets/${made.id}/dev-owner`)).status).toBe(403);
    const byLead = await lead.client.delete<TicketDetail>(`/v1/tickets/${made.id}/dev-owner`);
    expect(byLead.status).toBe(200);
    expect(byLead.body.devOwner).toBeNull();
    expect(await pick()).toBe(dev.userId);
    expect((await head.client.delete(`/v1/tickets/${made.id}/dev-owner`)).status).toBe(200);
    // The history says who freed it, from whom.
    const rows = await sql<{ metadata: { releasedBy: string; devOwnerId: string } }>(
      `SELECT metadata FROM audit_log WHERE action = 'ticket.dev_release' AND outcome = 'success' AND target_id = $1`,
      [made.id],
    );
    expect(rows.map((row) => row.metadata.releasedBy).toSorted()).toEqual(
      [lead.userId, head.userId].toSorted(),
    );
    expect(rows.every((row) => row.metadata.devOwnerId === dev.userId)).toBe(true);
  });
});

// --- the feed ------------------------------------------------------------------------------------

class Socket {
  readonly frames: (Record<string, unknown> & { type: string })[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (data: RawData) => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Buffer.from(data).toString('utf8');
      this.frames.push(JSON.parse(text) as Record<string, unknown> & { type: string });
    });
  }
  events(): RealtimeEvent[] {
    return this.frames.filter((frame) => frame.type !== 'ready') as unknown as RealtimeEvent[];
  }
}
const sockets: Socket[] = [];

async function listen(who: Persona): Promise<Socket> {
  const cookie = [...who.client.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  const ws = new WebSocket(`${h.base.replace('http://', 'ws://')}${REALTIME_PATH}`, {
    headers: { origin: new URL(h.config.APP_URL).origin, cookie },
  });
  const socket = new Socket(ws);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      resolve();
    });
    ws.once('error', reject);
  });
  const deadline = Date.now() + 4000;
  while (!socket.frames.some((frame) => frame.type === 'ready') && Date.now() < deadline) {
    await sleep(20);
  }
  return socket;
}

describe('the realtime feed', () => {
  it('tells a developer about a ticket without its subject, and tells staff the whole event', async () => {
    const heardByDev = await listen(dev);
    const heardByAgent = await listen(agent);
    expect(heardByDev.frames[0]).toMatchObject({ type: 'ready', audience: 'dev' });
    const made = await fileTicket(agent, orgId, {
      subject: `Subject with ${EMAIL}`,
      requester: { email: uniqueEmail('someone'), name: 'Someone' },
    });
    await agent.client.post(`/v1/tickets/${made.id}/status`, { status: 'open' });
    const deadline = Date.now() + 4000;
    while (
      heardByDev.events().filter((event) => event.type === 'ticket.updated').length === 0 &&
      Date.now() < deadline
    ) {
      await sleep(25);
    }
    await sleep(100);
    const forDev = heardByDev.events();
    expect(forDev.length).toBeGreaterThan(0);
    expect(leaks(forDev)).toEqual([]);
    for (const event of forDev) {
      if (event.type === 'ticket.created' || event.type === 'ticket.updated') {
        expect(event.data.subject).toBe(event.ticketKey);
      }
    }
    expect(JSON.stringify(heardByAgent.events())).toContain(EMAIL);
  });

  it('does not tell a developer about the notifications of other people', async () => {
    const heard = await listen(dev);
    const made = await fileTicket(agent, orgId, { subject: 'P1 for the queue', priority: 'P1' });
    await agent.client.post(`/v1/tickets/${made.id}/assign`, { assigneeId: agent.userId });
    await sleep(500);
    expect(heard.events().filter((event) => event.type === 'notification.created')).toEqual([]);
    expect(heard.events().filter((event) => event.type === 'alert.updated')).toEqual([]);
    // And none is ever made for them: a P1 and an assignment tell the staff, not a developer.
    const mine = await sql(`SELECT 1 FROM notification WHERE user_id = $1`, [dev.userId]);
    expect(mine).toEqual([]);
    const staff = await sql(`SELECT 1 FROM notification WHERE user_id = $1`, [lead.userId]);
    expect(staff.length).toBeGreaterThan(0);
  });
});
