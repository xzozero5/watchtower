import { seedIntents } from '@watchtower/db';
import {
  DEFAULT_WEEKLY_HOURS,
  TICKET_STATUSES,
  defaultTransitionList,
  type Intent,
  type Message,
  type TicketDetail,
  type TicketSummary,
  type TimelineEntry,
  type Workflow,
} from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, uniqueEmail, type Harness } from '../testing/harness.js';
import {
  apiCalendar,
  apiOrg,
  apiPolicy,
  apiQueue,
  fileTicket,
  signIn,
  sleep,
  timelineOf,
  type ApiErrorBody,
  type Page,
  type Persona,
} from '../testing/ticketing.js';

// The ticketing core on the real application: Postgres, Redis and BullMQ from docker compose.
// Nothing is mocked. Who may see what is in tickets-access.integration.test.ts.

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let agent2: Persona;
let orgId: string;
let intents: Intent[];

const pool = () => h.db.owner.pool;
const intentByKey = (key: string): Intent => {
  const found = intents.find((intent) => intent.key === key);
  if (!found) throw new Error(`no intent ${key}`);
  return found;
};

beforeAll(async () => {
  h = await startHarness();
  await seedIntents(h.db.owner.db);
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent', undefined, 'Agent One');
  agent2 = await signIn(h, 'agent', undefined, 'Agent Two');

  const calendar = await apiCalendar(head, {
    name: 'Bangkok office hours',
    timezone: 'Asia/Bangkok',
    isDefault: true,
  });
  await apiPolicy(head, {
    name: 'Gold',
    tier: 'gold',
    businessCalendarId: calendar.id,
    targets: {
      P1: { first_response_min: 15, resolution_min: 240, calendar: '24x7' },
      P2: { first_response_min: 60, resolution_min: 480, calendar: 'business' },
      P3: { first_response_min: 240, resolution_min: 2400, calendar: 'business' },
    },
  });
  orgId = (await apiOrg(lead, { name: 'Acme Gold', tier: 'gold' })).id;
  const list = await agent.client.get<{ intents: Intent[] }>('/v1/intents');
  intents = list.body.intents;
});

afterAll(async () => {
  await h.close();
});

