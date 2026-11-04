import {
  REALTIME_PATH,
  type AuditLogEntry,
  type NotificationPage,
  type NotificationPreferences,
  type RealtimeEvent,
  type TicketDetail,
} from '@watchtower/shared';
import { WebSocket, type RawData } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import {
  apiOrg,
  apiQueue,
  fileTicket,
  signIn,
  sleep,
  type ApiErrorBody,
  type Persona,
} from '../testing/ticketing.js';
import { ShiftAlertsService } from './shift-alerts.service.js';

// In-app notifications on the real application (T-105): who is told, that a person reads only their
// own, that a client sees nothing, and what the realtime feed carries.

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let otherAgent: Persona;
let client: Persona;
let orgId: string;

const sockets: WebSocket[] = [];

beforeAll(async () => {
  h = await startHarness();
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  otherAgent = await signIn(h, 'agent');
  orgId = (await apiOrg(lead, { name: 'Notify Org' })).id;
  client = await signIn(h, 'client', orgId);
});

afterAll(async () => {
  for (const socket of sockets) socket.terminate();
  await h.close();
});

const list = (who: Persona, query = '') =>
  who.client.get<NotificationPage & ApiErrorBody>(`/v1/notifications${query}`);

async function forTicket(who: Persona, key: string): Promise<NotificationPage['items']> {
  const page = await list(who, '?limit=100');
  return page.body.items.filter((item) => item.ticket?.key === key);
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
}

/** A staff socket like a browser's: the cookie of the signed-in user and the web app Origin. */
async function listen(who: Persona): Promise<RealtimeEvent[]> {
  const cookie = [...who.client.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  const ws = new WebSocket(`${h.base.replace('http://', 'ws://')}${REALTIME_PATH}`, {
    headers: { origin: new URL(h.config.APP_URL).origin, cookie },
  });
  sockets.push(ws);
  const events: RealtimeEvent[] = [];
  const state = { ready: false };
  ws.on('message', (data) => {
    const frame = JSON.parse(rawToString(data)) as { type: string };
    if (frame.type === 'ready') state.ready = true;
    else events.push(frame as unknown as RealtimeEvent);
  });
  const deadline = Date.now() + 4000;
  while (!state.ready && Date.now() < deadline) await sleep(20);
  if (!state.ready) throw new Error('socket not ready');
  return events;
}

async function until<T>(read: () => T | undefined, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await sleep(25);
  }
  throw new Error('timed out');
}

describe('who is told about a P1 ticket', () => {
  it('tells the leads and heads and the assignee, not the person who filed it, not other agents', async () => {
    const ticket = await fileTicket(agent, orgId, {
      priority: 'P1',
      assigneeId: otherAgent.userId,
    });

    for (const who of [lead, head, otherAgent]) {
      const items = await forTicket(who, ticket.key);
      expect(items, who.email).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: 'ticket.p1',
        severity: 'critical',
        orgId,
        channel: 'portal',
        readAt: null,
        ticket: { key: ticket.key, subject: ticket.subject, priority: 'P1' },
      });
    }
    // The person who filed it knows; a P1 for the assignee is one alert, not two.
    expect(await forTicket(agent, ticket.key)).toHaveLength(0);
    expect(await forTicket(otherAgent, ticket.key)).toHaveLength(1);
  });

  it('tells the members of the ticket queue', async () => {
    const queue = await apiQueue(lead, {
      name: `P1 queue ${Date.now().toString()}`,
      assignmentMode: 'manual',
      memberIds: [otherAgent.userId],
    });
    const ticket = await fileTicket(lead, orgId, { priority: 'P1', queueId: queue.id });
    const [mine] = await forTicket(otherAgent, ticket.key);
    expect(mine).toMatchObject({ kind: 'ticket.p1', queueId: queue.id });
  });

  it('tells nobody about a P3 ticket, and tells the leads when a ticket is raised to P1, once', async () => {
    const ticket = await fileTicket(agent, orgId, { priority: 'P3' });
    expect(await forTicket(lead, ticket.key)).toHaveLength(0);

    const raised = await agent.client.patch<TicketDetail>(`/v1/tickets/${ticket.key}`, {
      priority: 'P1',
    });
    expect(raised.status).toBe(200);
    expect(await forTicket(lead, ticket.key)).toHaveLength(1);
    expect(await forTicket(head, ticket.key)).toHaveLength(1);
    // Down and up again: the same person is not told twice about the same ticket.
    await agent.client.patch(`/v1/tickets/${ticket.key}`, { priority: 'P2' });
    await agent.client.patch(`/v1/tickets/${ticket.key}`, { priority: 'P1' });
    expect(await forTicket(lead, ticket.key)).toHaveLength(1);
  });
});

