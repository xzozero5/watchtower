import { randomBytes, randomUUID } from 'node:crypto';

import { DevMockLlmProvider, type LlmProvider } from '@watchtower/ai';
import { createDatabase, schema, type Database } from '@watchtower/db';
import {
  DEFAULT_ROLE_PERMISSIONS,
  type AssistantReply,
  type TicketDetail,
} from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_LLM } from '../ai/ai-runtime.js';
import type { Principal } from '../auth/principal.js';
import { RbacService } from '../rbac/rbac.service.js';
import { KbService } from '../kb/kb.service.js';
import { BriefService } from '../shifts/brief.service.js';
import { SlaRemaining } from '../tickets/sla-remaining.js';
import { TICKET_KEYS, type TicketKeys } from '../tickets/ticket-keys.js';
import { TicketReader } from '../tickets/ticket-reader.js';
import { ToolRunner } from '../tools/tool-runner.service.js';
import { startHarness, type Harness } from '../testing/harness.js';
import { apiOrg, fileTicket, signIn, type Persona } from '../testing/ticketing.js';
import { buildAssistantTools } from './assistant-tools.js';
import { leaksBeyondRoute } from './tool-parity.js';
import { runReadOnly } from './read-only.js';

// T-401 on the real module graph and Postgres (restricted role): who may call the assistant, how refs of a context are
// dropped, the read-only scope of tool handlers, and tool output against the GET route. The model is the dev mock.
const net = disableNetConnect();

let h: Harness;
let agent: Persona;
let lead: Persona;
let dev: Persona;
let client: Persona;
let orgId: string;
let ticket: TicketDetail;
let database: Database;
const suffix = `x${randomBytes(3).toString('hex')}`;
const owner = () => h.db.owner.pool;

/** Roles are cached for a few seconds; a test that changes them drops the cache. */
const changeRoles = async (query: string, params: unknown[] = []): Promise<void> => {
  await owner().query(query, params);
  h.app.get(RbacService, { strict: false }).invalidate();
};

/** SQLSTATE of a failed query (Drizzle wraps the driver error and keeps it as `cause`). */
const sqlState = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
  } catch (error) {
    const own = (error as { code?: string }).code;
    return own ?? (error as { cause?: { code?: string } }).cause?.code;
  }
  return undefined;
};

const mock: LlmProvider = new DevMockLlmProvider();

beforeAll(async () => {
  h = await startHarness({ overrides: [{ token: API_LLM, value: mock }] });
  agent = await signIn(h, 'agent');
  lead = await signIn(h, 'lead');
  dev = await signIn(h, 'dev');
  orgId = (await apiOrg(lead, { name: `Foundation Org ${suffix}` })).id;
  client = await signIn(h, 'client', orgId);
  ticket = await fileTicket(agent, orgId, { subject: 'Cannot sign in to the dashboard' });
  database = createDatabase({ url: h.db.appUrl, max: 4 });
});

