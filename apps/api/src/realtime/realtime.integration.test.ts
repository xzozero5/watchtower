import {
  REALTIME_CLOSE_CODES,
  REALTIME_PATH,
  type RealtimeEvent,
  type TicketDetail,
} from '@watchtower/shared';
import { SignJWT } from 'jose';
import { WebSocket, type RawData } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import { apiOrg, fileTicket, signIn, sleep, type Persona } from '../testing/ticketing.js';

// The WebSocket feed on the real application: the handshake rules, who hears what, that nothing is
// published for a change that rolled back, and that a ended session closes the socket.

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let clientA: Persona;
let clientB: Persona;
let orgA: string;
let orgB: string;

const sockets: Socket[] = [];

beforeAll(async () => {
  h = await startHarness({ env: { REALTIME_REVALIDATE_SECONDS: '1' } });
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  orgA = (await apiOrg(lead, { name: 'Realtime A' })).id;
  orgB = (await apiOrg(lead, { name: 'Realtime B' })).id;
  clientA = await signIn(h, 'client', orgA);
  clientB = await signIn(h, 'client', orgB);
});

afterAll(async () => {
  for (const socket of sockets) socket.ws.terminate();
  await h.close();
});

type Frame = Record<string, unknown> & { type: string };

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
}

class Socket {
  readonly frames: Frame[] = [];
  closed: { code: number; reason: string } | undefined;

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      this.frames.push(JSON.parse(rawToString(data)) as Frame);
    });
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
    });
  }

  events(): RealtimeEvent[] {
    return this.frames.filter((frame) => frame.type !== 'ready') as unknown as RealtimeEvent[];
  }

  async waitFor(predicate: (frames: Frame[]) => boolean, ms = 4000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (predicate(this.frames)) return;
      await sleep(25);
    }
    throw new Error(`timed out; received ${JSON.stringify(this.frames)}`);
  }

  async waitForClose(ms = 6000): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.closed) return this.closed;
      await sleep(25);
    }
    throw new Error('the socket did not close');
  }
}

function url(): string {
  return `${h.base.replace('http://', 'ws://')}${REALTIME_PATH}`;
}

function cookieOf(who: Persona): string {
  return [...who.client.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

interface ConnectOptions {
  origin?: string | null;
  cookie?: string | null;
  path?: string;
}

/** Opens a socket like a browser would: the cookie of the signed-in client and the web app Origin. */
async function connect(who: Persona, options: ConnectOptions = {}): Promise<Socket> {
  const origin = options.origin === undefined ? new URL(h.config.APP_URL).origin : options.origin;
  const cookie = options.cookie === undefined ? cookieOf(who) : options.cookie;
  const ws = new WebSocket(url().replace(REALTIME_PATH, options.path ?? REALTIME_PATH), {
    headers: {
      ...(origin === null ? {} : { origin }),
      ...(cookie === null ? {} : { cookie }),
    },
  });
  const socket = new Socket(ws);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      resolve();
    });
    ws.once('unexpected-response', (_request, response) => {
      reject(new Error(`handshake refused: ${String(response.statusCode)}`));
    });
    ws.once('error', reject);
  });
  await socket.waitFor((frames) => frames.some((frame) => frame.type === 'ready'));
  return socket;
}

async function refusedWith(who: Persona, options: ConnectOptions): Promise<number> {
  try {
    await connect(who, options);
  } catch (error) {
    const match = /handshake refused: (\d+)/.exec(error instanceof Error ? error.message : '');
    if (match) return Number(match[1]);
    throw error;
  }
  return 101;
}

