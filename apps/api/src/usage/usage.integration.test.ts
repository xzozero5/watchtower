import { randomUUID } from 'node:crypto';

import { USAGE_AUDIT_ACTIONS, type HealthSnapshot, type Metric } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import { apiOrg, signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';

// T-205a and d on the real application module: only a head defines a metric, a template edit is audited,
// the Health Score is invisible to a customer on every route, and carries no cross-organization figure.
const net = disableNetConnect();

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let client: Persona;
let orgId: string;
let otherOrgId: string;
const owner = () => h.db.owner.pool;

beforeAll(async () => {
  h = await startHarness();
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  orgId = (await apiOrg(lead, { name: 'Health Org' })).id;
  otherOrgId = (await apiOrg(lead, { name: 'Other Health Org' })).id;
  client = await signIn(h, 'client', orgId);
});
afterAll(async () => {
  await h.close();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

const call = <T>(
  who: Persona,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
) => who.client.request<T>(method, path, body === undefined ? {} : { body });

const TEMPLATE =
  "SELECT date_trunc('hour', t) AS ts, count(*) AS value FROM x WHERE t >= $1 AND t < $2 GROUP BY 1";
const definition = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  name: `Metric ${key}`,
  sqlTemplate: TEMPLATE,
  dims: [],
  ...extra,
});

describe('access (RBAC)', () => {
  const someId = randomUUID();
  const ROUTES: readonly [string, string, unknown, 'lead' | 'head'][] = [
    ['GET', '/v1/usage/metrics', undefined, 'lead'],
    ['GET', `/v1/usage/metrics/${someId}`, undefined, 'lead'],
    ['GET', `/v1/usage/metrics/${someId}/points`, undefined, 'lead'],
    ['GET', '/v1/usage/anomalies', undefined, 'lead'],
    ['POST', '/v1/usage/metrics', definition('rbac_probe'), 'head'],
    ['PATCH', `/v1/usage/metrics/${someId}`, { name: 'x' }, 'head'],
    ['GET', `/v1/orgs/${someId}/health`, undefined, 'lead'],
    ['GET', '/v1/health/orgs', undefined, 'lead'],
  ];
  const personas = () => ({ agent, lead, head });
  const order = ['agent', 'lead', 'head'] as const;

  it.each(ROUTES)(
    '%s %s: from the stated role up; an agent below it, a customer and a visitor refused',
    async (method, path, body, minimum) => {
      for (const role of order) {
        const response = await call(personas()[role], method as 'GET', path, body);
        if (order.indexOf(role) < order.indexOf(minimum)) {
          expect(response.status, `${role} ${method} ${path}`).toBe(403);
        } else {
          expect([200, 201, 404, 409], `${role} ${method} ${path}`).toContain(response.status);
        }
      }
      expect((await call(client, method as 'GET', path, body)).status, `client ${path}`).toBe(403);
      const visitor = await h
        .client()
        .request(method, path, body === undefined ? {} : { body, csrf: false });
      expect(visitor.status, `visitor ${method} ${path}`).toBe(401);
    },
  );

  it('a customer cannot see the health of their own organization either', async () => {
    expect((await call(client, 'GET', `/v1/orgs/${orgId}/health`)).status).toBe(403);
    expect((await call(client, 'GET', '/v1/health/orgs')).status).toBe(403);
    expect((await call(client, 'GET', '/v1/usage/anomalies')).status).toBe(403);
  });
});

describe('metric definitions', () => {
  it('lets a head define one, shows the SQL to a head only, and refuses what is not a window query', async () => {
    const created = await call<Metric>(
      head,
      'POST',
      '/v1/usage/metrics',
      definition('visible_key'),
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      key: 'visible_key',
      templateVersion: 1,
      lastRunState: null,
    });
    expect(created.body.sqlTemplate).toBe(TEMPLATE);

    const asLead = await call<Metric>(lead, 'GET', `/v1/usage/metrics/${created.body.id}`);
    expect(asLead.status).toBe(200);
    expect(asLead.body.sqlTemplate).toBeNull();
    const list = await call<{ items: Metric[] }>(lead, 'GET', '/v1/usage/metrics');
    expect(list.body.items.every((metric) => metric.sqlTemplate === null)).toBe(true);

    for (const bad of [
      definition('writes_data', { sqlTemplate: 'DELETE FROM x WHERE a >= $1 AND a < $2' }),
      definition('two_statements', { sqlTemplate: 'SELECT 1 WHERE $1 < $2; SELECT 2' }),
      definition('no_window', { sqlTemplate: 'SELECT 1 FROM x' }),
      definition('extra_param', { sqlTemplate: 'SELECT 1 WHERE $1 < $2 AND a = $3' }),
      definition('reserved_dim', { dims: ['value'] }),
      definition('Bad Key'),
      definition('too_fast', { refreshIntervalSeconds: 5 }),
      { ...definition('extra_field'), password: 'x' },
    ]) {
      const response = await call<ApiErrorBody>(head, 'POST', '/v1/usage/metrics', bad);
      expect(response.status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
    expect((await call(head, 'POST', '/v1/usage/metrics', definition('visible_key'))).status).toBe(
      409,
    );
  });

  it('audits a template edit with hashes and a new version, and an ordinary edit without a new version', async () => {
    const created = await call<Metric>(
      head,
      'POST',
      '/v1/usage/metrics',
      definition('editable_metric'),
    );
    const edited = await call<Metric>(head, 'PATCH', `/v1/usage/metrics/${created.body.id}`, {
      sqlTemplate:
        "SELECT date_trunc('hour', t) AS ts, sum(n) AS value FROM x WHERE t >= $1 AND t < $2 GROUP BY 1",
    });
    expect(edited.status).toBe(200);
    expect(edited.body.templateVersion).toBe(2);
    const audit = await owner().query<{ actor_id: string; metadata: Record<string, unknown> }>(
      `SELECT actor_id, metadata FROM audit_log WHERE action = $1 AND target_id = $2`,
      [USAGE_AUDIT_ACTIONS.metricTemplateEdit, created.body.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.actor_id).toBe(head.userId);
    expect(audit.rows[0]?.metadata).toMatchObject({ version: 2, templateChanged: true });
    expect(JSON.stringify(audit.rows)).not.toContain('sum(n)');

    expect(
      (await call(lead, 'PATCH', `/v1/usage/metrics/${created.body.id}`, { name: 'Lead edit' }))
        .status,
    ).toBe(403);
    const renamed = await call<Metric>(head, 'PATCH', `/v1/usage/metrics/${created.body.id}`, {
      name: 'Renamed',
    });
    expect(renamed.body).toMatchObject({ name: 'Renamed', templateVersion: 2 });
  });

  it('serves cached points from our own database, newest first, filtered by organization', async () => {
    const created = await call<Metric>(
      head,
      'POST',
      '/v1/usage/metrics',
      definition('with_points', { dims: ['org'] }),
    );
    const id = created.body.id;
    const hash = (n: number) => n.toString(16).padStart(64, '0');
    for (const [i, org] of [orgId, otherOrgId, orgId].entries()) {
      await owner().query(
        `INSERT INTO usage_metric_point (metric_id, ts, dims_hash, org_id, dims, value)
         VALUES ($1, '2030-05-01T00:00:00Z'::timestamptz + make_interval(hours => $2), $3, $4, '{}', $5)`,
        [id, i, hash(i + 1), org, 10 + i],
      );
    }
    const all = await call<{ items: { value: number; orgId: string }[] }>(
      lead,
      'GET',
      `/v1/usage/metrics/${id}/points`,
    );
    expect(all.body.items.map((p) => p.value)).toEqual([12, 11, 10]);
    const one = await call<{ items: { value: number }[] }>(
      lead,
      'GET',
      `/v1/usage/metrics/${id}/points?orgId=${otherOrgId}`,
    );
    expect(one.body.items.map((p) => p.value)).toEqual([11]);
  });
});

describe('the stored score does not leak through the organization record', () => {
  it('is shown to a lead and hidden from an agent and from the customer, on the record and in the list', async () => {
    await owner().query('UPDATE organization SET health_score = 64 WHERE id = $1', [orgId]);
    type Org = { id: string; healthScore: number | null };
    for (const [who, expected] of [
      [lead, 64],
      [head, 64],
      [agent, null],
      [client, null],
    ] as const) {
      const one = await call<Org>(who, 'GET', `/v1/orgs/${orgId}`);
      expect(one.status).toBe(200);
      expect(one.body.healthScore, who.email).toBe(expected);
      const list = await call<{ items: Org[] }>(who, 'GET', '/v1/orgs');
      expect(list.body.items.find((org) => org.id === orgId)?.healthScore, who.email).toBe(
        expected,
      );
      expect(JSON.stringify(one.body)).toContain('healthScore');
    }
    // Setting it by hand needs the permission to read it.
    const asLead = await call<Org>(lead, 'PATCH', `/v1/orgs/${orgId}`, { healthScore: 70 });
    expect(asLead.body.healthScore).toBe(70);
  });
});

describe('the Client Health Score routes', () => {
  async function snapshot(
    org: string,
    status: string,
    score: number | null,
    day = '2030-05-01',
    version = 1,
  ) {
    const components = Object.fromEntries(
      ['ticket_volume', 'sla', 'csat', 'incidents', 'usage_anomalies'].map((key) => [
        key,
        { key, weight: 0.2, status: 'no_data', score: null, detail: {} },
      ]),
    );
    await owner().query(
      `INSERT INTO org_health_snapshot (org_id, day, formula_version, status, score, components) VALUES ($1, $2, $3, $4, $5, $6)`,
      [org, day, version, status, score, components],
    );
  }

  it('says there is no snapshot yet, then "not enough data" as such, then a score', async () => {
    const none = await call<{ snapshot: HealthSnapshot | null }>(
      lead,
      'GET',
      `/v1/orgs/${orgId}/health`,
    );
    expect(none.status).toBe(200);
    expect(none.body.snapshot).toBeNull();

    await snapshot(orgId, 'insufficient_data', null, '2030-05-01');
    const young = await call<{ snapshot: HealthSnapshot }>(lead, 'GET', `/v1/orgs/${orgId}/health`);
    expect(young.body.snapshot).toMatchObject({
      status: 'insufficient_data',
      score: null,
      formulaVersion: 1,
    });
    expect(young.body.snapshot.components.map((c) => c.status)).toEqual(Array(5).fill('no_data'));

    await snapshot(orgId, 'scored', 72, '2030-05-02');
    // A snapshot of another formula version is not mixed in.
    await snapshot(orgId, 'scored', 5, '2030-05-03', 2);
    const later = await call<{ snapshot: HealthSnapshot }>(lead, 'GET', `/v1/orgs/${orgId}/health`);
    expect(later.body.snapshot).toMatchObject({ status: 'scored', score: 72, day: '2030-05-02' });
  });

  it('lists organizations lowest first, with no rank, share or average anywhere', async () => {
    await snapshot(otherOrgId, 'scored', 40, '2030-05-02');
    const list = await call<{ items: { orgId: string; score: number | null }[] }>(
      lead,
      'GET',
      '/v1/health/orgs',
    );
    expect(list.status).toBe(200);
    expect(list.body.items.map((item) => item.score)).toEqual([40, 72]);
    for (const text of [
      JSON.stringify(list.body),
      JSON.stringify((await call(lead, 'GET', `/v1/orgs/${orgId}/health`)).body),
    ]) {
      expect(text).not.toMatch(/rank|percentile|average|benchmark|median|peer/i);
    }
    expect(Object.keys(list.body.items[0] ?? {}).toSorted()).toEqual([
      'day',
      'orgId',
      'score',
      'status',
    ]);
  });
});