afterAll(async () => {
  await database.close();
  await h.close();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

const ask = (who: Persona, text: string, extra: Record<string, unknown> = {}) =>
  who.client.post<AssistantReply>('/v1/assistant/messages', { text, ...extra });

describe('assistant.use and the roles the code refuses', () => {
  it('lets agent, lead and dev in, each by assistant.use', async () => {
    for (const who of [agent, lead, dev]) {
      expect((await who.client.get('/v1/assistant/starters')).status, who.email).toBe(200);
    }
  });

  it('answers 403 to a staff member whose role does not hold assistant.use', async () => {
    await changeRoles(
      `DELETE FROM role_permissions WHERE role = 'agent' AND permission = 'assistant.use'`,
    );
    try {
      const who = await signIn(h, 'agent');
      expect((await who.client.get('/v1/assistant/starters')).status).toBe(403);
      expect((await ask(who, 'hi')).status).toBe(403);
    } finally {
      await changeRoles(
        `INSERT INTO role_permissions (role, permission) VALUES ('agent', 'assistant.use') ON CONFLICT DO NOTHING`,
      );
    }
  });

  it('answers a client 403 on every route even when assistant.use has been granted to the client role', async () => {
    await changeRoles(
      `INSERT INTO role_permissions (role, permission) VALUES ('client', 'assistant.use') ON CONFLICT DO NOTHING`,
    );
    // The grant is real: the permission is on the client's principal, and only the code refuses it.
    const granted = await h.app
      .get(RbacService, { strict: false })
      .effectivePermissions('client', []);
    expect(granted.has('assistant.use')).toBe(true);
    try {
      const who = await signIn(h, 'client', orgId);
      const id = '3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a11';
      expect((await who.client.get('/v1/assistant/starters')).status).toBe(403);
      expect((await ask(who, 'hello', { context: { ticket: ticket.key } })).status).toBe(403);
      expect((await who.client.post(`/v1/assistant/proposals/${id}/confirm`)).status).toBe(403);
      expect((await who.client.post(`/v1/assistant/proposals/${id}/reject`)).status).toBe(403);
      expect((await who.client.delete(`/v1/assistant/conversations/${id}`)).status).toBe(403);
      // The refusal is written to the audit log as a denial of that person.
      const denied = await owner().query(
        `SELECT 1 FROM audit_log WHERE actor_id = $1 AND outcome = 'denied' AND metadata->>'workspaceOnly' = 'true'`,
        [who.userId],
      );
      expect(denied.rowCount).toBeGreaterThan(0);
    } finally {
      await changeRoles(
        `DELETE FROM role_permissions WHERE role = 'client' AND permission = 'assistant.use'`,
      );
    }
    expect((await client.client.get('/v1/assistant/starters')).status).toBe(403);
  });
});

describe('refs of the context', () => {
  const dropped = async (who: Persona, context: Record<string, unknown>) => {
    const response = await ask(who, 'what is this', { context });
    expect(response.status).toBe(200);
    const row = await owner().query<{ metadata: { contextDropped: Record<string, number> } }>(
      `SELECT metadata FROM audit_log WHERE action = 'assistant.message' AND target_id = $1`,
      [response.body.conversationId],
    );
    return { reply: response.body, dropped: row.rows[0]?.metadata.contextDropped };
  };

  it('drops a ref that does not exist and a ref the person may not read the same way, recording only kinds and counts', async () => {
    // A developer reads tickets masked but has no `ticket.read`: an org is a real thing they may not read.
    const forbidden = await dropped(dev, { entity: { kind: 'org', ref: orgId } });
    const missing = await dropped(dev, { entity: { kind: 'org', ref: randomUUID() } });
    expect(forbidden.dropped).toEqual({ org: 1 });
    expect(missing.dropped).toEqual(forbidden.dropped);
    expect({ ...forbidden.reply, conversationId: '', messageId: '' }).toEqual({
      ...missing.reply,
      conversationId: '',
      messageId: '',
    });
    // The ref the person sent is not in the audit row.
    const rows = await owner().query(
      `SELECT 1 FROM audit_log WHERE action = 'assistant.message' AND metadata::text LIKE $1`,
      [`%${orgId}%`],
    );
    expect(rows.rowCount).toBe(0);
  });

  it('keeps a ref the person may read and drops the rest of a selection', async () => {
    const result = await dropped(agent, {
      entity: { kind: 'org', ref: orgId },
      selection: { kind: 'ticket', refs: [ticket.key, 'NOPE-999', randomUUID()] },
    });
    expect(result.dropped).toEqual({ ticket: 2 });
  });

  it('refuses a selection of more than 20 refs and an unknown kind (400)', async () => {
    const refs = Array.from({ length: 21 }, (_, index) => `OPS-${String(index + 1)}`);
    expect(
      (await ask(agent, 'x', { context: { selection: { kind: 'ticket', refs } } })).status,
    ).toBe(400);
    expect(
      (await ask(agent, 'x', { context: { entity: { kind: 'user', ref: 'abc' } } })).status,
    ).toBe(400);
  });

  it('still takes the context of the first release (page and ticket only)', async () => {
    const response = await ask(agent, 'summarize', {
      context: { page: 'ticket', ticket: ticket.key },
    });
    expect(response.status).toBe(200);
  });
});

describe('runReadOnly (T-400 C-2, N2)', () => {
  const write = (db: Database['db']) =>
    db
      .update(schema.users)
      .set({ name: sql`name` })
      .where(sql`false`);

  it('rejects a write made through the handle it hands over, with SQLSTATE 25006', async () => {
    expect(await sqlState(runReadOnly(database, (db) => write(db)))).toBe('25006');
    expect(
      await sqlState(
        runReadOnly(database, (db) => db.execute(sql`UPDATE users SET name = name WHERE false`)),
      ),
    ).toBe('25006');
  });

  it('rejects a write made by a reader that holds its own handle (database.db or the pool), 25006', async () => {
    expect(await sqlState(runReadOnly(database, () => write(database.db)))).toBe('25006');
    expect(
      await sqlState(
        runReadOnly(database, () =>
          database.pool.query('UPDATE users SET name = name WHERE false'),
        ),
      ),
    ).toBe('25006');
    // Even after an await that gives the event loop back.
    expect(
      await sqlState(
        runReadOnly(database, async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          await write(database.db);
        }),
      ),
    ).toBe('25006');
  });

  it('leaves the same write alone outside the scope, and reads fine inside it', async () => {
    await expect(write(database.db)).resolves.toBeDefined();
    const rows = await runReadOnly(database, () =>
      database.db.select({ id: schema.users.id }).from(schema.users).limit(1),
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('stops a statement that runs past the timeout (57014) and returns the connection', async () => {
    expect(
      await sqlState(
        runReadOnly(database, (db) => db.execute(sql`SELECT pg_sleep(3)`), { timeoutMs: 200 }),
      ),
    ).toBe('57014');
    await expect(runReadOnly(database, (db) => db.execute(sql`SELECT 1`))).resolves.toBeDefined();
  });

  it('rejects a write made inside a tool handler (a reader of the catalogue that writes)', async () => {
    const keys = h.app.get<TicketKeys>(TICKET_KEYS, { strict: false });
    const principal = {
      userId: agent.userId,
      sessionId: 's',
      email: agent.email,
      name: 'A',
      role: 'agent',
      orgId: null,
      authMethod: 'dev',
      accessExpiresAt: new Date(Date.now() + 60_000),
      permissions: new Set(DEFAULT_ROLE_PERMISSIONS.agent),
      orgScope: { kind: 'all' },
    } as unknown as Principal;
    const host = buildAssistantTools(
      {
        database,
        // A reader that was changed to write: the database refuses it.
        reader: { list: () => write(database.db).then(() => ({ items: [] })) } as never,
        keys,
        sla: {} as never,
        kb: {} as never,
        brief: {} as never,
        runner: {} as never,
        embeddingMock: true,
        aiMock: true,
      },
      { principal, locale: 'en', masked: false, now: new Date() },
    );
    expect(await sqlState(host.tools.call('search_tickets', {}))).toBe('25006');
  });
});

describe('tool output within the route output (parity, agent and masked developer)', () => {
  const principalOf = (who: Persona, role: 'agent' | 'dev'): Principal =>
    ({
      userId: who.userId,
      sessionId: 's',
      email: who.email,
      name: 'N',
      role,
      orgId: null,
      authMethod: 'dev',
      accessExpiresAt: new Date(Date.now() + 60_000),
      permissions: new Set(DEFAULT_ROLE_PERMISSIONS[role]),
      orgScope: { kind: 'all' },
    }) as unknown as Principal;

  const hostFor = (who: Persona, role: 'agent' | 'dev') =>
    buildAssistantTools(
      {
        database,
        reader: h.app.get(TicketReader, { strict: false }),
        keys: h.app.get<TicketKeys>(TICKET_KEYS, { strict: false }),
        sla: h.app.get(SlaRemaining, { strict: false }),
        kb: h.app.get(KbService, { strict: false }),
        brief: h.app.get(BriefService, { strict: false }),
        runner: h.app.get(ToolRunner, { strict: false }),
        embeddingMock: true,
        aiMock: true,
      },
      { principal: principalOf(who, role), locale: 'en', masked: role === 'dev', now: new Date() },
    );

  for (const [label, role] of [
    ['an agent', 'agent'],
    ['a masked developer', 'dev'],
  ] as const) {
    it(`gives ${label} from search_tickets nothing that GET /v1/tickets would not`, async () => {
      const who = role === 'agent' ? agent : dev;
      // A masked reader may not search text (the reader refuses it, as the route does); the list is the same.
      const output: unknown = await hostFor(who, role).tools.call(
        'search_tickets',
        role === 'agent' ? { query: 'dashboard', limit: 8 } : { limit: 8 },
      );
      const route = await who.client.get<unknown>(
        role === 'agent' ? '/v1/tickets?q=dashboard&limit=8' : '/v1/tickets?limit=8',
      );
      expect(route.status).toBe(200);
      expect(leaksBeyondRoute(output, route.body), role).toEqual([]);
    });

    it(`gives ${label} from summarize_ticket nothing about the ticket that GET /v1/tickets/:id would not`, async () => {
      const who = role === 'agent' ? agent : dev;
      const output = (await hostFor(who, role).tools.call('summarize_ticket', {
        ticket: ticket.key,
      })) as { ticket: unknown; requester: unknown };
      const route = await who.client.get<unknown>(`/v1/tickets/${ticket.key}`);
      expect(route.status).toBe(200);
      // `recent` is raw message text that the assistant redacts and masks as a fact (ADR-023); the row and the
      // people are what the route must also show.
      expect(
        leaksBeyondRoute({ ticket: output.ticket, requester: output.requester }, route.body),
        role,
      ).toEqual([]);
    });
  }

  it('does not give a masked developer the requester, which the route masks', async () => {
    const output = (await hostFor(dev, 'dev').tools.call('summarize_ticket', {
      ticket: ticket.key,
    })) as { requester: string | null };
    expect(output.requester).toBeNull();
  });
});