describe('creating a ticket', () => {
  it('numbers it OPS-n, files the first message and the requester, and sets the SLA due dates', async () => {
    const intent = intentByKey('api_error');
    const ticket = await fileTicket(agent, orgId, { intentId: intent.id });

    expect(ticket.key).toMatch(/^OPS-\d+$/);
    expect(ticket.number).toBeGreaterThanOrEqual(1001);
    expect(ticket).toMatchObject({
      status: 'new',
      channel: 'portal',
      priority: 'P2', // the intent's default priority
      org: { id: orgId },
      intent: { key: 'api_error' },
      assignee: null,
      aiHandled: false,
      reopenCount: 0,
      // N3: the stage the intent had when the ticket arrived, draft-for-approval.
      autonomyStageAtCreation: 2,
    });
    expect(ticket.requester?.email).toMatch(/^requester-.*@example\.com$/);
    expect(ticket.slaPolicyId).not.toBeNull();
    expect(ticket.firstResponseDueAt).not.toBeNull();
    expect(Date.parse(ticket.firstResponseDueAt ?? '')).toBeGreaterThan(
      Date.parse(ticket.createdAt),
    );

    const timeline = await timelineOf(agent, ticket.id);
    const messages = timeline.entries.filter((entry) => entry.kind === 'message');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ direction: 'inbound', visibility: 'public' });
    expect(
      timeline.entries.some((entry) => entry.kind === 'event' && entry.type === 'ticket.created'),
    ).toBe(true);
  });

  it('works out due dates on the 24x7 clock for P1 and on the calendar for P2', async () => {
    const p1 = await fileTicket(agent, orgId, { priority: 'P1' });
    const created = Date.parse(p1.createdAt);
    expect(Date.parse(p1.firstResponseDueAt ?? '') - created).toBe(15 * 60_000);
    expect(Date.parse(p1.resolutionDueAt ?? '') - created).toBe(240 * 60_000);

    const p2 = await fileTicket(agent, orgId, { priority: 'P2' });
    // Never earlier than the 24x7 arithmetic would say, and always inside business hours.
    expect(Date.parse(p2.firstResponseDueAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(p2.createdAt) + 60 * 60_000,
    );
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Bangkok',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(p2.firstResponseDueAt ?? ''));
    expect(local).not.toMatch(/^(Sat|Sun)/);
    const hour = Number(/(\d{2}):\d{2}$/.exec(local)?.[1]);
    expect(hour).toBeGreaterThanOrEqual(9);
    expect(hour).toBeLessThanOrEqual(18);
  });

  it('uses the calendar and the tier of the organization: one working day a week means that day', async () => {
    const wednesdayOnly = await apiCalendar(head, {
      name: 'Wednesdays only',
      timezone: 'Asia/Bangkok',
      hours: {
        ...DEFAULT_WEEKLY_HOURS,
        mon: [],
        tue: [],
        wed: [{ start: '09:00', end: '18:00' }],
        thu: [],
        fri: [],
      },
    });
    await apiPolicy(head, {
      name: 'Silver',
      tier: 'silver',
      businessCalendarId: wednesdayOnly.id,
      targets: { P3: { first_response_min: 60, resolution_min: 120, calendar: 'business' } },
    });
    const silver = await apiOrg(lead, { name: 'Acme Silver', tier: 'silver' });
    const ticket = await fileTicket(agent, silver.id, { priority: 'P3' });
    for (const due of [ticket.firstResponseDueAt, ticket.resolutionDueAt]) {
      const weekday = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Bangkok',
        weekday: 'short',
      }).format(new Date(due ?? ''));
      expect(weekday).toBe('Wed');
    }
  });

  it('gives no due date when the organization has no policy for its tier', async () => {
    const bronze = await apiOrg(lead, { name: 'Acme Standard', tier: 'standard' });
    const ticket = await fileTicket(agent, bronze.id);
    expect(ticket).toMatchObject({
      slaPolicyId: null,
      firstResponseDueAt: null,
      resolutionDueAt: null,
      priority: 'P3',
    });
  });

  it('never repeats a number when many tickets are created at once', async () => {
    const results = await Promise.all(
      Array.from({ length: 24 }, () =>
        agent.client.post<TicketDetail>('/v1/tickets', {
          orgId,
          subject: 'Concurrent',
          body: 'Created in parallel',
          requester: { email: uniqueEmail('parallel'), name: 'P' },
        }),
      ),
    );
    expect(results.every((response) => response.status === 201)).toBe(true);
    const numbers = results.map((response) => response.body.number);
    expect(new Set(numbers).size).toBe(24);
    expect(new Set(results.map((response) => response.body.key)).size).toBe(24);
  });

  it('creates one contact when two tickets arrive at once from the same new address', async () => {
    const email = uniqueEmail('twice');
    const responses = await Promise.all(
      [1, 2, 3].map(() =>
        agent.client.post<TicketDetail>('/v1/tickets', {
          orgId,
          subject: 'Same person',
          body: 'Twice',
          requester: { email, name: 'Same Person' },
        }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
    const contacts = await pool().query('SELECT 1 FROM contact WHERE $1 = ANY(emails)', [email]);
    expect(contacts.rowCount).toBe(1);
  });

  it('refuses a requester that already belongs to another organization', async () => {
    const other = await apiOrg(lead);
    const email = uniqueEmail('shared');
    await fileTicket(agent, orgId, { requester: { email, name: 'First' } });
    const response = await agent.client.post<ApiErrorBody>('/v1/tickets', {
      orgId: other.id,
      subject: 'x',
      body: 'x',
      requester: { email, name: 'Second' },
    });
    expect(response.status).toBe(409);
  });

  it('rejects bad input with 400', async () => {
    const post = (body: unknown) => agent.client.post<ApiErrorBody>('/v1/tickets', body);
    expect((await post({ subject: 'no org', body: 'x' })).status).toBe(400);
    expect((await post({ orgId, subject: '', body: 'x' })).status).toBe(400);
    expect((await post({ orgId, subject: 'x', body: 'x', priority: 'P9' })).status).toBe(400);
    expect(
      (await post({ orgId: '00000000-0000-4000-8000-000000000001', subject: 'x', body: 'x' }))
        .status,
    ).toBe(400);
    expect(
      (await post({ orgId, subject: 'x', body: 'x', intentKey: 'does_not_exist' })).status,
    ).toBe(400);
    expect(
      (
        await post({
          orgId,
          subject: 'x',
          body: 'x',
          requesterContactId: '00000000-0000-4000-8000-000000000001',
        })
      ).status,
    ).toBe(400);
  });

  it('records the creation in the audit log with the caller IP, in the same transaction', async () => {
    const ticket = await fileTicket(agent, orgId);
    const rows = await pool().query<{
      actor_id: string;
      ip: string | null;
      after: { status: string; orgId: string };
      outcome: string;
    }>(
      `SELECT actor_id, ip, after, outcome FROM audit_log WHERE action = 'ticket.create' AND target_id = $1`,
      [ticket.id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      actor_id: agent.userId,
      outcome: 'success',
      after: { status: 'new', orgId },
    });
    expect(rows.rows[0]?.ip).toBe(agent.client.ip);
    // The text of the ticket is not copied into the audit log.
    expect(JSON.stringify(rows.rows[0])).not.toContain('dashboard rejects our password');
  });
});

describe('status workflow', () => {
  async function setStatus(who: Persona, ref: string, status: string, reason?: string) {
    return who.client.post<TicketDetail & ApiErrorBody>(`/v1/tickets/${ref}/status`, {
      status,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  it('walks new, triage, open, waiting on customer, waiting on dev, resolved, closed', async () => {
    const ticket = await fileTicket(agent, orgId);
    for (const status of [
      'triage',
      'open',
      'waiting_on_customer',
      'waiting_on_dev',
      'resolved',
      'closed',
    ]) {
      const response = await setStatus(agent, ticket.id, status, 'moving along');
      expect(response.status, status).toBe(200);
      expect(response.body.status).toBe(status);
    }
    const final = await agent.client.get<TicketDetail>(`/v1/tickets/${ticket.key}`);
    expect(final.body.resolvedAt).not.toBeNull();
    expect(final.body.closedAt).not.toBeNull();
  });

  it('refuses transitions the workflow does not allow, with a stable error code', async () => {
    const ticket = await fileTicket(agent, orgId);
    const skip = await setStatus(agent, ticket.id, 'waiting_on_dev');
    expect(skip.status).toBe(409);
    expect(skip.body.code).toBe('invalid_transition');

    const same = await setStatus(agent, ticket.id, 'new');
    expect(same.status).toBe(409);

    await setStatus(agent, ticket.id, 'closed');
    const reopen = await setStatus(agent, ticket.id, 'open');
    expect(reopen.status).toBe(409);
    expect(reopen.body.code).toBe('invalid_transition');
    expect((await agent.client.get<TicketDetail>(`/v1/tickets/${ticket.id}`)).body.status).toBe(
      'closed',
    );
  });

  it('never lets anyone move a ticket to merged by hand', async () => {
    const ticket = await fileTicket(agent, orgId);
    const response = await setStatus(agent, ticket.id, 'merged');
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('invalid_transition');
  });

  it('rejects an unknown status with 400 and an unknown ticket with 404', async () => {
    const ticket = await fileTicket(agent, orgId);
    expect((await setStatus(agent, ticket.id, 'done')).status).toBe(400);
    expect((await setStatus(agent, 'OPS-999999999', 'open')).status).toBe(404);
    expect((await setStatus(agent, 'nonsense', 'open')).status).toBe(400);
  });

  it('records each change in the audit log, and a refused one as a failure', async () => {
    const ticket = await fileTicket(agent, orgId);
    expect((await setStatus(agent, ticket.id, 'triage')).status).toBe(200);
    const refused = await setStatus(agent, ticket.id, 'new');
    expect(refused.status).toBe(409);

    const rows = await pool().query<{
      outcome: string;
      metadata: { from?: string; to?: string; errorCode?: string };
    }>(
      `SELECT outcome, metadata FROM audit_log WHERE action = 'ticket.status_change' AND target_id = $1 ORDER BY created_at`,
      [ticket.id],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({
      outcome: 'success',
      metadata: { from: 'new', to: 'triage' },
    });
    expect(rows.rows[1]).toMatchObject({
      outcome: 'failure',
      metadata: { errorCode: 'invalid_transition' },
    });
  });

  it('can be reconfigured by a head, and by nobody else', async () => {
    const current = await agent.client.get<Workflow>('/v1/ticket-workflow');
    expect(current.status).toBe(200);
    expect(current.body.transitions).toHaveLength(defaultTransitionList().length);

    const without = current.body.transitions.filter(
      (transition) => !(transition.from === 'open' && transition.to === 'closed'),
    );
    expect((await agent.client.put('/v1/ticket-workflow', { transitions: without })).status).toBe(
      403,
    );
    expect((await lead.client.put('/v1/ticket-workflow', { transitions: without })).status).toBe(
      403,
    );
    expect((await head.client.put('/v1/ticket-workflow', { transitions: without })).status).toBe(
      200,
    );

    try {
      const ticket = await fileTicket(agent, orgId);
      await setStatus(agent, ticket.id, 'open');
      const blocked = await setStatus(agent, ticket.id, 'closed');
      expect(blocked.status).toBe(409);
      expect((await setStatus(agent, ticket.id, 'resolved')).status).toBe(200);
    } finally {
      expect(
        (await head.client.put('/v1/ticket-workflow', { transitions: current.body.transitions }))
          .status,
      ).toBe(200);
    }
  });

  it('refuses a workflow that mentions merged, loops or unknown statuses', async () => {
    const put = (transitions: unknown[]) =>
      head.client.put<ApiErrorBody>('/v1/ticket-workflow', { transitions });
    expect((await put([{ from: 'open', to: 'merged' }])).status).toBe(400);
    expect((await put([{ from: 'merged', to: 'open' }])).status).toBe(400);
    expect((await put([{ from: 'open', to: 'open' }])).status).toBe(400);
    expect((await put([{ from: 'open', to: 'gone' }])).status).toBe(400);
    expect(TICKET_STATUSES).toContain('merged');
  });
});

describe('the SLA clock', () => {
  it('stops in waiting_on_customer and restarts with the time that was left', async () => {
    const ticket = await fileTicket(agent, orgId, { priority: 'P1' });
    const dueBefore = Date.parse(ticket.resolutionDueAt ?? '');

    const paused = await agent.client.post<TicketDetail>(`/v1/tickets/${ticket.id}/status`, {
      status: 'waiting_on_customer',
    });
    expect(paused.body.slaPausedAt).not.toBeNull();
    // The due dates are frozen while paused.
    expect(Date.parse(paused.body.resolutionDueAt ?? '')).toBe(dueBefore);

    await sleep(1500);
    const resumed = await agent.client.post<TicketDetail>(`/v1/tickets/${ticket.id}/status`, {
      status: 'open',
    });
    expect(resumed.body.slaPausedAt).toBeNull();
    const shift = Date.parse(resumed.body.resolutionDueAt ?? '') - dueBefore;
    // The 24x7 due date moved by the length of the pause.
    expect(shift).toBeGreaterThanOrEqual(1400);
    expect(shift).toBeLessThan(5000);

    const timeline = await timelineOf(agent, ticket.id);
    const types = timeline.entries.flatMap((entry) => (entry.kind === 'event' ? [entry.type] : []));
    expect(types).toEqual(
      expect.arrayContaining(['sla.paused', 'sla.resumed', 'ticket.status_changed']),
    );
  });

  it('leaves the due dates alone when the status changes between two running states', async () => {
    const ticket = await fileTicket(agent, orgId, { priority: 'P1' });
    await agent.client.post(`/v1/tickets/${ticket.id}/status`, { status: 'open' });
    const response = await agent.client.post<TicketDetail>(`/v1/tickets/${ticket.id}/status`, {
      status: 'waiting_on_dev',
    });
    expect(response.body.slaPausedAt).toBeNull();
    expect(response.body.resolutionDueAt).toBe(ticket.resolutionDueAt);
  });

  it('recalculates the due dates from the creation time when the priority changes', async () => {
    const ticket = await fileTicket(agent, orgId, { priority: 'P3' });
    const raised = await agent.client.patch<TicketDetail>(`/v1/tickets/${ticket.id}`, {
      priority: 'P1',
    });
    expect(raised.status).toBe(200);
    expect(Date.parse(raised.body.firstResponseDueAt ?? '') - Date.parse(ticket.createdAt)).toBe(
      15 * 60_000,
    );
    expect(Date.parse(raised.body.resolutionDueAt ?? '') - Date.parse(ticket.createdAt)).toBe(
      240 * 60_000,
    );
  });

  it('counts the first staff reply as the first response, and a customer message as none', async () => {
    const ticket = await fileTicket(agent, orgId);
    expect(ticket.firstRespondedAt).toBeNull();
    await agent.client.post(`/v1/tickets/${ticket.id}/notes`, { body: 'internal only' });
    expect(
      (await agent.client.get<TicketDetail>(`/v1/tickets/${ticket.id}`)).body.firstRespondedAt,
    ).toBeNull();
    await agent.client.post(`/v1/tickets/${ticket.id}/replies`, {
      body: 'We are looking into it.',
    });
    const after = await agent.client.get<TicketDetail>(`/v1/tickets/${ticket.id}`);
    expect(after.body.firstRespondedAt).not.toBeNull();
  });
});

describe('replies and notes', () => {
  it('lets staff reply, add an internal note, and reply while setting the status', async () => {
    const ticket = await fileTicket(agent, orgId);
    const reply = await agent.client.post<{ message: Message; ticket: TicketDetail }>(
      `/v1/tickets/${ticket.id}/replies`,
      { body: 'Please try again now.', setStatus: 'waiting_on_customer' },
    );
    expect(reply.status).toBe(201);
    expect(reply.body.message).toMatchObject({
      direction: 'outbound',
      visibility: 'public',
      sender: { type: 'user', id: agent.userId, name: 'Agent One' },
      deliveryStatus: 'delivered',
    });
    expect(reply.body.ticket.status).toBe('waiting_on_customer');
    expect(reply.body.ticket.slaPausedAt).not.toBeNull();

    const note = await agent.client.post<{ message: Message }>(`/v1/tickets/${ticket.id}/notes`, {
      body: 'Customer is on the old SDK.',
    });
    expect(note.status).toBe(201);
    expect(note.body.message).toMatchObject({ direction: 'internal', visibility: 'internal' });
  });

  it('sends nothing when the status in "reply and set status" is not allowed', async () => {
    const ticket = await fileTicket(agent, orgId);
    const before = (await timelineOf(agent, ticket.id)).entries.length;
    const reply = await agent.client.post<ApiErrorBody>(`/v1/tickets/${ticket.id}/replies`, {
      body: 'This must not be saved',
      setStatus: 'merged',
    });
    expect(reply.status).toBe(409);
    const after = await timelineOf(agent, ticket.id);
    expect(after.entries).toHaveLength(before);
    expect(JSON.stringify(after)).not.toContain('This must not be saved');
  });

  it('refuses replies and notes on a merged ticket and replies on a closed one', async () => {
    const source = await fileTicket(agent, orgId);
    const target = await fileTicket(agent, orgId);
    await agent.client.post(`/v1/tickets/${source.id}/merge`, { intoTicketId: target.id });
    for (const path of ['replies', 'notes']) {
      const response = await agent.client.post<ApiErrorBody>(`/v1/tickets/${source.id}/${path}`, {
        body: 'x',
      });
      expect(response.status, path).toBe(409);
      expect(response.body.code).toBe('ticket_not_open');
    }
    const closed = await fileTicket(agent, orgId);
    await agent.client.post(`/v1/tickets/${closed.id}/status`, { status: 'closed' });
    const reply = await agent.client.post<ApiErrorBody>(`/v1/tickets/${closed.id}/replies`, {
      body: 'x',
    });
    expect(reply.status).toBe(409);
    expect(reply.body.code).toBe('ticket_not_open');
    // A note on a closed ticket is fine: post-mortems happen after the fact.
    expect(
      (await agent.client.post(`/v1/tickets/${closed.id}/notes`, { body: 'post-mortem' })).status,
    ).toBe(201);
  });

  it('rejects an empty body', async () => {
    const ticket = await fileTicket(agent, orgId);
    expect(
      (await agent.client.post(`/v1/tickets/${ticket.id}/replies`, { body: '   ' })).status,
    ).toBe(400);
    expect((await agent.client.post(`/v1/tickets/${ticket.id}/notes`, {})).status).toBe(400);
  });

  it('puts no message text in the audit log', async () => {
    const ticket = await fileTicket(agent, orgId);
    await agent.client.post(`/v1/tickets/${ticket.id}/notes`, { body: 'private-marker-7731' });
    await agent.client.post(`/v1/tickets/${ticket.id}/replies`, { body: 'public-marker-7731' });
    const rows = await pool().query<{ action: string }>(
      `SELECT action, before, after, metadata FROM audit_log WHERE target_id = $1`,
      [ticket.id],
    );
    expect(rows.rows.map((row) => row.action)).toEqual(
      expect.arrayContaining(['ticket.note', 'ticket.reply']),
    );
    expect(JSON.stringify(rows.rows)).not.toContain('marker-7731');
    const events = await pool().query('SELECT payload FROM ticket_event WHERE ticket_id = $1', [
      ticket.id,
    ]);
    expect(JSON.stringify(events.rows)).not.toContain('marker-7731');
  });
});

describe('assignment', () => {
  async function staffMembers(count: number): Promise<Persona[]> {
    return Promise.all(Array.from({ length: count }, () => signIn(h, 'agent')));
  }

  it('assigns by hand, unassigns, and keeps every change in the history', async () => {
    const ticket = await fileTicket(lead, orgId);
    const first = await lead.client.post<TicketDetail>(`/v1/tickets/${ticket.id}/assign`, {
      assigneeId: agent.userId,
    });
    expect(first.status).toBe(200);
    expect(first.body.assignee).toEqual({ id: agent.userId, name: 'Agent One' });
    await lead.client.post(`/v1/tickets/${ticket.id}/assign`, { assigneeId: agent2.userId });
    const cleared = await lead.client.post<TicketDetail>(`/v1/tickets/${ticket.id}/assign`, {
      assigneeId: null,
    });
    expect(cleared.body.assignee).toBeNull();

    const assigned = (await timelineOf(lead, ticket.id)).entries.filter(
      (entry): entry is Extract<TimelineEntry, { kind: 'event' }> =>
        entry.kind === 'event' && entry.type === 'ticket.assigned',
    );
    expect(assigned.map((entry) => [entry.payload.from, entry.payload.to])).toEqual([
      [null, agent.userId],
      [agent.userId, agent2.userId],
      [agent2.userId, null],
    ]);
    expect(assigned.every((entry) => entry.actor.id === lead.userId)).toBe(true);
  });

  it('refuses to assign to a client, a disabled user, or someone who does not exist', async () => {
    const ticket = await fileTicket(lead, orgId);
    const client = await signIn(h, 'client', orgId);
    const disabled = await signIn(h, 'agent');
    await head.client.patch(`/v1/users/${disabled.userId}`, { status: 'disabled' });
    for (const id of [client.userId, disabled.userId, '00000000-0000-4000-8000-000000000001']) {
      const response = await lead.client.post<ApiErrorBody>(`/v1/tickets/${ticket.id}/assign`, {
        assigneeId: id,
      });
      expect(response.status).toBe(400);
    }
  });

  it('needs exactly one of assigneeId and strategy', async () => {
    const ticket = await fileTicket(lead, orgId);
    expect((await lead.client.post(`/v1/tickets/${ticket.id}/assign`, {})).status).toBe(400);
    expect(
      (
        await lead.client.post(`/v1/tickets/${ticket.id}/assign`, {
          assigneeId: agent.userId,
          strategy: 'round_robin',
        })
      ).status,
    ).toBe(400);
  });

  it('hands tickets to the active members of a round-robin queue in turn, also when created at once', async () => {
    const members = await staffMembers(4);
    const queue = await apiQueue(lead, {
      name: `Round robin ${uniqueEmail('q')}`,
      assignmentMode: 'round_robin',
      memberIds: members.map((member) => member.userId),
    });
    // One member leaves the company: they must not be handed any more tickets.
    const [gone, ...active] = members;
    expect(
      (await head.client.patch(`/v1/users/${gone?.userId ?? ''}`, { status: 'disabled' })).status,
    ).toBe(200);

    const created = await Promise.all(
      Array.from({ length: 30 }, () =>
        lead.client.post<TicketDetail>('/v1/tickets', {
          orgId,
          queueId: queue.id,
          subject: 'Round robin',
          body: 'Take turns',
          requester: { email: uniqueEmail('rr'), name: 'RR' },
        }),
      ),
    );
    expect(created.every((response) => response.status === 201)).toBe(true);
    const counts = new Map<string, number>();
    for (const response of created) {
      const assignee = response.body.assignee?.id ?? 'nobody';
      counts.set(assignee, (counts.get(assignee) ?? 0) + 1);
    }
    expect(counts.get(gone?.userId ?? '')).toBeUndefined();
    expect(counts.get('nobody')).toBeUndefined();
    expect([...counts.values()]).toEqual([10, 10, 10]);
    expect(new Set(counts.keys())).toEqual(new Set(active.map((member) => member.userId)));
  });

  it('assigns the next member on request, and says so when a queue has nobody', async () => {
    const members = await staffMembers(2);
    const queue = await apiQueue(lead, {
      name: `On request ${uniqueEmail('q')}`,
      assignmentMode: 'manual',
      memberIds: members.map((member) => member.userId),
    });
    const empty = await apiQueue(lead, { name: `Empty ${uniqueEmail('q')}` });
    const ticket = await fileTicket(lead, orgId, { queueId: queue.id });
    expect(ticket.assignee).toBeNull(); // manual queue: nobody is picked on creation

    const picked = new Set<string>();
    for (let index = 0; index < 4; index += 1) {
      const response = await lead.client.post<TicketDetail>(`/v1/tickets/${ticket.id}/assign`, {
        strategy: 'round_robin',
      });
      expect(response.status).toBe(200);
      picked.add(response.body.assignee?.id ?? 'none');
    }
    expect(picked).toEqual(new Set(members.map((member) => member.userId)));

    const noMembers = await lead.client.post<ApiErrorBody>(`/v1/tickets/${ticket.id}/assign`, {
      strategy: 'round_robin',
      queueId: empty.id,
    });
    expect(noMembers.status).toBe(409);
    const noQueue = await fileTicket(lead, orgId);
    expect(
      (await lead.client.post(`/v1/tickets/${noQueue.id}/assign`, { strategy: 'round_robin' }))
        .status,
    ).toBe(400);
  });

  it('keeps one default queue and sends queue-less tickets to it', async () => {
    const first = await apiQueue(lead, { name: `Default A ${uniqueEmail('q')}`, isDefault: true });
    const second = await apiQueue(lead, { name: `Default B ${uniqueEmail('q')}`, isDefault: true });
    const queues = await lead.client.get<{ queues: { id: string; isDefault: boolean }[] }>(
      '/v1/queues',
    );
    expect(queues.body.queues.filter((queue) => queue.isDefault).map((queue) => queue.id)).toEqual([
      second.id,
    ]);
    const ticket = await fileTicket(lead, orgId);
    expect(ticket.queue?.id).toBe(second.id);
    expect(first.id).not.toBe(second.id);
    // Put the default away so later tests start from "no queue".
    await lead.client.patch(`/v1/queues/${second.id}`, { isDefault: false });
  });
});

describe('merging', () => {
  async function history(who: Persona, ref: string) {
    return (await timelineOf(who, ref)).entries;
  }

  it('keeps both conversations on the target, marks the source merged and points it at the target', async () => {
    const source = await fileTicket(agent, orgId, {
      subject: 'Duplicate report',
      body: 'source-first-message',
    });
    const target = await fileTicket(agent, orgId, {
      subject: 'Original report',
      body: 'target-first-message',
    });
    await agent.client.post(`/v1/tickets/${source.id}/notes`, { body: 'source-internal-note' });

    const merged = await agent.client.post<{ source: TicketDetail; target: TicketDetail }>(
      `/v1/tickets/${source.key}/merge`,
      { intoTicketId: target.key, reason: 'same outage' },
    );
    expect(merged.status).toBe(200);
    expect(merged.body.source).toMatchObject({
      status: 'merged',
      parentTicketId: target.id,
      mergedIntoKey: target.key,
    });
    expect(merged.body.target.status).toBe('new');
    expect(merged.body.target.mergedTickets).toEqual([
      { id: source.id, key: source.key, subject: 'Duplicate report' },
    ]);

    const targetEntries = await history(agent, target.id);
    const bodies = targetEntries.flatMap((entry) =>
      entry.kind === 'message' ? [entry.bodyText] : [],
    );
    expect(bodies).toEqual(
      expect.arrayContaining([
        'target-first-message',
        'source-first-message',
        'source-internal-note',
      ]),
    );
    const fromSource = targetEntries.filter((entry) => entry.ticketId === source.id);
    expect(fromSource.length).toBeGreaterThan(0);
    expect(fromSource.every((entry) => entry.ticketKey === source.key)).toBe(true);

    // Each ticket still has its own history; a caller can also ask for the target alone.
    const sourceOwn = await history(agent, source.id);
    expect(
      sourceOwn.some((entry) => entry.kind === 'event' && entry.type === 'ticket.merged'),
    ).toBe(true);
    const targetOnly = await timelineOf(agent, target.id, '?includeMerged=false');
    expect(targetOnly.entries.every((entry) => entry.ticketId === target.id)).toBe(true);

    // The source now answers with its merged status and points to the target.
    const detail = await agent.client.get<TicketDetail>(`/v1/tickets/${source.id}`);
    expect(detail.body).toMatchObject({ status: 'merged', mergedIntoKey: target.key });
  });

  it('refuses a merge across organizations, into itself, of a merged ticket, and into a closed one', async () => {
    const otherOrg = await apiOrg(lead);
    const a = await fileTicket(agent, orgId);
    const b = await fileTicket(agent, otherOrg.id);
    const merge = (from: string, into: string) =>
      agent.client.post<ApiErrorBody>(`/v1/tickets/${from}/merge`, { intoTicketId: into });

    const cross = await merge(a.id, b.id);
    expect(cross.status).toBe(409);
    expect(cross.body.code).toBe('merge_not_allowed');
    expect(cross.body.message).toMatch(/different organizations/);

    expect((await merge(a.id, a.id)).body.code).toBe('merge_not_allowed');
    expect((await merge(a.id, a.key)).body.code).toBe('merge_not_allowed');

    const c = await fileTicket(agent, orgId);
    expect((await merge(a.id, c.id)).status).toBe(200);
    const again = await merge(a.id, c.id);
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/already merged/);

    const d = await fileTicket(agent, orgId);
    const intoMerged = await merge(d.id, a.id);
    expect(intoMerged.status).toBe(409);
    expect(intoMerged.body.message).toMatch(/merge into that one/);

    const closed = await fileTicket(agent, orgId);
    await agent.client.post(`/v1/tickets/${closed.id}/status`, { status: 'closed' });
    expect((await merge(d.id, closed.id)).body.code).toBe('merge_not_allowed');

    expect((await merge(a.id, 'OPS-999999999')).status).toBe(404);
  });

  it('refuses to merge in a circle, one way or the other', async () => {
    const a = await fileTicket(agent, orgId);
    const b = await fileTicket(agent, orgId);
    const c = await fileTicket(agent, orgId);
    expect(
      (await agent.client.post(`/v1/tickets/${a.id}/merge`, { intoTicketId: b.id })).status,
    ).toBe(200);
    expect(
      (await agent.client.post(`/v1/tickets/${b.id}/merge`, { intoTicketId: c.id })).status,
    ).toBe(200);
    // a already sits under c (flattened); c into a, c into b and b into a would all be circles.
    for (const [from, into] of [
      [c, a],
      [c, b],
      [b, a],
    ] as const) {
      const response = await agent.client.post<ApiErrorBody>(`/v1/tickets/${from.id}/merge`, {
        intoTicketId: into.id,
      });
      expect(response.status, `${from.key} into ${into.key}`).toBe(409);
      expect(response.body.code).toBe('merge_not_allowed');
    }
    const parents = await pool().query<{ id: string; parent_ticket_id: string | null }>(
      'SELECT id, parent_ticket_id FROM ticket WHERE id = ANY($1)',
      [[a.id, b.id, c.id]],
    );
    const parentOf = new Map(parents.rows.map((row) => [row.id, row.parent_ticket_id]));
    // The chain was flattened: both a and b point at c, and c at nothing.
    expect(parentOf.get(a.id)).toBe(c.id);
    expect(parentOf.get(b.id)).toBe(c.id);
    expect(parentOf.get(c.id)).toBeNull();
  });

  it('survives two people merging the same pair in opposite directions at once', async () => {
    const a = await fileTicket(agent, orgId);
    const b = await fileTicket(agent, orgId);
    const [first, second] = await Promise.all([
      agent.client.post<ApiErrorBody>(`/v1/tickets/${a.id}/merge`, { intoTicketId: b.id }),
      agent2.client.post<ApiErrorBody>(`/v1/tickets/${b.id}/merge`, { intoTicketId: a.id }),
    ]);
    expect([first.status, second.status].toSorted()).toEqual([200, 409]);
    const rows = await pool().query<{ status: string; parent_ticket_id: string | null }>(
      'SELECT status, parent_ticket_id FROM ticket WHERE id = ANY($1)',
      [[a.id, b.id]],
    );
    expect(rows.rows.filter((row) => row.status === 'merged')).toHaveLength(1);
    expect(rows.rows.filter((row) => row.parent_ticket_id !== null)).toHaveLength(1);
  });

  it('moves tickets merged earlier onto the new target, so a chain is never deeper than one', async () => {
    const a = await fileTicket(agent, orgId);
    const b = await fileTicket(agent, orgId);
    const c = await fileTicket(agent, orgId);
    await agent.client.post(`/v1/tickets/${a.id}/merge`, { intoTicketId: b.id });
    const result = await agent.client.post<{ target: TicketDetail }>(`/v1/tickets/${b.id}/merge`, {
      intoTicketId: c.id,
    });
    expect(result.status).toBe(200);
    expect(result.body.target.mergedTickets.map((ticket) => ticket.key).toSorted()).toEqual(
      [a.key, b.key].toSorted(),
    );
    const entries = await history(agent, c.id);
    expect(new Set(entries.map((entry) => entry.ticketId))).toEqual(new Set([a.id, b.id, c.id]));
  });
});

describe('listing and paging', () => {
  let paging: { orgId: string; tickets: TicketDetail[] };

  beforeAll(async () => {
    const org = await apiOrg(lead, { name: 'Paging Org' });
    const tickets: TicketDetail[] = [];
    for (let index = 0; index < 7; index += 1) {
      tickets.push(
        await fileTicket(agent, org.id, {
          subject: `Paging ticket ${String(index)}`,
          priority: index % 2 === 0 ? 'P2' : 'P3',
          tags: index === 3 ? ['vip'] : [],
        }),
      );
    }
    paging = { orgId: org.id, tickets };
  });

  async function pageThrough(query: string): Promise<TicketSummary[]> {
    const seen: TicketSummary[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const url: string = `/v1/tickets?orgId=${paging.orgId}&limit=3${query}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const response = await agent.client.get<Page<TicketSummary>>(url);
      expect(response.status).toBe(200);
      seen.push(...response.body.items);
      cursor = response.body.nextCursor;
      if (cursor === null) return seen;
    }
    throw new Error('paging did not end');
  }

  it('pages newest first without skipping or repeating a ticket', async () => {
    const all = await pageThrough('');
    expect(all).toHaveLength(7);
    expect(new Set(all.map((ticket) => ticket.id)).size).toBe(7);
    expect(all.map((ticket) => ticket.id)).toEqual(
      paging.tickets.map((ticket) => ticket.id).toReversed(),
    );
  });

  it('pages by last update and by first-response due date', async () => {
    const first = paging.tickets[0];
    if (!first) throw new Error('no ticket');
    await agent.client.post(`/v1/tickets/${first.id}/notes`, { body: 'touch' });
    const updated = await pageThrough('&sort=updated_desc');
    expect(updated).toHaveLength(7);
    expect(updated[0]?.id).toBe(first.id);
    const byDue = await pageThrough('&sort=due_asc');
    expect(new Set(byDue.map((ticket) => ticket.id)).size).toBe(7);
  });

  it('filters by status, priority, tag and assignee', async () => {
    const [t0, t1, t2, t3] = paging.tickets;
    if (!t0 || !t1 || !t2 || !t3) throw new Error('tickets missing');
    await agent.client.post(`/v1/tickets/${t1.id}/status`, { status: 'open' });
    await agent.client.post(`/v1/tickets/${t2.id}/assign`, { assigneeId: agent.userId });

    const list = async (query: string) =>
      (await agent.client.get<Page<TicketSummary>>(`/v1/tickets?orgId=${paging.orgId}${query}`))
        .body.items;
    expect((await list('&status=open')).map((ticket) => ticket.id)).toEqual([t1.id]);
    expect((await list('&status=open,new')).length).toBe(7);
    expect((await list('&priority=P2')).length).toBe(4);
    expect((await list('&tag=vip')).map((ticket) => ticket.id)).toEqual([t3.id]);
    expect((await list('&assignee=me')).map((ticket) => ticket.id)).toEqual([t2.id]);
    expect((await list(`&assignee=${agent.userId}`)).map((ticket) => ticket.id)).toEqual([t2.id]);
    expect((await list('&assignee=unassigned')).length).toBe(6);
    expect((await list(`&q=${encodeURIComponent(t0.key)}`)).map((ticket) => ticket.id)).toEqual([
      t0.id,
    ]);
  });

  it('lists only overdue open tickets when asked', async () => {
    const org = await apiOrg(lead, { name: 'Overdue Org', tier: 'gold' });
    const late = await fileTicket(agent, org.id, { priority: 'P1' });
    const fine = await fileTicket(agent, org.id, { priority: 'P1' });
    await pool().query(
      `UPDATE ticket SET first_response_due_at = now() - interval '1 hour' WHERE id = $1`,
      [late.id],
    );
    const overdue = await agent.client.get<Page<TicketSummary>>(
      `/v1/tickets?orgId=${org.id}&overdue=true`,
    );
    expect(overdue.body.items.map((ticket) => ticket.id)).toEqual([late.id]);
    // Once it was answered, it is no longer overdue on first response.
    await agent.client.post(`/v1/tickets/${late.id}/replies`, { body: 'Late, but here.' });
    const answered = await agent.client.get<Page<TicketSummary>>(
      `/v1/tickets?orgId=${org.id}&overdue=true`,
    );
    expect(answered.body.items).toEqual([]);
    expect(fine.id).not.toBe(late.id);
  });

  it('answers 400 to a damaged cursor or filter and 200 with an empty page for no match', async () => {
    expect((await agent.client.get('/v1/tickets?cursor=not-a-cursor')).status).toBe(400);
    expect((await agent.client.get('/v1/tickets?status=bogus')).status).toBe(400);
    expect((await agent.client.get('/v1/tickets?limit=0')).status).toBe(400);
    expect((await agent.client.get('/v1/tickets?limit=500')).status).toBe(400);
    const none = await agent.client.get<Page<TicketSummary>>(
      `/v1/tickets?orgId=${paging.orgId}&tag=no-such-tag`,
    );
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ items: [], nextCursor: null });
  });

  it('keeps microsecond order for tickets created in the same millisecond', async () => {
    const org = await apiOrg(lead);
    await pool().query(
      `INSERT INTO ticket (org_id, subject, created_at)
       SELECT $1, 'Burst ' || n, '2026-01-01T00:00:00.000Z'::timestamptz + (n || ' microseconds')::interval
         FROM generate_series(1, 9) AS n`,
      [org.id],
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/v1/tickets?orgId=${org.id}&limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const response = await agent.client.get<Page<TicketSummary>>(url);
      seen.push(...response.body.items.map((ticket) => ticket.subject));
      cursor = response.body.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(
      Array.from({ length: 9 }, (_unused, index) => `Burst ${String(9 - index)}`),
    );
  });
});

describe('search', () => {
  const thaiSubject = 'ไม่สามารถเข้าสู่ระบบได้หลังจากเปลี่ยนรหัสผ่าน';
  const thaiBody = 'ลูกค้าแจ้งว่าระบบแจ้งเตือนไม่ทำงาน ตั้งค่า webhook แล้วแต่ไม่ได้รับข้อมูล';
  const thaiNote = 'ตรวจสอบแล้วพบว่าใช้ SDK เวอร์ชันเก่า ควรให้ลูกค้าอัปเกรดก่อน';
  let searchOrg: string;
  let thai: TicketDetail;
  let english: TicketDetail;

  beforeAll(async () => {
    searchOrg = (await apiOrg(lead, { name: 'Search Org' })).id;
    thai = await fileTicket(agent, searchOrg, { subject: thaiSubject, body: thaiBody });
    await agent.client.post(`/v1/tickets/${thai.id}/notes`, { body: thaiNote });
    english = await fileTicket(agent, searchOrg, {
      subject: 'Invoice for October is missing',
      body: 'We could not find the billing report for last month.',
    });
  });

  const search = async (q: string) =>
    (
      await agent.client.get<Page<TicketSummary>>(
        `/v1/tickets?orgId=${searchOrg}&q=${encodeURIComponent(q)}`,
      )
    ).body.items.map((ticket) => ticket.id);

  it('finds Thai text in the subject, in a message and in an internal note (staff)', async () => {
    expect(await search('เปลี่ยนรหัสผ่าน')).toEqual([thai.id]);
    expect(await search('แจ้งเตือนไม่ทำงาน')).toEqual([thai.id]);
    expect(await search('อัปเกรด')).toEqual([thai.id]);
    expect(await search('ไม่มีคำนี้อยู่เลย')).toEqual([]);
  });

  it('finds English text, ignoring case, in subject and body', async () => {
    expect(await search('INVOICE')).toEqual([english.id]);
    expect(await search('billing report')).toEqual([english.id]);
    expect(await search('october')).toEqual([english.id]);
  });

  it('finds a ticket by its number, with the prefix or without case', async () => {
    expect(await search(thai.key)).toEqual([thai.id]);
    expect(await search(english.key.toLowerCase())).toEqual([english.id]);
  });

  it('treats % and _ as plain characters', async () => {
    expect(await search('100%')).toEqual([]);
    expect(await search('_')).toEqual([]);
    expect(await search('%')).toEqual([]);
  });

  it('does not take SQL from the search text', async () => {
    expect(await search("x'; DROP TABLE ticket; --")).toEqual([]);
    expect((await agent.client.get('/v1/tickets?limit=1')).status).toBe(200);
  });
});

describe('PII reads and OpenAPI', () => {
  it('writes every read of a ticket to the audit log', async () => {
    const ticket = await fileTicket(agent, orgId);
    await agent.client.get(`/v1/tickets/${ticket.key}`);
    await agent.client.get(`/v1/tickets/${ticket.id}/timeline`);
    const reads = await pool().query<{ target_type: string; actor_id: string }>(
      `SELECT target_type, actor_id FROM audit_log WHERE action = 'pii.read' AND target_id = $1`,
      [ticket.id],
    );
    expect(reads.rowCount).toBe(2);
    expect(
      reads.rows.every((row) => row.target_type === 'ticket' && row.actor_id === agent.userId),
    ).toBe(true);
  });

  it('documents every ticketing route with its permission, cookie auth and Zod-derived schemas', async () => {
    interface Operation {
      security?: Record<string, unknown>[];
      'x-required-permissions'?: string[];
      requestBody?: unknown;
      parameters?: { name: string }[];
      responses?: Record<string, unknown>;
    }
    const doc = await h
      .client()
      .get<{ paths: Record<string, Record<string, Operation>> }>('/docs-json');
    const op = (path: string, method: string) => doc.body.paths[path]?.[method];
    for (const [path, method, permissions] of [
      ['/v1/orgs', 'get', ['ticket.read', 'ticket.read.org']],
      ['/v1/orgs', 'post', ['org.manage']],
      ['/v1/orgs/{id}', 'patch', ['org.manage']],
      ['/v1/orgs/{id}', 'delete', ['org.manage']],
      ['/v1/contacts', 'get', ['ticket.read']],
      ['/v1/contacts', 'post', ['org.manage']],
      ['/v1/queues', 'post', ['queue.manage']],
      ['/v1/intents', 'get', ['ticket.read', 'ticket.read.org']],
      ['/v1/intents', 'post', ['intent.manage']],
      ['/v1/sla-policies', 'post', ['sla.manage']],
      ['/v1/business-calendars', 'post', ['sla.manage']],
      ['/v1/ticket-workflow', 'put', ['workflow.manage']],
      ['/v1/tickets', 'get', ['ticket.read', 'ticket.read.org']],
      ['/v1/tickets', 'post', ['ticket.create']],
      ['/v1/tickets/{id}', 'get', ['ticket.read', 'ticket.read.org']],
      ['/v1/tickets/{id}', 'patch', ['ticket.handle']],
      ['/v1/tickets/{id}/status', 'post', ['ticket.handle']],
      ['/v1/tickets/{id}/assign', 'post', ['ticket.handle']],
      ['/v1/tickets/{id}/merge', 'post', ['ticket.handle']],
      ['/v1/tickets/{id}/replies', 'post', ['ticket.reply', 'ticket.reply.own']],
      ['/v1/tickets/{id}/notes', 'post', ['ticket.handle']],
      ['/v1/tickets/{id}/timeline', 'get', ['ticket.read', 'ticket.read.org']],
    ] as const) {
      const operation = op(path, method);
      expect(operation, `${method.toUpperCase()} ${path}`).toBeDefined();
      expect(operation?.['x-required-permissions'], `${method} ${path}`).toEqual(permissions);
      expect(operation?.security).toEqual([{ cookie: [] }]);
    }
    expect(op('/v1/tickets', 'get')?.parameters?.map((p) => p.name)).toEqual(
      expect.arrayContaining(['status', 'priority', 'assignee', 'q', 'sort', 'limit', 'cursor']),
    );
    expect(JSON.stringify(op('/v1/tickets', 'post')?.requestBody)).toContain('subject');
    expect(JSON.stringify(op('/v1/tickets/{id}/merge', 'post')?.requestBody)).toContain(
      'intoTicketId',
    );
    expect(JSON.stringify(op('/v1/tickets/{id}/timeline', 'get')?.responses)).toContain(
      'nextCursor',
    );
  });
});

describe('contacts', () => {
  it('creates, edits, searches and deletes a contact, and audits the reads', async () => {
    const created = await lead.client.post<{ id: string; emails: string[] }>('/v1/contacts', {
      orgId,
      name: 'Somchai Jaidee',
      emails: ['Somchai@Contacts.Example'],
      roleInOrg: 'Engineering manager',
    });
    expect(created.status).toBe(201);
    expect(created.body.emails).toEqual(['somchai@contacts.example']);

    const duplicate = await lead.client.post('/v1/contacts', {
      orgId,
      name: 'Somchai Again',
      emails: ['somchai@contacts.example'],
    });
    expect(duplicate.status).toBe(409);

    const found = await agent.client.get<Page<{ id: string }>>(
      '/v1/contacts?q=somchai%40contacts.example',
    );
    expect(found.body.items.map((contact) => contact.id)).toContain(created.body.id);
    const byName = await agent.client.get<Page<{ id: string }>>(
      `/v1/contacts?orgId=${orgId}&q=Jaidee`,
    );
    expect(byName.body.items.map((contact) => contact.id)).toContain(created.body.id);

    const reads = await pool().query(
      `SELECT 1 FROM audit_log WHERE action = 'pii.read' AND target_type = 'contact' AND actor_id = $1`,
      [agent.userId],
    );
    expect(reads.rowCount).toBeGreaterThanOrEqual(2);

    const patched = await lead.client.patch<{ roleInOrg: string }>(
      `/v1/contacts/${created.body.id}`,
      {
        roleInOrg: 'CTO',
      },
    );
    expect(patched.body.roleInOrg).toBe('CTO');
    // The audit entry holds counts, not the address.
    const audit = await pool().query<{ before: unknown; after: unknown }>(
      `SELECT before, after FROM audit_log WHERE action = 'contact.update' AND target_id = $1`,
      [created.body.id],
    );
    expect(JSON.stringify(audit.rows)).not.toContain('contacts.example');

    expect((await lead.client.delete(`/v1/contacts/${created.body.id}`)).status).toBe(204);
    expect((await lead.client.get(`/v1/contacts/${created.body.id}`)).status).toBe(404);
  });
});
