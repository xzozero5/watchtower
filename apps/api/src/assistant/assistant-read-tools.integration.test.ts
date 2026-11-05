import { randomBytes } from 'node:crypto';

import { createDatabase, type Database } from '@watchtower/db';
import { DEFAULT_ROLE_PERMISSIONS, type TicketDetail } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Principal } from '../auth/principal.js';
import { TICKET_KEYS, type TicketKeys } from '../tickets/ticket-keys.js';
import { SlaRemaining } from '../tickets/sla-remaining.js';
import { TicketReader } from '../tickets/ticket-reader.js';
import { KbService } from '../kb/kb.service.js';
import { BriefService } from '../shifts/brief.service.js';
import { ToolRunner } from '../tools/tool-runner.service.js';
import { startHarness, type Harness } from '../testing/harness.js';
import { apiIntent, apiOrg, fileTicket, signIn, type Persona } from '../testing/ticketing.js';
import { buildAssistantTools } from './assistant-tools.js';
import type { ToolFact } from './tools/fact-kit.js';
import { AssistantReadServices, type ModuleReadServices } from './tools/read-services.js';
import { leaksBeyondRoute } from './tool-parity.js';

// T-404 and T-405 on the real module graph and Postgres (restricted role): every module read tool against the GET route
// it mirrors, for the roles that hold it (a masked developer included), an argument that names another person, and the
// read-only scope. No model is involved: the tools are called as the host calls them.
const net = disableNetConnect();

let h: Harness;
let agent: Persona;
let lead: Persona;
let head: Persona;
let dev: Persona;
let ticket: TicketDetail;
let database: Database;
let articleId: string;
let mailId: string;
const suffix = `x${randomBytes(3).toString('hex')}`;
const owner = () => h.db.owner.pool;

type Role = 'agent' | 'lead' | 'head' | 'dev';
const personas = (): Record<Role, Persona> => ({ agent, lead, head, dev });

const principalOf = (role: Role): Principal =>
  ({
    userId: personas()[role].userId,
    sessionId: 's',
    email: personas()[role].email,
    name: 'N',
    role,
    orgId: null,
    authMethod: 'dev',
    accessExpiresAt: new Date(Date.now() + 60_000),
    permissions: new Set(DEFAULT_ROLE_PERMISSIONS[role]),
    orgScope: { kind: 'all' },
  }) as unknown as Principal;

const hostFor = (role: Role, modules?: ModuleReadServices) =>
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
      modules: modules ?? h.app.get(AssistantReadServices, { strict: false }),
    },
    { principal: principalOf(role), locale: 'en', masked: role === 'dev', now: new Date() },
  );

const call = (role: Role, tool: string, input: Record<string, unknown> = {}): Promise<unknown> =>
  hostFor(role).tools.call(tool, input);

const sqlState = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
  } catch (error) {
    const own = (error as { code?: string }).code;
    return own ?? (error as { cause?: { code?: string } }).cause?.code;
  }
  return undefined;
};

beforeAll(async () => {
  h = await startHarness();
  agent = await signIn(h, 'agent');
  lead = await signIn(h, 'lead');
  head = await signIn(h, 'head');
  dev = await signIn(h, 'dev');
  const orgId = (await apiOrg(lead, { name: `Read Tools Org ${suffix}` })).id;
  ticket = await fileTicket(agent, orgId, {
    subject: 'Cannot sign in to the dashboard',
    body: 'Since this morning the dashboard rejects our password. Write to jane.doe@customer.example.',
  });
  database = createDatabase({ url: h.db.appUrl, max: 4 });
  // Work for two people, so the per-agent figures have rows for both.
  const other = await fileTicket(agent, orgId, { subject: 'Second ticket' });
  for (const [key, who] of [
    [ticket.key, agent],
    [other.key, lead],
  ] as const) {
    const assigned = await lead.client.post(`/v1/tickets/${key}/assign`, {
      assigneeId: who.userId,
    });
    expect(assigned.status).toBe(200);
  }
  for (const key of ['access_issue', 'billing_question']) {
    await apiIntent(lead, { key, name: `Intent ${key} ${suffix}` });
  }
  const article = await agent.client.post<{ id: string }>('/v1/kb/articles', {
    slug: `read-tools-${suffix}`,
    title: `Reset a password ${suffix}`,
    bodyMd: '# Steps\n\nSend the reset link.',
    lang: 'en',
  });
  expect(article.status).toBe(201);
  articleId = article.body.id;
  const account = await owner().query<{ id: string }>(
    `INSERT INTO channel_account (type, name) VALUES ('gmail', 'Read tools mailbox') RETURNING id`,
  );
  const mail = await owner().query<{ id: string }>(
    `INSERT INTO inbound_message (channel_account_id, provider_message_id, from_address, from_name,
        subject, body_text, received_at, disposition, automated, classification)
     VALUES ($1, $2, 'noreply@sender.example.test', 'A Sender', 'Out of office', 'I am away until Monday.',
        now(), 'auto_reply', '{"disposition":"auto_reply","subtype":"out_of_office","signals":[]}', '{}')
     RETURNING id`,
    [account.rows[0]?.id, `m-${suffix}`],
  );
  mailId = mail.rows[0]?.id as string;
});

