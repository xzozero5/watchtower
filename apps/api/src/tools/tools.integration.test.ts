import { randomBytes, randomUUID } from 'node:crypto';

import {
  createGuardedSqlClient,
  FakeLogsClient,
  FakeMetricsClient,
  FakeRepoClient,
} from '@watchtower/connectors';
import { createProductDbExecutor } from '@watchtower/db';
import { createProductMockDatabase, type ProductMockDatabase } from '@watchtower/db/testing';
import {
  DATA_COLUMN_ALLOW_LIST,
  TOOLS_AUDIT_ACTIONS,
  type EvidenceCard,
  type ServiceStatusList,
  type TicketTools,
  type ToolTemplate,
} from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import {
  apiIntent,
  apiOrg,
  fileTicket,
  signIn,
  type ApiErrorBody,
  type Persona,
} from '../testing/ticketing.js';
import { TOOL_CLIENTS, type ToolClients } from './tool-clients.js';

// T-203d on the real application module, Postgres (restricted role) and Redis from docker compose, and a
// local invented product database. The logs, metrics and repository clients are fakes: no network
// (the harness runs under disableNetConnect and the test checks that nothing tried).
const net = disableNetConnect();
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let h: Harness;
let mock: ProductMockDatabase;
let head: Persona;
let lead: Persona;
let agent: Persona;
let client: Persona;
let orgId: string;
let otherOrgId: string;
let ticketRef: string;
let ticketId: string;
let intentKey: string;

const logs = new FakeLogsClient();
const metrics = new FakeMetricsClient();
const repo = new FakeRepoClient();
let toolClients: { -readonly [K in keyof ToolClients]: ToolClients[K] };
const owner = () => h.db.owner.pool;

const call = <T>(
  who: Persona,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
) => who.client.request<T>(method, path, body === undefined ? {} : { body });

const minutesAgo = (n: number): string => new Date(Date.now() - n * 60_000).toISOString();

beforeAll(async () => {
  mock = await createProductMockDatabase(adminUrl);
  const executor = createProductDbExecutor({ url: mock.readOnlyUrl });
  toolClients = {
    logs,
    metrics,
    repo,
    data: (extra) =>
      createGuardedSqlClient(executor, {
        allowColumns: new Set([...DATA_COLUMN_ALLOW_LIST, ...extra]),
      }),
    dataMock: executor.sandbox,
    dataHardening: () => executor.hardeningProblems(),
    dataAdhocEnabled: true,
    close: () => executor.close(),
  };
  h = await startHarness({ overrides: [{ token: TOOL_CLIENTS, value: toolClients }] });
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  orgId = (await apiOrg(lead, { name: 'Tools Org' })).id;
  otherOrgId = (await apiOrg(lead, { name: 'Other Org' })).id;
  client = await signIn(h, 'client', orgId);
  intentKey = `webhook_not_received_${randomBytes(2).toString('hex')}`;
  await apiIntent(lead, { key: intentKey, name: 'Webhook not received' });
  const ticket = await fileTicket(agent, orgId, { intentKey });
  ticketId = ticket.id;
  ticketRef = ticket.key;
  logs.add(
    {
      insertId: 'mine-1',
      timestamp: minutesAgo(5),
      severity: 'ERROR',
      service: 'example-delivery',
      message:
        'webhook delivery failed for jane.doe@example.com, call +66 81 234 5678 (acct 4111 1111 1111 1111)',
      labels: { org_ref: orgId },
    },
    {
      insertId: 'mine-2',
      timestamp: minutesAgo(9),
      severity: 'WARNING',
      service: 'example-delivery',
      message: 'endpoint slow: 9800 ms',
      labels: { org_ref: orgId },
    },
    {
      insertId: 'theirs-1',
      timestamp: minutesAgo(6),
      severity: 'ERROR',
      service: 'example-delivery',
      message: 'webhook delivery failed for the OTHER customer sam@example.org',
      labels: { org_ref: otherOrgId },
    },
  );
});