describe('the handshake', () => {
  it('accepts a signed-in user from the web app and says who they are in the first frame', async () => {
    const staff = await connect(agent);
    expect(staff.frames[0]).toMatchObject({ type: 'ready', audience: 'staff' });
    const client = await connect(clientA);
    expect(client.frames[0]).toMatchObject({ type: 'ready', audience: 'client' });
    expect(typeof client.frames[0]?.accessExpiresAt).toBe('string');
  });

  it('refuses a request without a session cookie, with a bad one, or after logout', async () => {
    expect(await refusedWith(agent, { cookie: null })).toBe(401);
    expect(await refusedWith(agent, { cookie: 'wt_at=not-a-jwt' })).toBe(401);
    // A repeated access cookie is never ours (C-6): refused even when both copies are valid.
    const access = agent.client.cookie('wt_at') ?? '';
    expect(await refusedWith(agent, { cookie: `wt_at=${access}; wt_at=${access}` })).toBe(401);
    expect(
      await refusedWith(agent, { cookie: `wt_rt=${agent.client.cookie('wt_rt') ?? ''}` }),
    ).toBe(401);

    const leaver = await signIn(h, 'agent');
    const cookie = cookieOf(leaver);
    expect((await leaver.client.post('/v1/auth/logout')).status).toBeLessThan(300);
    expect(await refusedWith(leaver, { cookie })).toBe(401);
  });

  it('refuses a missing or foreign Origin even with a valid cookie (cross-site WebSocket hijacking)', async () => {
    expect(await refusedWith(agent, { origin: null })).toBe(403);
    expect(await refusedWith(agent, { origin: 'https://evil.example' })).toBe(403);
    expect(await refusedWith(agent, { origin: 'null' })).toBe(403);
    expect(
      await refusedWith(agent, { origin: `${new URL(h.config.APP_URL).origin}.evil.example` }),
    ).toBe(403);
    // The api's own origin is not the web app either.
    expect(await refusedWith(agent, { origin: new URL(h.config.API_URL).origin })).toBe(403);
  });

  it('refuses any other path', async () => {
    expect(await refusedWith(agent, { path: '/v1/realtime/other' })).toBe(404);
    expect(await refusedWith(agent, { path: '/' })).toBe(404);
  });

  it('refuses a user who may not read tickets', async () => {
    const roles = await head.client.get<{ roles: { role: string; permissions: string[] }[] }>(
      '/v1/rbac/roles',
    );
    const clientRole = roles.body.roles.find((entry) => entry.role === 'client');
    const without = (clientRole?.permissions ?? []).filter(
      (permission) => permission !== 'ticket.read.org',
    );
    const outsider = await signIn(h, 'client', orgA);
    expect(
      (await head.client.put('/v1/rbac/roles/client/permissions', { permissions: without })).status,
    ).toBe(200);
    try {
      expect(await refusedWith(outsider, {})).toBe(403);
    } finally {
      await head.client.put('/v1/rbac/roles/client/permissions', {
        permissions: clientRole?.permissions ?? [],
      });
    }
  });

  it('closes a socket that sends anything: the feed is one-way', async () => {
    const socket = await connect(agent);
    socket.ws.send('hello');
    expect((await socket.waitForClose()).code).toBe(1008);
  });

  it('keeps at most five sockets per user, closing the oldest', async () => {
    const who = await signIn(h, 'agent');
    const opened: Socket[] = [];
    for (let index = 0; index < 6; index += 1) opened.push(await connect(who));
    const first = opened[0];
    expect((await first?.waitForClose())?.code).toBe(REALTIME_CLOSE_CODES.tooManyConnections);
    await sleep(100);
    expect(opened.slice(1).every((socket) => socket.closed === undefined)).toBe(true);
  });
});

