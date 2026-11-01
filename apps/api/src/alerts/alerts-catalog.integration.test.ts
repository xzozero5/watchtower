import { randomUUID } from 'node:crypto';

import {
  ALERTS_AUDIT_ACTIONS,
  DEFAULT_ESCALATION_STEPS,
  type AlertDetail,
  type EscalationPolicy,
  type Service,
} from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import { signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';

// T-201b on the real application module: the service catalog, escalation policies and the alert
// reads. RBAC for every route (agent / lead / head / client / no session), audit rows, validation,
// "unmapped", pagination.
const net = disableNetConnect();

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let client: Persona;
let fingerprintCounter = 100;
const owner = () => h.db.owner.pool;
const fp = (): string => (++fingerprintCounter).toString(16).padStart(64, '0');

beforeAll(async () => {
  h = await startHarness();
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  const org = await owner().query<{ id: string }>(
    `INSERT INTO organization (name) VALUES ('Client org') RETURNING id`,
  );
  client = await signIn(h, 'client', org.rows[0]?.id);
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

async function insertAlert(fields: {
  title?: string;
  state?: string;
  source?: string;
  serviceId?: string | null;
  count?: number;
  lastSeen?: string;
}) {
  const result = await owner().query<{ id: string }>(
    `INSERT INTO alert (fingerprint, source, title, state, service_id, count, last_seen_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, clock_timestamp()),
             CASE WHEN $4 = 'resolved' THEN clock_timestamp() END)
     RETURNING id`,
    [
      fp(),
      fields.source ?? 'alertmanager',
      fields.title ?? 'High error rate',
      fields.state ?? 'open',
      fields.serviceId ?? null,
      fields.count ?? 1,
      fields.lastSeen ?? null,
    ],
  );
  return result.rows[0]?.id ?? '';
}

describe('access (RBAC)', () => {
  const someId = randomUUID();
  // method, path, body, roles allowed (anyone else: 403, no session: 401)
  const ROUTES: readonly [string, string, unknown, readonly ('agent' | 'lead' | 'head')[]][] = [
    ['GET', '/v1/alerts', undefined, ['agent', 'lead', 'head']],
    ['GET', '/v1/alerts/unmapped', undefined, ['agent', 'lead', 'head']],
    ['GET', `/v1/alerts/${someId}`, undefined, ['agent', 'lead', 'head']],
    ['GET', '/v1/services', undefined, ['agent', 'lead', 'head']],
    ['GET', `/v1/services/${someId}`, undefined, ['agent', 'lead', 'head']],
    ['GET', '/v1/escalation-policies', undefined, ['agent', 'lead', 'head']],
    ['POST', '/v1/services', { slug: 'rbac-probe', name: 'Probe' }, ['lead', 'head']],
    ['PATCH', `/v1/services/${someId}`, { name: 'x' }, ['lead', 'head']],
    ['DELETE', `/v1/services/${someId}`, undefined, ['lead', 'head']],
    [
      'POST',
      '/v1/escalation-policies',
      { name: 'rbac-probe', steps: DEFAULT_ESCALATION_STEPS },
      ['lead', 'head'],
    ],
    ['PATCH', `/v1/escalation-policies/${someId}`, { name: 'x' }, ['lead', 'head']],
    ['DELETE', `/v1/escalation-policies/${someId}`, undefined, ['lead', 'head']],
  ];

  it.each(ROUTES)(
    '%s %s: only the roles that hold the permission',
    async (method, path, body, allowed) => {
      const people = { agent, lead, head } as const;
      for (const role of ['agent', 'lead', 'head'] as const) {
        const response = await call(people[role], method as 'GET', path, body);
        if (allowed.includes(role)) {
          // Allowed means "past the guard": a created row, a not-found for a made-up id or a name that is
          // already taken, never 401/403.
          expect([200, 201, 204, 404, 409], `${role} ${method} ${path}`).toContain(response.status);
        } else {
          expect(response.status, `${role} ${method} ${path}`).toBe(403);
        }
      }
      // A client user is a customer: none of this is theirs.
      expect((await call(client, method as 'GET', path, body)).status, `client ${path}`).toBe(403);
      const anonymous = await h
        .client()
        .request(method, path, body === undefined ? {} : { body, csrf: false });
      expect(anonymous.status, `anonymous ${method} ${path}`).toBe(401);
    },
  );
});

describe('service catalog', () => {
  let created: Service;
  let queueId: string;

  beforeAll(async () => {
    const queue = await owner().query<{ id: string }>(
      `INSERT INTO team_queue (name) VALUES ('Platform') RETURNING id`,
    );
    queueId = queue.rows[0]?.id ?? '';
  });

  it('creates a service with a match rule, owner queue and runbook, and audits it', async () => {
    const response = await call<Service>(lead, 'POST', '/v1/services', {
      slug: 'checkout',
      name: 'Checkout',
      ownerQueueId: queueId,
      runbookUrl: 'https://runbooks.example.invalid/checkout',
      dashboardUrl: 'https://dashboards.example.invalid/checkout',
      matchRules: [{ source: 'alertmanager', labels: { service: 'checkout' } }],
      repos: ['example-org/checkout'],
    });
    expect(response.status).toBe(201);
    created = response.body;
    expect(created).toMatchObject({
      slug: 'checkout',
      ownerQueueId: queueId,
      escalationPolicyId: null,
      active: true,
      matchRules: [{ source: 'alertmanager', labels: { service: 'checkout' } }],
      repos: ['example-org/checkout'],
    });
    const audit = await owner().query<{ actor_id: string; target_id: string; metadata: unknown }>(
      `SELECT actor_id, target_id, metadata FROM audit_log
        WHERE action = $1 AND target_id = $2 AND outcome = 'success'`,
      [ALERTS_AUDIT_ACTIONS.serviceCreate, created.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_id: lead.userId,
      target_id: created.id,
      metadata: { slug: 'checkout' },
    });
  });

  it('refuses a bad slug, an unknown field, a bad rule, a bad url, an unknown queue and a repeat slug', async () => {
    const bad: [string, unknown, number][] = [
      ['bad slug', { slug: 'Check Out', name: 'x' }, 400],
      ['unknown field', { slug: 'ok-slug', name: 'x', owner: 'someone' }, 400],
      ['empty rule', { slug: 'ok-slug', name: 'x', matchRules: [{}] }, 400],
      [
        'label that alerts do not keep',
        { slug: 'ok-slug', name: 'x', matchRules: [{ labels: { customer: 'a' } }] },
        400,
      ],
      ['javascript url', { slug: 'ok-slug', name: 'x', runbookUrl: 'javascript:alert(1)' }, 400],
      ['unknown queue', { slug: 'ok-slug', name: 'x', ownerQueueId: randomUUID() }, 400],
      ['unknown policy', { slug: 'ok-slug', name: 'x', escalationPolicyId: randomUUID() }, 400],
      ['repeat slug', { slug: 'checkout', name: 'again' }, 409],
    ];
    for (const [label, body, status] of bad) {
      const response = await call<ApiErrorBody>(lead, 'POST', '/v1/services', body);
      expect(response.status, label).toBe(status);
    }
  });

  it('lists, reads and edits a service; an edit audits the fields it changed', async () => {
    const list = await call<{ items: Service[] }>(agent, 'GET', '/v1/services');
    expect(list.body.items.map((item) => item.slug)).toContain('checkout');
    expect((await call<Service>(agent, 'GET', `/v1/services/${created.id}`)).body.id).toBe(
      created.id,
    );

    const edit = await call<Service>(head, 'PATCH', `/v1/services/${created.id}`, {
      name: 'Checkout API',
      active: false,
    });
    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({ name: 'Checkout API', active: false, slug: 'checkout' });
    const audit = await owner().query<{ metadata: { fields: string[] } }>(
      `SELECT metadata FROM audit_log WHERE action = $1 AND target_id = $2 AND outcome = 'success'`,
      [ALERTS_AUDIT_ACTIONS.serviceUpdate, created.id],
    );
    expect(audit.rows[0]?.metadata.fields).toEqual(['active', 'name']);
    expect((await call(head, 'PATCH', `/v1/services/${created.id}`, {})).status).toBe(400);
  });

  it('deleting a service keeps its alerts and un-maps them', async () => {
    const service = await call<Service>(lead, 'POST', '/v1/services', {
      slug: 'to-delete',
      name: 'Delete me',
    });
    const alertId = await insertAlert({ serviceId: service.body.id, title: 'Mapped then not' });
    const removed = await call(lead, 'DELETE', `/v1/services/${service.body.id}`);
    expect(removed.status).toBe(204);
    expect((await call(lead, 'DELETE', `/v1/services/${service.body.id}`)).status).toBe(404);
    const detail = await call<AlertDetail>(agent, 'GET', `/v1/alerts/${alertId}`);
    expect(detail.body.serviceId).toBeNull();
    const audit = await owner().query(
      `SELECT 1 FROM audit_log WHERE action = $1 AND target_id = $2 AND outcome = 'success'`,
      [ALERTS_AUDIT_ACTIONS.serviceDelete, service.body.id],
    );
    expect(audit.rowCount).toBe(1);
  });
});

describe('escalation policies', () => {
  let policy: EscalationPolicy;

  it('lists the seeded default, and only one default', async () => {
    const list = await call<{ items: EscalationPolicy[] }>(agent, 'GET', '/v1/escalation-policies');
    const defaults = list.body.items.filter((item) => item.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.steps).toEqual(DEFAULT_ESCALATION_STEPS);
  });

  it('creates and edits a policy, audits both, and validates the steps', async () => {
    const created = await call<EscalationPolicy>(lead, 'POST', '/v1/escalation-policies', {
      name: 'Night shift',
      steps: [
        { target: 'on_shift', afterSeconds: 0 },
        { target: 'head', afterSeconds: 120 },
      ],
    });
    expect(created.status).toBe(201);
    policy = created.body;
    expect(policy).toMatchObject({ name: 'Night shift', isDefault: false });

    const edit = await call<EscalationPolicy>(
      lead,
      'PATCH',
      `/v1/escalation-policies/${policy.id}`,
      {
        steps: [
          { target: 'on_shift', afterSeconds: 0 },
          { target: 'lead', afterSeconds: 60 },
        ],
      },
    );
    expect(edit.status).toBe(200);
    expect(edit.body.steps.at(1)).toEqual({ target: 'lead', afterSeconds: 60 });

    for (const [label, body, status] of [
      ['not starting at zero', { name: 'x1', steps: [{ target: 'lead', afterSeconds: 30 }] }, 400],
      [
        'not increasing',
        {
          name: 'x2',
          steps: [
            { target: 'on_shift', afterSeconds: 0 },
            { target: 'lead', afterSeconds: 0 },
          ],
        },
        400,
      ],
      ['unknown target', { name: 'x3', steps: [{ target: 'ceo', afterSeconds: 0 }] }, 400],
      ['no steps', { name: 'x4' }, 400],
      ['same name, other case', { name: 'NIGHT SHIFT', steps: DEFAULT_ESCALATION_STEPS }, 409],
    ] as const) {
      const response = await call<ApiErrorBody>(lead, 'POST', '/v1/escalation-policies', body);
      expect(response.status, label).toBe(status);
    }
    const actions = await owner().query<{ action: string }>(
      `SELECT action FROM audit_log
        WHERE action LIKE 'escalation_policy.%' AND target_id = $1 AND outcome = 'success'
        ORDER BY created_at`,
      [policy.id],
    );
    expect(actions.rows.map((row) => row.action)).toEqual([
      ALERTS_AUDIT_ACTIONS.escalationPolicyCreate,
      ALERTS_AUDIT_ACTIONS.escalationPolicyUpdate,
    ]);
  });

  it('a service can use a policy; deleting the policy returns it to the default, and the default stays', async () => {
    const service = await call<Service>(lead, 'POST', '/v1/services', {
      slug: 'night-svc',
      name: 'Night service',
      escalationPolicyId: policy.id,
    });
    expect(service.body.escalationPolicyId).toBe(policy.id);
    expect((await call(lead, 'DELETE', `/v1/escalation-policies/${policy.id}`)).status).toBe(204);
    const after = await call<Service>(agent, 'GET', `/v1/services/${service.body.id}`);
    expect(after.body.escalationPolicyId).toBeNull();

    const list = await call<{ items: EscalationPolicy[] }>(agent, 'GET', '/v1/escalation-policies');
    const defaultId = list.body.items.find((item) => item.isDefault)?.id ?? '';
    const refused = await call<ApiErrorBody>(
      head,
      'DELETE',
      `/v1/escalation-policies/${defaultId}`,
    );
    expect(refused.status).toBe(409);
  });
});

describe('alert reads', () => {
  it('lists newest activity first, filters, and pages with a cursor', async () => {
    await owner().query('DELETE FROM alert');
    const a = await insertAlert({ title: 'Oldest', lastSeen: '2026-11-01T01:00:00Z' });
    const b = await insertAlert({
      title: 'Middle',
      state: 'resolved',
      lastSeen: '2026-11-01T02:00:00Z',
    });
    const c = await insertAlert({
      title: 'Newest',
      source: 'gcp_monitoring',
      lastSeen: '2026-11-01T03:00:00Z',
    });

    const all = await call<{ items: { id: string; title: string }[]; nextCursor: string | null }>(
      agent,
      'GET',
      '/v1/alerts',
    );
    expect(all.body.items.map((item) => item.id)).toEqual([c, b, a]);

    const open = await call<{ items: { id: string }[] }>(agent, 'GET', '/v1/alerts?state=open');
    expect(open.body.items.map((item) => item.id)).toEqual([c, a]);
    const gcp = await call<{ items: { id: string }[] }>(
      agent,
      'GET',
      '/v1/alerts?source=gcp_monitoring',
    );
    expect(gcp.body.items.map((item) => item.id)).toEqual([c]);

    const first = await call<{ items: { id: string }[]; nextCursor: string }>(
      agent,
      'GET',
      '/v1/alerts?limit=2',
    );
    expect(first.body.items.map((item) => item.id)).toEqual([c, b]);
    const second = await call<{ items: { id: string }[]; nextCursor: string | null }>(
      agent,
      'GET',
      `/v1/alerts?limit=2&cursor=${first.body.nextCursor}`,
    );
    expect(second.body.items.map((item) => item.id)).toEqual([a]);
    expect(second.body.nextCursor).toBeNull();

    expect((await call(agent, 'GET', '/v1/alerts?state=weird')).status).toBe(400);
    expect((await call(agent, 'GET', '/v1/alerts?limit=1000')).status).toBe(400);
    expect((await call(agent, 'GET', '/v1/alerts?cursor=not-a-cursor')).status).toBe(400);
  });

  it('shows one alert with its deliveries, and 404 for an unknown or malformed id', async () => {
    const id = await insertAlert({ title: 'With events' });
    await owner().query(
      `INSERT INTO alert_event (alert_id, source, provider_event_id, type, occurred_at)
       VALUES ($1, 'alertmanager', 'evt-a', 'fired', '2026-11-02T03:00:00Z')`,
      [id],
    );
    const detail = await call<AlertDetail>(lead, 'GET', `/v1/alerts/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.events).toEqual([
      expect.objectContaining({ type: 'fired', occurredAt: '2026-11-02T03:00:00.000Z' }),
    ]);
    expect((await call(lead, 'GET', `/v1/alerts/${randomUUID()}`)).status).toBe(404);
    expect((await call(lead, 'GET', '/v1/alerts/not-a-uuid')).status).toBe(400);
  });

  it('the unmapped bucket groups alerts no service claims, within the last 7 days', async () => {
    await owner().query('DELETE FROM alert');
    const service = await owner().query<{ id: string }>(
      `INSERT INTO service (slug, name) VALUES ('mapped-svc', 'Mapped') RETURNING id`,
    );
    await insertAlert({ title: 'Noisy', count: 4 });
    await insertAlert({ title: 'Noisy', state: 'resolved', count: 2 });
    await insertAlert({ title: 'Other', source: 'gcp_logging' });
    await insertAlert({ title: 'Claimed', serviceId: service.rows[0]?.id ?? null });
    await insertAlert({ title: 'Too old', lastSeen: '2020-01-01T00:00:00Z' });

    const response = await call<{
      windowDays: number;
      items: {
        source: string;
        title: string;
        alerts: number;
        occurrences: number;
        openAlerts: number;
      }[];
    }>(lead, 'GET', '/v1/alerts/unmapped');
    expect(response.status).toBe(200);
    expect(response.body.windowDays).toBe(7);
    const byTitle = Object.fromEntries(response.body.items.map((item) => [item.title, item]));
    expect(Object.keys(byTitle).toSorted()).toEqual(['Noisy', 'Other']);
    expect(byTitle.Noisy).toMatchObject({ alerts: 2, occurrences: 6, openAlerts: 1 });

    const filtered = await call<{ items: { id: string }[] }>(
      lead,
      'GET',
      '/v1/alerts?unmapped=true',
    );
    expect(filtered.body.items).toHaveLength(4);
  });

  it('never sends back anything outside the schema: no unknown columns, payload as stored', async () => {
    const id = await insertAlert({ title: 'Shape' });
    const detail = await call<Record<string, unknown>>(agent, 'GET', `/v1/alerts/${id}`);
    expect(Object.keys(detail.body).toSorted()).toEqual(
      [
        'ackedAt',
        'ackedBy',
        'ackedVia',
        'correlationId',
        'count',
        'escalationLevel',
        'events',
        'fingerprint',
        'firstSeenAt',
        'id',
        'incidentId',
        'lastSeenAt',
        'nextEscalationAt',
        'payload',
        'resolvedAt',
        'serviceId',
        'severity',
        'snoozeReason',
        'snoozedUntil',
        'source',
        'state',
        'summary',
        'title',
      ].toSorted(),
    );
  });
});