describe('assignment', () => {
  it('tells the new assignee, but not when they assign it to themselves', async () => {
    const ticket = await fileTicket(lead, orgId, { priority: 'P3' });
    const handed = await lead.client.post(`/v1/tickets/${ticket.key}/assign`, {
      assigneeId: otherAgent.userId,
    });
    expect(handed.status).toBe(200);
    const [note] = await forTicket(otherAgent, ticket.key);
    expect(note).toMatchObject({ kind: 'ticket.assigned', severity: 'normal' });

    const own = await fileTicket(lead, orgId, { priority: 'P3' });
    await otherAgent.client.post(`/v1/tickets/${own.key}/assign`, {
      assigneeId: otherAgent.userId,
    });
    expect(await forTicket(otherAgent, own.key)).toHaveLength(0);
  });
});

describe('reading your own', () => {
  it('lists only the caller, counts unread, pages by cursor and marks read', async () => {
    const reader = await signIn(h, 'lead');
    const first = await fileTicket(agent, orgId, { priority: 'P1' });
    const second = await fileTicket(agent, orgId, { priority: 'P1' });

    const all = await list(reader, '?limit=100');
    expect(all.status).toBe(200);
    expect(all.body.items.map((item) => item.ticket?.key)).toEqual([second.key, first.key]);
    expect(all.body.unreadCount).toBe(2);

    const page = await list(reader, '?limit=1');
    expect(page.body.items).toHaveLength(1);
    expect(page.body.nextCursor).not.toBeNull();
    const next = await list(reader, `?limit=1&cursor=${page.body.nextCursor ?? ''}`);
    expect(next.body.items.map((item) => item.ticket?.key)).toEqual([first.key]);
    expect(next.body.nextCursor).toBeNull();

    const newest = all.body.items[0];
    const read = await reader.client.post(`/v1/notifications/${newest?.id ?? ''}/read`);
    expect(read.status).toBe(204);
    const again = await reader.client.post(`/v1/notifications/${newest?.id ?? ''}/read`);
    expect(again.status).toBe(204);
    const unread = await list(reader, '?unread=true');
    expect(unread.body.items.map((item) => item.ticket?.key)).toEqual([first.key]);
    expect(unread.body.unreadCount).toBe(1);

    const readAll = await reader.client.post<{ updated: number }>('/v1/notifications/read-all');
    expect(readAll.body).toEqual({ updated: 1 });
    expect((await list(reader)).body.unreadCount).toBe(0);
  });

  it("answers 404 for another person's notification and leaves it unread", async () => {
    const owner = await signIn(h, 'lead');
    const intruder = await signIn(h, 'lead');
    const ticket = await fileTicket(agent, orgId, { priority: 'P1' });
    const [theirs] = await forTicket(owner, ticket.key);
    const response = await intruder.client.post<ApiErrorBody>(
      `/v1/notifications/${theirs?.id ?? ''}/read`,
    );
    expect(response.status).toBe(404);
    const [still] = await forTicket(owner, ticket.key);
    expect(still?.readAt).toBeNull();
    expect((await list(intruder)).body.items.map((item) => item.id)).not.toContain(theirs?.id);
  });

  it('writes the marks to the audit log', async () => {
    const reader = await signIn(h, 'lead');
    await fileTicket(agent, orgId, { priority: 'P1' });
    const [mine] = (await list(reader)).body.items;
    await reader.client.post(`/v1/notifications/${mine?.id ?? ''}/read`);
    await reader.client.put('/v1/notifications/preferences', {
      preferences: [{ kind: 'ticket.assigned', inApp: false }],
    });
    const log = await head.client.get<{ entries: AuditLogEntry[] }>(
      `/v1/audit-logs?actorId=${reader.userId}&limit=50`,
    );
    const actions = log.body.entries.map((entry) => entry.action);
    expect(actions).toContain('notification.read');
    expect(actions).toContain('notification.preferences.set');
  });
});