describe('who hears what', () => {
  it('tells staff about everything and a client only about their own organization', async () => {
    const staff = await connect(agent);
    const a = await connect(clientA);
    const b = await connect(clientB);

    const ticket = await fileTicket(agent, orgA, {
      subject: 'Heard by A',
      assigneeId: agent.userId,
    });
    await staff.waitFor((frames) => frames.some((frame) => frame.type === 'message.created'));
    await a.waitFor((frames) => frames.some((frame) => frame.type === 'message.created'));

    expect(staff.events().map((event) => event.type)).toEqual([
      'ticket.created',
      'message.created',
    ]);
    const createdForStaff = staff.events()[0];
    expect(createdForStaff).toMatchObject({
      type: 'ticket.created',
      ticketId: ticket.id,
      ticketKey: ticket.key,
      orgId: orgA,
      data: { subject: 'Heard by A', status: 'new', assigneeId: agent.userId },
    });

    const createdForClient = a.events()[0];
    expect(createdForClient).toMatchObject({ type: 'ticket.created', ticketId: ticket.id });
    // The assignee is a staff detail: the client's copy does not carry it.
    expect(JSON.stringify(createdForClient)).not.toContain(agent.userId);
    expect(b.events()).toEqual([]);
  });

  it('never sends a client the event of an internal note, but sends staff and keeps order', async () => {
    const staff = await connect(agent);
    const a = await connect(clientA);
    const ticket = await fileTicket(agent, orgA);
    await a.waitFor(
      (frames) => frames.filter((frame) => frame.type === 'message.created').length === 1,
    );

    await agent.client.post(`/v1/tickets/${ticket.id}/notes`, { body: 'internal-ws-note-3310' });
    await agent.client.post(`/v1/tickets/${ticket.id}/replies`, { body: 'public-ws-reply-3310' });
    await staff.waitFor(
      (frames) => frames.filter((frame) => frame.type === 'message.created').length === 3,
    );
    await a.waitFor(
      (frames) => frames.filter((frame) => frame.type === 'message.created').length === 2,
    );
    await sleep(300);

    const visibilities = (socket: Socket) =>
      socket
        .events()
        .flatMap((event) => (event.type === 'message.created' ? [event.data.visibility] : []));
    expect(visibilities(staff)).toEqual(['public', 'internal', 'public']);
    expect(visibilities(a)).toEqual(['public', 'public']);
    expect(JSON.stringify(a.frames)).not.toContain('internal-ws-note');
    expect(JSON.stringify(staff.frames)).not.toContain('internal-ws-note'); // events carry no text at all
  });

  it('tells a client about a status change but not about an assignment or a tag', async () => {
    const a = await connect(clientA);
    const staff = await connect(agent);
    const ticket = await fileTicket(agent, orgA);
    await a.waitFor((frames) => frames.some((frame) => frame.type === 'message.created'));
    const seenBefore = a.events().length;

    await agent.client.post(`/v1/tickets/${ticket.id}/assign`, { assigneeId: agent.userId });
    await agent.client.patch(`/v1/tickets/${ticket.id}`, { tags: ['internal'] });
    await agent.client.post(`/v1/tickets/${ticket.id}/status`, { status: 'open' });
    await staff.waitFor(
      (frames) => frames.filter((frame) => frame.type === 'ticket.updated').length === 3,
    );
    await a.waitFor((frames) => frames.some((frame) => frame.type === 'ticket.updated'));
    await sleep(300);

    const changes = (socket: Socket) =>
      socket
        .events()
        .flatMap((event) => (event.type === 'ticket.updated' ? [event.data.changed] : []));
    expect(changes(staff)).toEqual([['assignee'], ['tags'], ['status']]);
    expect(changes(a)).toEqual([['status']]);
    expect(a.events()).toHaveLength(seenBefore + 1);
  });

  it('publishes only after the commit: the data is readable when the event arrives', async () => {
    const staff = await connect(agent);
    const created = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        agent.client.post<TicketDetail>('/v1/tickets', {
          orgId: orgA,
          subject: `Commit order ${String(index)}`,
          body: 'x',
          requester: {
            email: `commit-${String(index)}-${Date.now().toString(36)}@example.com`,
            name: 'C',
          },
        }),
      ),
    );
    expect(created.every((response) => response.status === 201)).toBe(true);
    await staff.waitFor(
      (frames) => frames.filter((frame) => frame.type === 'ticket.created').length >= 8,
    );
    for (const event of staff.events()) {
      if (event.type !== 'ticket.created') continue;
      const read = await agent.client.get<TicketDetail>(`/v1/tickets/${event.ticketId}`);
      expect(read.status, event.ticketKey).toBe(200);
    }
  });

  it('publishes nothing for a change that rolled back', async () => {
    const staff = await connect(agent);
    const ticket = await fileTicket(agent, orgA);
    await staff.waitFor(
      (frames) => frames.filter((frame) => frame.type === 'message.created').length === 1,
    );
    const before = staff.events().length;

    // The reply is written, then the status change is refused: the whole request rolls back.
    const refused = await agent.client.post(`/v1/tickets/${ticket.id}/replies`, {
      body: 'rolled back',
      setStatus: 'merged',
    });
    expect(refused.status).toBe(409);
    const refusedStatus = await agent.client.post(`/v1/tickets/${ticket.id}/status`, {
      status: 'new',
    });
    expect(refusedStatus.status).toBe(409);
    await sleep(500);
    expect(staff.events()).toHaveLength(before);

    // And the feed is still alive afterwards.
    await agent.client.post(`/v1/tickets/${ticket.id}/notes`, { body: 'still alive' });
    await staff.waitFor((frames) => frames.length > before + 1);
    expect(staff.events().at(-1)).toMatchObject({ type: 'message.created' });
  });
});