afterAll(async () => {
  await h.close();
  await mock.cleanup();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

async function newTemplate(
  body: Record<string, unknown>,
  who: Persona = head,
): Promise<ToolTemplate> {
  // A template the AI may run must be about the organization of the ticket; the others are for people.
  const withDefault = { runByAi: String(body.body).includes('{{org_id}}'), ...body };
  const response = await call<ToolTemplate>(who, 'POST', '/v1/tools/templates', withDefault);
  if (response.status !== 201) throw new Error(`template: ${JSON.stringify(response.body)}`);
  return response.body;
}

async function clearBudget(): Promise<void> {
  await owner().query(`DELETE FROM rate_budget_window`);
}

const LOG_FILTER = 'service="example-delivery" AND labels.org_ref={{org_id}} severity>=WARNING';

describe('access (RBAC)', () => {
  const someId = randomUUID();
  const ROUTES: readonly [string, () => string, unknown, readonly ('agent' | 'lead' | 'head')[]][] =
    [
      ['GET', () => '/v1/tools/templates', undefined, ['agent', 'lead', 'head']],
      [
        'POST',
        () => '/v1/tools/templates',
        { kind: 'logs', name: 'rbac-probe', title: 'x', body: 'severity>=ERROR' },
        ['head'],
      ],
      ['PATCH', () => `/v1/tools/templates/${someId}`, { title: 'x' }, ['head']],
      ['DELETE', () => `/v1/tools/templates/${someId}`, undefined, ['head']],
      ['GET', () => `/v1/tickets/${ticketRef}/tools`, undefined, ['agent', 'lead', 'head']],
      ['GET', () => `/v1/tickets/${ticketRef}/evidence`, undefined, ['agent', 'lead', 'head']],
      [
        'POST',
        () => `/v1/tickets/${ticketRef}/tools/run`,
        { templateId: someId },
        ['agent', 'lead', 'head'],
      ],
      [
        'POST',
        () => `/v1/incidents/${someId}/tools/run`,
        { templateId: someId },
        ['agent', 'lead', 'head'],
      ],
      ['GET', () => `/v1/incidents/${someId}/evidence`, undefined, ['agent', 'lead', 'head']],
      [
        'POST',
        () => '/v1/investigate/adhoc/logs',
        { filter: '', ticketId: ticketRef },
        ['lead', 'head'],
      ],
      [
        'POST',
        () => '/v1/investigate/adhoc/data',
        { sql: 'SELECT 1', ticketId: ticketRef },
        ['lead', 'head'],
      ],
      ['GET', () => '/v1/ops/services', undefined, ['agent', 'lead', 'head']],
    ];

  it.each(ROUTES)(
    '%s %s: only the roles that hold the permission',
    async (method, path, body, allowed) => {
      const people = { agent, lead, head } as const;
      for (const role of ['agent', 'lead', 'head'] as const) {
        const response = await call(people[role], method as 'GET', path(), body);
        if (allowed.includes(role)) {
          expect([401, 403], `${role} ${method} ${path()}`).not.toContain(response.status);
        } else {
          expect(response.status, `${role} ${method} ${path()}`).toBe(403);
        }
      }
      // A client has none of these permissions; no session gets 401.
      expect((await call(client, method as 'GET', path(), body)).status).toBe(403);
      expect(
        (await h.client().request(method as 'GET', path(), body === undefined ? {} : { body }))
          .status,
      ).toBe(401);
    },
  );
});

describe('templates (head, audited)', () => {
  it('saves a template, derives its placeholders, and audits it without the body or any result', async () => {
    const created = await newTemplate({
      kind: 'logs',
      name: `delivery-errors-${randomBytes(2).toString('hex')}`,
      title: 'Delivery errors',
      intentKey,
      body: `${LOG_FILTER} labels.session_id={{session_id}}`,
    });
    expect(created).toMatchObject({
      kind: 'logs',
      intentKey,
      placeholders: ['org_id', 'session_id'],
      inputParams: ['session_id'],
      runByAi: true,
      active: true,
    });
    const audit = await owner().query<{ metadata: Record<string, unknown>; actor_id: string }>(
      `SELECT metadata, actor_id FROM audit_log WHERE action = $1 AND target_id = $2`,
      [TOOLS_AUDIT_ACTIONS.toolTemplateCreate, created.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.actor_id).toBe(head.userId);
    expect(audit.rows[0]?.metadata).toMatchObject({
      kind: 'logs',
      name: created.name,
      intent: intentKey,
    });
    expect(JSON.stringify(audit.rows[0]?.metadata)).not.toContain('example-delivery');

    const patched = await call<ToolTemplate>(head, 'PATCH', `/v1/tools/templates/${created.id}`, {
      body: 'service="example-delivery" severity>=ERROR',
      title: 'Delivery errors (all)',
      runByAi: false,
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ placeholders: [], title: 'Delivery errors (all)' });
    const updates = await owner().query<{
      metadata: { bodyDigestBefore: string; bodyDigestAfter: string };
    }>(`SELECT metadata FROM audit_log WHERE action = $1 AND target_id = $2`, [
      TOOLS_AUDIT_ACTIONS.toolTemplateUpdate,
      created.id,
    ]);
    expect(updates.rows[0]?.metadata.bodyDigestBefore).toMatch(/^[0-9a-f]{64}$/);
    expect(updates.rows[0]?.metadata.bodyDigestAfter).not.toBe(
      updates.rows[0]?.metadata.bodyDigestBefore,
    );

    expect((await call(head, 'DELETE', `/v1/tools/templates/${created.id}`)).status).toBe(204);
    expect((await call(head, 'DELETE', `/v1/tools/templates/${created.id}`)).status).toBe(404);
  });

  it('refuses a body that could never run, an unknown intent, a duplicate name and columns on a logs template', async () => {
    const base = { kind: 'data', title: 'x', name: 'probe-template' };
    for (const body of [
      'DELETE FROM jobs',
      "SELECT * FROM EXTERNAL_QUERY('conn', 'SELECT 1')",
      'SELECT 1; SELECT 2',
      'SELECT {{Bad}}',
    ]) {
      const response = await call<ApiErrorBody>(head, 'POST', '/v1/tools/templates', {
        ...base,
        body,
      });
      expect(response.status, body).toBe(400);
    }
    expect(
      (
        await call(head, 'POST', '/v1/tools/templates', {
          kind: 'logs',
          name: 'bad-filter',
          title: 'x',
          body: 'nope="x"',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(head, 'POST', '/v1/tools/templates', {
          kind: 'logs',
          name: 'bad-intent',
          title: 'x',
          body: 'severity>=ERROR',
          intentKey: 'no_such_intent',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(head, 'POST', '/v1/tools/templates', {
          kind: 'logs',
          name: 'bad-cols',
          title: 'x',
          body: 'severity>=ERROR',
          allowedColumns: ['id'],
        })
      ).status,
    ).toBe(400);
    const first = await newTemplate({
      kind: 'logs',
      name: 'dup-name',
      title: 'x',
      body: 'severity>=ERROR',
    });
    expect(
      (
        await call(head, 'POST', '/v1/tools/templates', {
          kind: 'logs',
          name: 'dup-name',
          title: 'y',
          body: 'severity>=ERROR',
          runByAi: false,
        })
      ).status,
    ).toBe(409);
    await call(head, 'DELETE', `/v1/tools/templates/${first.id}`);
  });

  it("refuses a template for the AI that is not about the ticket's organization (P3), at save and in the table", async () => {
    const aiBody = {
      kind: 'logs',
      title: 'x',
      intentKey,
      body: 'service="example-delivery" severity>=ERROR',
      runByAi: true,
    };
    expect(
      (await call(head, 'POST', '/v1/tools/templates', { ...aiBody, name: 'ai-all-orgs' })).status,
    ).toBe(400);
    const personal = await newTemplate({
      ...aiBody,
      name: `person-only-${randomBytes(2).toString('hex')}`,
      runByAi: false,
    });
    expect(personal.runByAi).toBe(false);
    // Turning the AI on for it, without {{org_id}}, is refused too; with it, accepted.
    expect(
      (await call(head, 'PATCH', `/v1/tools/templates/${personal.id}`, { runByAi: true })).status,
    ).toBe(400);
    const both = await call<ToolTemplate>(head, 'PATCH', `/v1/tools/templates/${personal.id}`, {
      runByAi: true,
      body: 'service="example-delivery" labels.org_ref={{org_id}}',
    });
    expect(both.status).toBe(200);
    // And the table itself says no, whatever the API does.
    await expect(
      owner().query(`UPDATE tool_template SET body = 'severity>=ERROR' WHERE id = $1`, [
        personal.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('lists by intent and kind', async () => {
    const mine = await newTemplate({
      kind: 'logs',
      name: `listed-${randomBytes(2).toString('hex')}`,
      title: 'Listed',
      intentKey,
      body: 'severity>=ERROR',
    });
    const response = await call<{ items: ToolTemplate[] }>(
      agent,
      'GET',
      `/v1/tools/templates?intent=${intentKey}&kind=logs`,
    );
    expect(response.status).toBe(200);
    expect(response.body.items.map((item) => item.id)).toContain(mine.id);
    expect(
      response.body.items.every((item) => item.intentKey === intentKey && item.kind === 'logs'),
    ).toBe(true);
  });
});

describe('one click on a ticket (AC-5)', () => {
  let template: ToolTemplate;
  beforeAll(async () => {
    template = await newTemplate({
      kind: 'logs',
      name: `ac5-${randomBytes(2).toString('hex')}`,
      title: 'Delivery warnings and errors',
      intentKey,
      body: LOG_FILTER,
    });
  });

  it("shows the intent's button, connected and labelled mock", async () => {
    const response = await call<TicketTools>(agent, 'GET', `/v1/tickets/${ticketRef}/tools`);
    expect(response.status).toBe(200);
    expect(response.body.intentKey).toBe(intentKey);
    expect(response.body.buttons.find((button) => button.templateId === template.id)).toMatchObject(
      {
        kind: 'logs',
        inputParams: [],
        connected: true,
        mock: true,
      },
    );
  });

  it("runs the log template for the ticket's organization and pins an evidence card with no personal data", async () => {
    await clearBudget();
    const before = logs.queries.length;
    const response = await call<EvidenceCard>(agent, 'POST', `/v1/tickets/${ticketRef}/tools/run`, {
      templateId: template.id,
    });
    expect(response.status).toBe(201);
    const card = response.body;
    expect(card).toMatchObject({
      ticketId,
      incidentId: null,
      kind: 'logs',
      templateId: template.id,
      templateName: template.name,
      resultCount: 2,
      truncated: false,
      mock: true,
      createdBy: agent.userId,
    });
    expect(card.summary).toMatch(/^2 log entries from /);
    // The filter that went out is the template with this organization, and no other.
    expect(logs.queries).toHaveLength(before + 1);
    expect(logs.queries[before]?.filter).toBe(
      `service="example-delivery" AND labels.org_ref="${orgId}" severity>=WARNING`,
    );
    // N4: what is stored and returned has no e-mail, phone or card number; the other organization's line is not there.
    expect(card.excerpt).toContain('webhook delivery failed for');
    for (const secret of [
      'jane.doe@example.com',
      '234 5678',
      '4111 1111 1111 1111',
      'sam@example.org',
      'OTHER customer',
    ]) {
      expect(card.excerpt, secret).not.toContain(secret);
    }
    expect(card.excerpt).toMatch(/\[EMAIL_\d+\]/);
    const stored = await owner().query<{
      excerpt: string;
      params_hash: string;
      result_hash: string;
    }>(`SELECT excerpt, params_hash, result_hash FROM evidence_card WHERE id = $1`, [card.id]);
    expect(stored.rows[0]?.excerpt).toBe(card.excerpt);
    expect(stored.rows[0]?.params_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]?.result_hash).toMatch(/^[0-9a-f]{64}$/);

    // The run is a tool_execution row of a person, with the input only as a keyed hash (N2).
    const runs = await owner().query<{
      agent: string;
      tool: string;
      status: string;
      input_hash: string;
      result_count: number;
      mock: boolean;
    }>(
      `SELECT agent, tool, status, input_hash, result_count, mock FROM tool_execution WHERE ticket_id = $1`,
      [ticketId],
    );
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0]).toMatchObject({
      agent: 'human',
      tool: 'gcp_logs',
      status: 'ok',
      result_count: 2,
      mock: true,
    });
    expect(runs.rows[0]?.input_hash).toMatch(/^[0-9a-f]{64}$/);

    // It shows in the list, and the audit row has ids and counts only.
    const list = await call<{ items: EvidenceCard[] }>(
      agent,
      'GET',
      `/v1/tickets/${ticketRef}/evidence`,
    );
    expect(list.body.items.map((item) => item.id)).toContain(card.id);
    const audit = await owner().query<{ actor_id: string; metadata: Record<string, unknown> }>(
      `SELECT actor_id, metadata FROM audit_log WHERE action = $1 AND target_id = $2`,
      [TOOLS_AUDIT_ACTIONS.toolRun, card.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.actor_id).toBe(agent.userId);
    expect(audit.rows[0]?.metadata).toMatchObject({
      kind: 'logs',
      template: template.name,
      subject: 'ticket',
      resultCount: 2,
      mock: true,
    });
    const text = JSON.stringify(audit.rows[0]?.metadata);
    expect(text).not.toContain(orgId);
    expect(text).not.toContain('example-delivery');

    expect(
      (await call(agent, 'DELETE', `/v1/tickets/${ticketRef}/evidence/${card.id}`)).status,
    ).toBe(204);
    expect(
      (await call(agent, 'DELETE', `/v1/tickets/${ticketRef}/evidence/${card.id}`)).status,
    ).toBe(404);
  });

  it('fills org_id and ticket_id from the ticket only, and asks for every other parameter', async () => {
    const withSession = await newTemplate({
      kind: 'logs',
      name: `session-${randomBytes(2).toString('hex')}`,
      title: 'One session',
      intentKey,
      body: `${LOG_FILTER} labels.session_id={{session_id}}`,
    });
    await clearBudget();
    const run = (params: Record<string, string>) =>
      call<ApiErrorBody & EvidenceCard>(agent, 'POST', `/v1/tickets/${ticketRef}/tools/run`, {
        templateId: withSession.id,
        params,
      });
    const before = logs.queries.length;
    expect((await run({})).status).toBe(400);
    expect((await run({ session_id: 'a', other: 'b' })).status).toBe(400);
    // The ticket's organization cannot be replaced by the caller (the other organization's id is a valid-looking value).
    expect((await run({ session_id: 'a', org_id: otherOrgId })).status).toBe(400);
    // A value that tries to close the quote is not plain text.
    expect((await run({ session_id: 'x" OR labels.org_ref="' + otherOrgId })).status).toBe(400);
    expect(logs.queries).toHaveLength(before);
    expect((await run({ session_id: 'sess-1' })).status).toBe(201);
    expect(logs.queries).toHaveLength(before + 1);
  });

  it("refuses another intent's template, an inactive or unknown one, and a ticket that does not exist", async () => {
    const otherIntent = `other_${randomBytes(2).toString('hex')}`;
    await apiIntent(lead, { key: otherIntent, name: 'Other' });
    const foreign = await newTemplate({
      kind: 'logs',
      name: `foreign-${randomBytes(2).toString('hex')}`,
      title: 'Foreign',
      intentKey: otherIntent,
      body: 'severity>=ERROR',
    });
    expect(
      (await call(agent, 'POST', `/v1/tickets/${ticketRef}/tools/run`, { templateId: foreign.id }))
        .status,
    ).toBe(400);
    await call(head, 'PATCH', `/v1/tools/templates/${template.id}`, { active: false });
    expect(
      (await call(agent, 'POST', `/v1/tickets/${ticketRef}/tools/run`, { templateId: template.id }))
        .status,
    ).toBe(404);
    await call(head, 'PATCH', `/v1/tools/templates/${template.id}`, { active: true });
    expect(
      (
        await call(agent, 'POST', `/v1/tickets/${ticketRef}/tools/run`, {
          templateId: randomUUID(),
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(agent, 'POST', `/v1/tickets/OPS-99999999/tools/run`, { templateId: template.id }))
        .status,
    ).toBe(404);
  });

  it('answers 503 and says "not connected" when logs are not connected', async () => {
    await clearBudget();
    const connected = toolClients.logs;
    toolClients.logs = undefined;
    try {
      const buttons = await call<TicketTools>(agent, 'GET', `/v1/tickets/${ticketRef}/tools`);
      expect(
        buttons.body.buttons.find((button) => button.templateId === template.id)?.connected,
      ).toBe(false);
      const response = await call<ApiErrorBody>(
        agent,
        'POST',
        `/v1/tickets/${ticketRef}/tools/run`,
        { templateId: template.id },
      );
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('tool_not_connected');
    } finally {
      toolClients.logs = connected;
    }
  });
});

describe('the data tool on the product_mock database', () => {
  it('runs a saved SELECT with bind parameters, shows the anomaly, and labels the data mock', async () => {
    const template = await newTemplate({
      kind: 'data',
      name: `failure-rate-${randomBytes(2).toString('hex')}`,
      title: 'Webhook failure rate',
      intentKey,
      body: `SELECT day, event_type, requests, failed, round(failed::numeric / NULLIF(requests, 0), 4) AS ratio
             FROM api_daily WHERE tenant_id = {{tenant_ref}} AND event_type = 'webhook_delivery'
             ORDER BY day DESC`,
    });
    await clearBudget();
    const response = await call<EvidenceCard & ApiErrorBody>(
      agent,
      'POST',
      `/v1/tickets/${ticketRef}/tools/run`,
      {
        templateId: template.id,
        params: { tenant_ref: 't-003' },
      },
    );
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      kind: 'data',
      mock: true,
      resultCount: 30,
      truncated: false,
      maskedColumns: [],
    });
    const [first] = response.body.excerpt.split('\n').slice(1);
    // Newest day first: about a third of the deliveries failed.
    expect(Number(first?.split(' | ')[4])).toBeGreaterThanOrEqual(0.3);
    const runs = await owner().query<{ tool: string; status: string }>(
      `SELECT tool, status FROM tool_execution WHERE tool = 'bigquery_query' AND ticket_id = $1`,
      [ticketId],
    );
    expect(runs.rows).toEqual([{ tool: 'bigquery_query', status: 'ok' }]);
  });

  it('hides a column that is not on the allow-list unless the template allows it, and never returns a personal one', async () => {
    const hidden = await newTemplate({
      kind: 'data',
      name: `tenants-${randomBytes(2).toString('hex')}`,
      title: 'Tenants',
      body: 'SELECT id, plan, region FROM tenants ORDER BY id',
    });
    await clearBudget();
    const first = await call<EvidenceCard>(agent, 'POST', `/v1/tickets/${ticketRef}/tools/run`, {
      templateId: hidden.id,
    });
    expect(first.status).toBe(201);
    expect(first.body.maskedColumns).toEqual(['id']);
    expect(first.body.excerpt).not.toContain('t-00');
    expect(first.body.summary).toContain('1 hidden');
    await call(head, 'PATCH', `/v1/tools/templates/${hidden.id}`, { allowedColumns: ['id'] });
    const second = await call<EvidenceCard>(agent, 'POST', `/v1/tickets/${ticketRef}/tools/run`, {
      templateId: hidden.id,
    });
    expect(second.body.maskedColumns).toEqual([]);
    expect(second.body.excerpt).toContain('t-001');

    // A template that selects a personal column is stopped by the database login, and says only that.
    const personal = await newTemplate({
      kind: 'data',
      name: `personal-${randomBytes(2).toString('hex')}`,
      title: 'Personal',
      body: 'SELECT contact_email AS status FROM tenants',
    });
    const refused = await call<ApiErrorBody>(agent, 'POST', `/v1/tickets/${ticketRef}/tools/run`, {
      templateId: personal.id,
    });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).not.toContain('contact_email');
  });

  it('answers 503 when there is no product database', async () => {
    const template = await newTemplate({
      kind: 'data',
      name: `nodb-${randomBytes(2).toString('hex')}`,
      title: 'No db',
      body: 'SELECT 1 AS n',
    });
    const data = toolClients.data;
    toolClients.data = undefined;
    try {
      const response = await call<ApiErrorBody>(
        agent,
        'POST',
        `/v1/tickets/${ticketRef}/tools/run`,
        { templateId: template.id },
      );
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('tool_not_connected');
    } finally {
      toolClients.data = data;
    }
  });
});

describe('ad-hoc runs (lead, head)', () => {
  it('runs a statement of your own, pins it, and audits the hash but not the statement', async () => {
    await clearBudget();
    const sqlText =
      'SELECT tenant_id, sum(requests)::int AS total FROM api_daily WHERE day >= current_date - $1::int GROUP BY tenant_id ORDER BY tenant_id';
    const response = await call<EvidenceCard & ApiErrorBody>(
      lead,
      'POST',
      '/v1/investigate/adhoc/data',
      {
        sql: sqlText,
        params: [7],
        ticketId: ticketRef,
      },
    );
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      kind: 'data',
      templateName: 'adhoc',
      templateId: null,
      resultCount: 5,
      mock: true,
    });
    const audit = await owner().query<{ actor_id: string; metadata: Record<string, unknown> }>(
      `SELECT actor_id, metadata FROM audit_log WHERE action = $1 AND target_id = $2`,
      [TOOLS_AUDIT_ACTIONS.toolAdhoc, response.body.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.actor_id).toBe(lead.userId);
    expect(JSON.stringify(audit.rows[0]?.metadata)).not.toContain('api_daily');
  });

  it('refuses what is not a read, EXTERNAL_QUERY, a personal column, a bad filter and a missing pin', async () => {
    await clearBudget();
    const data = (sql: string) =>
      call<ApiErrorBody>(head, 'POST', '/v1/investigate/adhoc/data', { sql, ticketId: ticketRef });
    for (const sql of [
      'DELETE FROM jobs',
      "SELECT * FROM EXTERNAL_QUERY('conn', 'SELECT 1')",
      'SELECT 1; DROP TABLE jobs',
      'SELECT contact_email FROM tenants',
      'SELECT * FROM tenants',
    ]) {
      expect((await data(sql)).status, sql).toBe(400);
    }
    const before = logs.queries.length;
    expect(
      (
        await call(head, 'POST', '/v1/investigate/adhoc/logs', {
          filter: 'unknown="x"',
          ticketId: ticketRef,
        })
      ).status,
    ).toBe(400);
    expect(logs.queries).toHaveLength(before);
    expect((await call(head, 'POST', '/v1/investigate/adhoc/logs', { filter: '' })).status).toBe(
      400,
    );
    expect(
      (
        await call(head, 'POST', '/v1/investigate/adhoc/logs', {
          filter: '',
          ticketId: ticketRef,
          incidentId: randomUUID(),
        })
      ).status,
    ).toBe(400);
    // Nothing was written: the invented product data is all still there.
    const check = createProductDbExecutor({
      url: mock.ownerUrl,
      readerRole: decodeURIComponent(new URL(mock.ownerUrl).username),
    });
    const jobs = await check.execute({
      sql: 'SELECT count(*)::int AS n FROM jobs',
      params: [],
      maxRows: 1,
      timeoutMs: 1000,
    });
    await check.close();
    expect(jobs.rows).toEqual([[200]]);
  });

  it('keeps ad-hoc statements off while the product login is not hardened, and saved templates still run (T-208)', async () => {
    await clearBudget();
    const hardened = toolClients.dataHardening;
    toolClients.dataHardening = () => Promise.resolve(['the reader can use advisory locks']);
    try {
      const refused = await call<ApiErrorBody>(head, 'POST', '/v1/investigate/adhoc/data', {
        sql: 'SELECT 1 AS n',
        ticketId: ticketRef,
      });
      expect(refused.status).toBe(503);
      expect(refused.body.code).toBe('tool_not_connected');
      expect(refused.body.message).toContain('not hardened');
      const template = await newTemplate({
        kind: 'data',
        name: `still-runs-${randomBytes(2).toString('hex')}`,
        title: 'Still runs',
        body: 'SELECT 1 AS n',
      });
      expect(
        (
          await call(agent, 'POST', `/v1/tickets/${ticketRef}/tools/run`, {
            templateId: template.id,
          })
        ).status,
      ).toBe(201);
    } finally {
      toolClients.dataHardening = hardened;
    }
    expect(
      (
        await call(head, 'POST', '/v1/investigate/adhoc/data', {
          sql: 'SELECT 1 AS n',
          ticketId: ticketRef,
        })
      ).status,
    ).toBe(201);
  });

  it('T-207a C-1: ad-hoc data is off unless the deployment turned it on, and saved templates still run', async () => {
    await clearBudget();
    const enabled = toolClients.dataAdhocEnabled;
    toolClients.dataAdhocEnabled = false;
    try {
      const refused = await call<ApiErrorBody>(head, 'POST', '/v1/investigate/adhoc/data', {
        sql: 'SELECT 1 AS n',
        ticketId: ticketRef,
      });
      expect(refused.status).toBe(503);
      expect(refused.body.message).toContain('PRODUCT_DB_ADHOC_ENABLED');
      const template = await newTemplate({
        kind: 'data',
        name: `adhoc-off-${randomBytes(2).toString('hex')}`,
        title: 'Runs with adhoc off',
        body: 'SELECT 1 AS n',
      });
      expect(
        (
          await call(agent, 'POST', `/v1/tickets/${ticketRef}/tools/run`, {
            templateId: template.id,
          })
        ).status,
      ).toBe(201);
    } finally {
      toolClients.dataAdhocEnabled = enabled;
    }
  });

  it('T-207a C-1: a statement of your own cannot use the forms that build a huge value, and asks for at most 100 rows', async () => {
    await clearBudget();
    for (const sql of [
      "SELECT array_agg(repeat('x', 100000000)) AS n",
      "SELECT string_agg(plan, ',') AS n FROM tenants",
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t) SELECT n FROM t',
    ]) {
      const response = await call<ApiErrorBody>(head, 'POST', '/v1/investigate/adhoc/data', {
        sql,
        ticketId: ticketRef,
      });
      expect(response.status, sql).toBe(400);
    }
    expect(
      (
        await call(head, 'POST', '/v1/investigate/adhoc/data', {
          sql: 'SELECT 1 AS n',
          maxRows: 500,
          ticketId: ticketRef,
        })
      ).status,
    ).toBe(400);
  });

  it('T-207a C-9: a run that reaches another organization redacts the people of every organization in the result', async () => {
    await clearBudget();
    await owner().query(
      `INSERT INTO contact (org_id, name, emails) VALUES ($1, 'Zebulon Quixote', ARRAY['zq@example.test'])`,
      [otherOrgId],
    );
    const response = await call<EvidenceCard & ApiErrorBody>(
      head,
      'POST',
      '/v1/investigate/adhoc/data',
      {
        // `status` is a column the allow-list shows, so the text reaches the excerpt; the id is the other org's.
        sql: `SELECT $1::text AS org_id, 'Zebulon Quixote reported the outage' AS status`,
        params: [otherOrgId],
        ticketId: ticketRef,
      },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.excerpt).not.toContain('Zebulon');
    expect(response.body.excerpt).not.toContain('Quixote');
    expect(response.body.excerpt).toMatch(/\[[A-Z_]*\d*\]/);
  });

  it('T-207a C-1: one person gets five ad-hoc data statements a minute', async () => {
    await clearBudget();
    const run = () =>
      call<ApiErrorBody>(lead, 'POST', '/v1/investigate/adhoc/data', {
        sql: 'SELECT 1 AS n',
        ticketId: ticketRef,
      });
    for (let i = 0; i < 5; i += 1) expect((await run()).status).toBe(201);
    expect((await run()).status).toBe(429);
    // Another person is not held by it.
    expect(
      (
        await call(head, 'POST', '/v1/investigate/adhoc/data', {
          sql: 'SELECT 1 AS n',
          ticketId: ticketRef,
        })
      ).status,
    ).toBe(201);
    await clearBudget();
  });

  it('runs a log filter of your own on an incident', async () => {
    await clearBudget();
    const incident = await owner().query<{ id: string }>(
      `INSERT INTO incident (title, severity) VALUES ('Delivery failing', 'SEV2') RETURNING id`,
    );
    const incidentId = incident.rows[0]?.id ?? '';
    const response = await call<EvidenceCard & ApiErrorBody>(
      lead,
      'POST',
      '/v1/investigate/adhoc/logs',
      {
        filter: `service="example-delivery" labels.org_ref="${orgId}"`,
        incidentId,
        windowMinutes: 30,
      },
    );
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      incidentId,
      ticketId: null,
      kind: 'logs',
      resultCount: 2,
    });
    const list = await call<{ items: EvidenceCard[] }>(
      agent,
      'GET',
      `/v1/incidents/${incidentId}/evidence`,
    );
    expect(list.body.items).toHaveLength(1);
    expect(
      (
        await call(lead, 'POST', '/v1/investigate/adhoc/logs', {
          filter: '',
          incidentId: randomUUID(),
        })
      ).status,
    ).toBe(404);
  });

  it('runs a template on an incident, where org_id must be given', async () => {
    await clearBudget();
    const incident = await owner().query<{ id: string }>(
      `INSERT INTO incident (title, severity) VALUES ('Second', 'SEV3') RETURNING id`,
    );
    const incidentId = incident.rows[0]?.id ?? '';
    const template = await newTemplate({
      kind: 'logs',
      name: `inc-${randomBytes(2).toString('hex')}`,
      title: 'Incident logs',
      body: LOG_FILTER,
    });
    expect(
      (
        await call(agent, 'POST', `/v1/incidents/${incidentId}/tools/run`, {
          templateId: template.id,
        })
      ).status,
    ).toBe(400);
    const ok = await call<EvidenceCard>(agent, 'POST', `/v1/incidents/${incidentId}/tools/run`, {
      templateId: template.id,
      params: { org_id: orgId },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.incidentId).toBe(incidentId);
    expect(
      (await call(agent, 'DELETE', `/v1/incidents/${incidentId}/evidence/${ok.body.id}`)).status,
    ).toBe(204);
  });
});

describe('the shared rate budget (N2)', () => {
  it('answers 429 with Retry-After once the logging budget is used, without calling the system, and records the refusal', async () => {
    await clearBudget();
    const template = await newTemplate({
      kind: 'logs',
      name: `budget-${randomBytes(2).toString('hex')}`,
      title: 'Budget',
      intentKey,
      body: LOG_FILTER,
    });
    await owner().query(
      `INSERT INTO rate_budget_window (resource, slot, total, ai) VALUES ('logging:default', date_trunc('second', clock_timestamp()), 55, 0)`,
    );
    const before = logs.queries.length;
    const response = await agent.client.request<ApiErrorBody>(
      'POST',
      `/v1/tickets/${ticketRef}/tools/run`,
      {
        body: { templateId: template.id },
      },
    );
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(logs.queries).toHaveLength(before);
    const denied = await owner().query<{ error_code: string; agent: string }>(
      `SELECT error_code, agent FROM tool_execution WHERE status = 'denied' AND tool = 'gcp_logs' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(denied.rows[0]).toEqual({ error_code: 'tool_rate', agent: 'human' });
    // Logs are used up, the data tool has a budget of its own.
    const data = await newTemplate({
      kind: 'data',
      name: `budget-data-${randomBytes(2).toString('hex')}`,
      title: 'Data',
      body: 'SELECT 1 AS n',
    });
    expect(
      (await call(agent, 'POST', `/v1/tickets/${ticketRef}/tools/run`, { templateId: data.id }))
        .status,
    ).toBe(201);
    await clearBudget();
  });

  it('caps one person at 20 a minute so one agent cannot starve the others, and holds the last 10 units for the AI', async () => {
    await clearBudget();
    const template = await newTemplate({
      kind: 'logs',
      name: `person-cap-${randomBytes(2).toString('hex')}`,
      title: 'Cap',
      intentKey,
      body: LOG_FILTER,
    });
    const run = (who: Persona) =>
      call<ApiErrorBody>(who, 'POST', `/v1/tickets/${ticketRef}/tools/run`, {
        templateId: template.id,
      });
    for (let i = 0; i < 20; i += 1) expect((await run(agent)).status, `run ${String(i)}`).toBe(201);
    const before = logs.queries.length;
    expect((await run(agent)).status).toBe(429);
    expect(logs.queries).toHaveLength(before);
    // A colleague still has the rest of the minute.
    expect((await run(lead)).status).toBe(201);
    // People together stop 10 units short of the total, which stay for the AI (55 - 10 = 45).
    await owner().query(
      `INSERT INTO rate_budget_window (resource, slot, total, ai) VALUES ('logging:default', date_trunc('second', clock_timestamp()) - interval '30 seconds', 23, 0)`,
    );
    expect((await run(head)).status).toBe(201);
    expect((await run(head)).status).toBe(429);
    const used = await owner().query<{ total: number; ai: number }>(
      `SELECT sum(total)::int AS total, sum(ai)::int AS ai FROM rate_budget_window WHERE resource = 'logging:default'`,
    );
    expect(used.rows[0]).toEqual({ total: 45, ai: 0 });
    await clearBudget();
  });

  it('turns a 429 of the provider itself into a 429 for the caller', async () => {
    await clearBudget();
    const template = await newTemplate({
      kind: 'logs',
      name: `provider429-${randomBytes(2).toString('hex')}`,
      title: 'Provider',
      intentKey,
      body: LOG_FILTER,
    });
    const quota = new FakeLogsClient({ entries: [], quotaPerMinute: 1 });
    await quota.listEntries({
      filter: '',
      pageSize: 1,
      from: new Date(Date.now() - 60_000),
      to: new Date(),
    });
    const original = toolClients.logs;
    toolClients.logs = quota;
    try {
      const response = await agent.client.request<ApiErrorBody>(
        'POST',
        `/v1/tickets/${ticketRef}/tools/run`,
        {
          body: { templateId: template.id },
        },
      );
      expect(response.status).toBe(429);
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
      const row = await owner().query<{ status: string; error_code: string }>(
        `SELECT status, error_code FROM tool_execution WHERE tool = 'gcp_logs' ORDER BY created_at DESC LIMIT 1`,
      );
      expect(row.rows[0]).toEqual({ status: 'error', error_code: 'ConnectorRateLimitedError' });
    } finally {
      toolClients.logs = original;
      await clearBudget();
    }
  });
});

describe('the service status panel (R-5.7)', () => {
  it('shows alert state, 24 hours of numbers, the last deploy and the open incidents of each service', async () => {
    await clearBudget();
    const created = await call<{ id: string }>(lead, 'POST', '/v1/services', {
      slug: 'example-delivery',
      name: 'Delivery',
    });
    expect(created.status).toBe(201);
    const serviceId = created.body.id;
    await call(lead, 'POST', '/v1/services', { slug: 'quiet-service', name: 'Quiet' });
    await owner().query(
      `INSERT INTO alert (fingerprint, source, title, state, severity, service_id, acked_at)
       VALUES ($1, 'alertmanager', 'High error rate', 'open', 'critical', $3, NULL),
              ($2, 'alertmanager', 'Slow', 'acknowledged', 'warning', $3, now())`,
      [randomBytes(32).toString('hex'), randomBytes(32).toString('hex'), serviceId],
    );
    await owner().query(
      `INSERT INTO deploy (service_id, service_slug, version, env, source, external_id, finished_at)
       VALUES ($1, 'example-delivery', 'v1.8.2', 'production', 'ci', $2, now() - interval '3 hours'),
              ($1, 'example-delivery', 'v1.8.1', 'production', 'ci', $3, now() - interval '2 days')`,
      [serviceId, randomUUID(), randomUUID()],
    );
    const incident = await owner().query<{ id: string; number: number }>(
      `INSERT INTO incident (title, severity) VALUES ('Delivery failing', 'SEV2') RETURNING id, number`,
    );
    await owner().query(`INSERT INTO incident_service (incident_id, service_id) VALUES ($1, $2)`, [
      incident.rows[0]?.id,
      serviceId,
    ]);
    // A resolved incident of the same service is not "open".
    const old = await owner().query<{ id: string }>(
      `INSERT INTO incident (title, severity, status, resolved_at) VALUES ('Old', 'SEV3', 'resolved', now()) RETURNING id`,
    );
    await owner().query(`INSERT INTO incident_service (incident_id, service_id) VALUES ($1, $2)`, [
      old.rows[0]?.id,
      serviceId,
    ]);

    const response = await call<ServiceStatusList>(agent, 'GET', '/v1/ops/services');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ windowHours: 24, stepMinutes: 30 });
    const delivery = response.body.items.find((item) => item.slug === 'example-delivery');
    expect(delivery).toMatchObject({
      state: 'alerting',
      alerts: { open: 1, acknowledged: 1, worstSeverity: 'critical' },
      metrics: { status: 'ok', mock: true },
      lastDeploy: { version: 'v1.8.2', env: 'production', source: 'ci' },
    });
    expect(delivery?.metrics.errorRate.length).toBeGreaterThanOrEqual(47);
    expect(delivery?.metrics.errorRate.length).toBeLessThanOrEqual(48);
    expect(delivery?.metrics.latencyP95Ms.length).toBe(delivery?.metrics.errorRate.length);
    expect(delivery?.openIncidents).toEqual([
      {
        id: incident.rows[0]?.id,
        number: incident.rows[0]?.number,
        title: 'Delivery failing',
        severity: 'SEV2',
        status: 'investigating',
      },
    ]);
    const quiet = response.body.items.find((item) => item.slug === 'quiet-service');
    expect(quiet).toMatchObject({
      state: 'ok',
      alerts: { open: 0, acknowledged: 0, worstSeverity: null },
      lastDeploy: null,
      openIncidents: [],
    });

    // Refreshing the screen does not spend the quota again: the numbers are reused for a minute.
    await call(agent, 'GET', '/v1/ops/services');
    const runs = await owner().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tool_execution WHERE agent = 'status_panel' AND tool = 'cloud_metrics' AND status = 'ok'`,
    );
    expect(runs.rows[0]?.n).toBe(2);
  });

  it('says rate_limited, with no numbers, for a service the budget refused, and not_connected without a client', async () => {
    await call(lead, 'POST', '/v1/services', { slug: 'late-service', name: 'Late' });
    await clearBudget();
    await owner().query(
      `INSERT INTO rate_budget_window (resource, slot, total, ai) VALUES ('monitoring:default', date_trunc('second', clock_timestamp()), 60, 0)`,
    );
    const limited = await call<ServiceStatusList>(agent, 'GET', '/v1/ops/services');
    const late = limited.body.items.find((item) => item.slug === 'late-service');
    expect(late?.metrics).toEqual({
      status: 'rate_limited',
      mock: true,
      errorRate: [],
      latencyP95Ms: [],
    });
    await clearBudget();

    await call(lead, 'POST', '/v1/services', { slug: 'unplugged', name: 'Unplugged' });
    const original = toolClients.metrics;
    toolClients.metrics = undefined;
    try {
      const response = await call<ServiceStatusList>(agent, 'GET', '/v1/ops/services');
      expect(response.body.items.find((item) => item.slug === 'unplugged')?.metrics).toEqual({
        status: 'not_connected',
        mock: true,
        errorRate: [],
        latencyP95Ms: [],
      });
    } finally {
      toolClients.metrics = original;
    }
  });
});