describe('a client', () => {
  it('is refused every notification route', async () => {
    for (const [method, path] of [
      ['GET', '/v1/notifications'],
      ['GET', '/v1/notifications/preferences'],
      ['PUT', '/v1/notifications/preferences'],
      ['POST', '/v1/notifications/read-all'],
      ['POST', '/v1/notifications/6f1d3b3e-5f55-4f0a-9a52-3a7d3e1d1a11/read'],
    ] as const) {
      const response = await client.client.request(method, path, {
        ...(method === 'PUT'
          ? { body: { preferences: [{ kind: 'ticket.assigned', inApp: true }] } }
          : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });

  it('is not signed in: 401', async () => {
    const response = await h.client().get('/v1/notifications');
    expect(response.status).toBe(401);
  });

  it('hears no notification on the realtime feed, even for a P1 ticket of its own organization', async () => {
    const heard = await listen(client);
    const ticket = await fileTicket(lead, orgId, { priority: 'P1' });
    // The client does hear that its own ticket was created (so the feed works) ...
    await until(() =>
      heard.find(
        (candidate) => candidate.type === 'ticket.created' && candidate.ticketKey === ticket.key,
      ),
    );
    await sleep(150);
    // ... and never a notification, which is internal.
    expect(heard.filter((candidate) => candidate.type === 'notification.created')).toEqual([]);
  });
});

describe('preferences', () => {
  it('lists every kind, on by default, and marks the mandatory one', async () => {
    const who = await signIn(h, 'agent');
    const response = await who.client.get<NotificationPreferences>('/v1/notifications/preferences');
    expect(response.status).toBe(200);
    expect(
      response.body.preferences.map((entry) => [entry.kind, entry.inApp, entry.mandatory]),
    ).toEqual([
      ['ticket.p1', true, true],
      ['ticket.assigned', true, false],
      ['ticket.escalation_requested', true, false],
      ['shift.handoff_overdue', true, false],
      ['shift.no_show', true, false],
      ['alert.fired', true, false],
      ['alert.escalated', true, false],
      // T-176: kinds about the system (sent to heads only), listed for everyone and off-able.
      ['ops.smtp_auth_failed', true, false],
      ['ops.upload_quota_global', true, false],
      ['ops.outbox_dead', true, false],
    ]);
  });

  it('turns a kind off: no notification is made for it any more', async () => {
    const quiet = await signIn(h, 'agent');
    const set = await quiet.client.put<NotificationPreferences>('/v1/notifications/preferences', {
      preferences: [{ kind: 'ticket.assigned', inApp: false }],
    });
    expect(set.status).toBe(200);
    expect(set.body.preferences.find((entry) => entry.kind === 'ticket.assigned')?.inApp).toBe(
      false,
    );

    const ticket = await fileTicket(lead, orgId, { priority: 'P3' });
    await lead.client.post(`/v1/tickets/${ticket.key}/assign`, {
      assigneeId: quiet.userId,
    });
    expect(await forTicket(quiet, ticket.key)).toHaveLength(0);
  });

  it('refuses to turn P1 off, a duplicate kind and an unknown kind', async () => {
    const who = await signIn(h, 'agent');
    for (const preferences of [
      [{ kind: 'ticket.p1', inApp: false }],
      [
        { kind: 'ticket.assigned', inApp: false },
        { kind: 'ticket.assigned', inApp: true },
      ],
      [{ kind: 'ticket.nope', inApp: false }],
      [],
    ]) {
      const response = await who.client.put('/v1/notifications/preferences', { preferences });
      expect(response.status, JSON.stringify(preferences)).toBe(400);
    }
  });
});

describe('realtime', () => {
  it('sends the notification to its recipient only, with org, queue and channel', async () => {
    const recipient = await signIn(h, 'lead');
    const bystander = await signIn(h, 'lead');
    const heard = await listen(recipient);
    const overheard = await listen(bystander);
    const queue = await apiQueue(lead, {
      name: `RT queue ${Date.now().toString()}`,
      assignmentMode: 'manual',
      memberIds: [],
    });
    const ticket = await fileTicket(agent, orgId, { priority: 'P1', queueId: queue.id });

    const event = await until(() =>
      heard.find((candidate) => candidate.type === 'notification.created'),
    );
    expect(event).toMatchObject({
      type: 'notification.created',
      recipientId: recipient.userId,
      data: {
        kind: 'ticket.p1',
        severity: 'critical',
        orgId,
        queueId: queue.id,
        channel: 'portal',
        ticketKey: ticket.key,
      },
    });
    // The bystander (also a lead) gets their own notification event, never the recipient's.
    await sleep(150);
    const theirs = overheard.filter((candidate) => candidate.type === 'notification.created');
    expect(theirs.length).toBeGreaterThan(0);
    for (const candidate of theirs) {
      expect(candidate).toMatchObject({ recipientId: bystander.userId });
    }
    // The text of the ticket never travels on the notification.
    expect(JSON.stringify(event)).not.toContain(ticket.subject);
  });

  it('carries the channel on ticket events so a filtered pill can count them', async () => {
    const watcher = await signIn(h, 'agent');
    const heard = await listen(watcher);
    const ticket = await fileTicket(agent, orgId, { priority: 'P3' });
    const created = await until(() =>
      heard.find(
        (candidate) => candidate.type === 'ticket.created' && candidate.ticketKey === ticket.key,
      ),
    );
    expect(created).toMatchObject({ orgId, data: { channel: 'portal' } });
  });
});

describe('shift alerts for leads (hook for T-111)', () => {
  it('tells every lead and head about a no-show and an overdue handoff, once, and not agents', async () => {
    const alerts = h.app.get(ShiftAlertsService);
    const entryId = crypto.randomUUID();
    const handoffId = crypto.randomUUID();
    const overview = {
      noShows: [{ id: entryId }],
      unacknowledged: {
        items: [
          { handoffId, overdue: true },
          { handoffId, overdue: true },
          { handoffId: crypto.randomUUID(), overdue: false },
        ],
      },
    };
    const made = await alerts.raise(overview);
    expect(made).toBeGreaterThanOrEqual(4);
    expect(await alerts.raise(overview)).toBe(0);

    const mine = (await list(lead, '?limit=100')).body.items.filter((item) =>
      item.kind.startsWith('shift.'),
    );
    expect(mine.map((item) => item.kind).toSorted()).toEqual([
      'shift.handoff_overdue',
      'shift.no_show',
    ]);
    expect(mine.find((item) => item.kind === 'shift.handoff_overdue')?.data).toEqual({
      handoffId,
      count: 2,
    });
    expect(mine.every((item) => item.ticket === null && item.severity === 'high')).toBe(true);
    expect(
      (await list(agent, '?limit=100')).body.items.filter((item) => item.kind.startsWith('shift.')),
    ).toHaveLength(0);
    expect(
      (await list(head, '?limit=100')).body.items.filter((item) => item.kind.startsWith('shift.')),
    ).toHaveLength(2);
  });
});