describe('a session that ends closes the socket', () => {
  it('closes with 4401 after a forced logout, within the revalidation interval', async () => {
    const victim = await signIn(h, 'agent');
    const socket = await connect(victim);
    expect((await head.client.post(`/v1/users/${victim.userId}/force-logout`)).status).toBe(200);
    const closed = await socket.waitForClose();
    expect(closed.code).toBe(REALTIME_CLOSE_CODES.unauthenticated);
    expect(closed.reason).toBe('session_ended');
  });

  it('closes with 4401 when the user is disabled', async () => {
    const victim = await signIn(h, 'agent');
    const socket = await connect(victim);
    expect(
      (await head.client.patch(`/v1/users/${victim.userId}`, { status: 'disabled' })).status,
    ).toBe(200);
    expect((await socket.waitForClose()).code).toBe(REALTIME_CLOSE_CODES.unauthenticated);
  });

  it('closes with 4401 when the user signs out', async () => {
    const leaver = await signIn(h, 'agent');
    const socket = await connect(leaver);
    await leaver.client.post('/v1/auth/logout');
    expect((await socket.waitForClose()).code).toBe(REALTIME_CLOSE_CODES.unauthenticated);
  });

  it('closes with 4403 when the permission to read tickets is taken away', async () => {
    const roles = await head.client.get<{ roles: { role: string; permissions: string[] }[] }>(
      '/v1/rbac/roles',
    );
    const clientRole = roles.body.roles.find((entry) => entry.role === 'client');
    const listener = await signIn(h, 'client', orgB);
    const socket = await connect(listener);
    const without = (clientRole?.permissions ?? []).filter(
      (permission) => permission !== 'ticket.read.org',
    );
    await head.client.put('/v1/rbac/roles/client/permissions', { permissions: without });
    try {
      expect((await socket.waitForClose()).code).toBe(REALTIME_CLOSE_CODES.forbidden);
    } finally {
      await head.client.put('/v1/rbac/roles/client/permissions', {
        permissions: clientRole?.permissions ?? [],
      });
    }
  });

  it('closes with 4401 when the access token runs out, so the client refreshes and reconnects', async () => {
    const who = await signIn(h, 'agent');
    const token = await new SignJWT({ sid: who.session.sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('watchtower')
      .setAudience('watchtower:api')
      .setSubject(who.userId)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 2)
      .sign(new TextEncoder().encode(h.config.JWT_SECRET));
    const socket = await connect(who, { cookie: `wt_at=${token}` });
    const closed = await socket.waitForClose(8000);
    expect(closed).toMatchObject({
      code: REALTIME_CLOSE_CODES.unauthenticated,
      reason: 'access_token_expired',
    });
  });

  it('keeps the socket of a user whose session is fine', async () => {
    const socket = await connect(agent);
    await sleep(2500);
    expect(socket.closed).toBeUndefined();
  });
});