afterAll(async () => {
  await database.close();
  await h.close();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

describe('T-404 reports tools within their routes', () => {
  it('ops_metrics gives an agent and a lead nothing GET /v1/dashboard/ops would not', async () => {
    for (const role of ['agent', 'lead'] as const) {
      const output = await call(role, 'ops_metrics', { days: 7 });
      const route = await personas()[role].client.get('/v1/dashboard/ops?days=7');
      expect(route.status, role).toBe(200);
      expect(leaksBeyondRoute(output, route.body), role).toEqual([]);
    }
  });

  it('ceo_metrics gives a lead and a head nothing GET /v1/reports/ceo would not, and no formula', async () => {
    for (const role of ['lead', 'head'] as const) {
      const output = await call(role, 'ceo_metrics', { days: 30 });
      const route = await personas()[role].client.get('/v1/reports/ceo?days=30');
      expect(route.status, role).toBe(200);
      // The window is stamped with the time of each call.
      expect(
        leaksBeyondRoute(output, route.body, { derived: (path) => path.startsWith('window.') }),
        role,
      ).toEqual([]);
      expect(JSON.stringify(output)).not.toMatch(/staffCost|formula|minutesPerTicket/);
    }
  });

  it('performance_view: a lead sees the rows of the dashboard; an agent only their own, whoever they ask for', async () => {
    const leadView = (await call('lead', 'performance_view', { days: 7 })) as {
      scope: string;
      agents: { userId: string; name: string }[];
    };
    const route = await lead.client.get('/v1/dashboard/ops?days=7');
    expect(leadView.scope).toBe('all');
    expect(leadView.agents.map((row) => row.userId)).toEqual(
      expect.arrayContaining([agent.userId, lead.userId]),
    );
    expect(leaksBeyondRoute(leadView, route.body, { derived: (path) => path === 'scope' })).toEqual(
      [],
    );
    // A lead may ask for one person.
    const one = (await call('lead', 'performance_view', { userId: agent.userId })) as {
      agents: { userId: string }[];
    };
    expect(one.agents.map((row) => row.userId)).toEqual([agent.userId]);

    // An agent holds `performance.read.own` only: the argument of another user is ignored (C-16).
    const asked = (await call('agent', 'performance_view', { userId: lead.userId })) as {
      scope: string;
      agents: { userId: string }[];
    };
    expect(asked.scope).toBe('own');
    expect(asked.agents.every((row) => row.userId === agent.userId)).toBe(true);
    expect(JSON.stringify(asked)).not.toContain(lead.userId);
    const without = (await call('agent', 'performance_view', {})) as typeof asked;
    expect(without.agents).toEqual(asked.agents);
  });

  it('keeps a masked developer out of every reports tool', async () => {
    const names = hostFor('dev').info.map((entry) => entry.name);
    for (const tool of ['ops_metrics', 'ceo_metrics', 'performance_view'])
      expect(names, tool).not.toContain(tool);
    await expect(call('dev', 'ceo_metrics')).rejects.toThrow();
    await expect(call('agent', 'ceo_metrics')).rejects.toThrow();
  });
});

describe('T-405 tools within their routes', () => {
  it('conversation_search and conversation_get give nothing the Other mail routes would not', async () => {
    const search = (await call('agent', 'conversation_search', { query: 'Out of office' })) as {
      items: { id: string }[];
    };
    expect(search.items.map((row) => row.id)).toContain(mailId);
    const list = await agent.client.get('/v1/inbound/other-mail?q=Out%20of%20office');
    expect(list.status).toBe(200);
    expect(leaksBeyondRoute(search, list.body)).toEqual([]);

    const got = await call('agent', 'conversation_get', { id: mailId });
    const route = await agent.client.get(`/v1/inbound/other-mail/${mailId}`);
    expect(route.status).toBe(200);
    expect(leaksBeyondRoute(got, route.body)).toEqual([]);
    // The text is customer text: the fact wraps it.
    const [fact] = hostFor('agent').facts('conversation_get', got) as readonly ToolFact[];
    expect(fact?.trust).toBe('customer');
    expect(fact?.text).toContain('<untrusted_content>');
    // A developer has no `inbound.read`.
    expect(hostFor('dev').info.map((entry) => entry.name)).not.toContain('conversation_get');
    await expect(call('dev', 'conversation_get', { id: mailId })).rejects.toThrow();
  });

  it('kb_get gives nothing GET /v1/kb/articles/:id would not', async () => {
    const output = await call('agent', 'kb_get', { id: articleId });
    const route = await agent.client.get(`/v1/kb/articles/${articleId}`);
    expect(route.status).toBe(200);
    expect(leaksBeyondRoute(output, route.body)).toEqual([]);
    await expect(
      call('agent', 'kb_get', { id: '3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a11' }),
    ).rejects.toThrow();
  });

  for (const role of ['agent', 'dev'] as const) {
    it(`ticket_timeline gives ${role === 'dev' ? 'a masked developer' : 'an agent'} nothing GET /v1/tickets/:id/timeline would not`, async () => {
      const output = (await call(role, 'ticket_timeline', { ticket: ticket.key, limit: 20 })) as {
        entries: unknown[];
      };
      const route = await personas()[role].client.get(`/v1/tickets/${ticket.key}/timeline`);
      expect(route.status).toBe(200);
      expect(output.entries.length).toBeGreaterThan(0);
      expect(
        leaksBeyondRoute(output, route.body, { derived: (path) => /\.(from|actor)$/.test(path) }),
        role,
      ).toEqual([]);
      if (role === 'dev') {
        // The reader masks the address for a developer; the tool adds nothing back.
        expect(JSON.stringify(output)).not.toContain('jane.doe@customer.example');
      }
    });
  }

  it('autonomy_status gives nothing GET /v1/autonomy would not, and the gate only with intent.manage', async () => {
    const output = (await call('agent', 'autonomy_status')) as {
      intents: { gate: string }[];
      switches: { key: string; on: boolean }[];
    };
    const route = await agent.client.get('/v1/autonomy');
    expect(route.status).toBe(200);
    expect(
      leaksBeyondRoute(output, route.body, { derived: (path) => path.endsWith('.gate') }),
    ).toEqual([]);
    expect(output.intents.length).toBeGreaterThan(0);
    expect(output.intents.every((entry) => entry.gate === 'hidden')).toBe(true);
    expect(output.switches.map((entry) => entry.key).toSorted()).toEqual(
      ['ai_kill_switch', 'ai_stage_cap_pinned'].toSorted(),
    );
    const headOutput = (await call('head', 'autonomy_status')) as typeof output;
    expect(headOutput.intents.every((entry) => entry.gate !== 'hidden')).toBe(true);
    expect(hostFor('dev').info.map((entry) => entry.name)).not.toContain('autonomy_status');
  });

  it('config_lookup gives nothing the GET routes of the settings pages would not, and no secret', async () => {
    const derived = (path: string): boolean =>
      path === 'config' ||
      path.endsWith('.memberCount') ||
      // The tool lists every status as a row; the route only the ones with a transition.
      path.endsWith('.from') ||
      path.endsWith('.to');
    const routes: [string, string][] = [
      ['sla_policy', '/v1/sla-policies'],
      ['queue', '/v1/queues'],
      ['intent', '/v1/intents'],
      ['workflow', '/v1/ticket-workflow'],
    ];
    for (const [config, path] of routes) {
      const output = await call('lead', 'config_lookup', { config });
      const route = await lead.client.get(path);
      expect(route.status, path).toBe(200);
      expect(leaksBeyondRoute(output, route.body, { derived }), config).toEqual([]);
      expect(JSON.stringify(output), config).not.toMatch(/https?:\/\//i);
    }
    const integrations = await call('head', 'config_lookup', { config: 'integration' });
    const route = await head.client.get('/v1/admin/integrations');
    expect(route.status).toBe(200);
    expect(leaksBeyondRoute(integrations, route.body, { derived })).toEqual([]);
    const text = JSON.stringify(integrations);
    expect(text).not.toMatch(/https?:\/\/|secret|token|password|envVar|updatedBy/i);
    for (const item of (integrations as { items: Record<string, unknown>[] }).items) {
      expect(Object.keys(item).toSorted()).toEqual(['connected', 'kind']);
    }
    // A lead does not hold `integration.manage`; the settings page of integrations is the head's.
    await expect(call('lead', 'config_lookup', { config: 'integration' })).rejects.toThrow();
    await expect(call('agent', 'config_lookup', { config: 'queue' })).rejects.toThrow();
  });
});

describe('the read-only scope of the module tools (N2)', () => {
  it('turns a write under any module tool into 25006', async () => {
    const real = h.app.get(AssistantReadServices, { strict: false });
    const write = () => database.pool.query('UPDATE users SET name = name WHERE false');
    const faulty: ModuleReadServices = {
      reader: real.reader,
      dashboard: real.dashboard,
      ceo: real.ceo,
      timeline: real.timeline,
      autonomy: real.autonomy,
      sla: real.sla,
      queues: real.queues,
      intents: real.intents,
      workflow: real.workflow,
      credentials: real.credentials,
      kb: { get: () => write().then(() => real.kb.get(articleId)) },
      otherMail: {
        list: real.otherMail.list.bind(real.otherMail),
        get: () => write().then(() => real.otherMail.get(mailId)),
      },
    };
    expect(await sqlState(hostFor('agent', faulty).tools.call('kb_get', { id: articleId }))).toBe(
      '25006',
    );
    expect(
      await sqlState(hostFor('agent', faulty).tools.call('conversation_get', { id: mailId })),
    ).toBe('25006');
    // The same call with the real services reads fine.
    await expect(hostFor('agent').tools.call('kb_get', { id: articleId })).resolves.toBeDefined();
  });
});
