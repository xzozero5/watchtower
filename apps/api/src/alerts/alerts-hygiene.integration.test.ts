import { randomBytes, randomUUID } from 'node:crypto';

import { alerts } from '@watchtower/connectors';
import {
  ALERTS_AUDIT_ACTIONS,
  ALERT_WEBHOOK_SIGNATURE_HEADER,
  ALERT_SNOOZE_MAX_MINUTES,
  type AlertSnoozeResult,
  type CorrelationGroup,
  type CorrelationRule,
  type Heartbeat,
  type NoiseReport,
} from '@watchtower/shared';
import { heartbeatFingerprint } from '@watchtower/domain';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import { signIn, type Persona } from '../testing/ticketing.js';

// T-201e on the real application module: snooze with expiry and reason, heartbeats (CRUD and the signed
// signal), correlation rules and groups, noise metrics. RBAC on every route, audit rows, validation.
const SECRET = randomBytes(24).toString('hex');
const net = disableNetConnect();

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let client: Persona;
let counter = 7000;
let ipCounter = 0;
const owner = () => h.db.owner.pool;
const freshIp = (): string => `198.51.100.${String(++ipCounter % 250)}`;

beforeAll(async () => {
  h = await startHarness({ env: { ALERT_WEBHOOK_SECRET: SECRET } });
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  const org = await owner().query<{ id: string }>(
    `INSERT INTO organization (name) VALUES ('Hygiene org') RETURNING id`,
  );
  client = await signIn(h, 'client', org.rows[0]?.id);
  // An incident for the alerts that count as part of one (the noise metrics).
  await owner().query(
    `INSERT INTO incident (title, severity) VALUES ('Existing incident', 'SEV3')`,
  );
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

async function insertAlert(
  fields: {
    title?: string;
    state?: string;
    ackedAt?: boolean;
    incident?: boolean;
    correlationId?: string;
    serviceId?: string;
    count?: number;
  } = {},
): Promise<string> {
  counter += 1;
  const result = await owner().query<{ id: string }>(
    `INSERT INTO alert (fingerprint, source, title, state, count, acked_at, incident_id, correlation_id, service_id, resolved_at)
     VALUES ($1, 'alertmanager', $2, $3, $4,
             CASE WHEN $5 THEN clock_timestamp() END, CASE WHEN $6 THEN (SELECT id FROM incident ORDER BY created_at LIMIT 1) END, $7, $8,
             CASE WHEN $3 = 'resolved' THEN clock_timestamp() END)
     RETURNING id`,
    [
      counter.toString(16).padStart(64, '0'),
      fields.title ?? 'High error rate',
      fields.state ?? 'open',
      fields.count ?? 1,
      fields.ackedAt ?? false,
      fields.incident ?? false,
      fields.correlationId ?? null,
      fields.serviceId ?? null,
    ],
  );
  return result.rows[0]?.id ?? '';
}

const STAFF = ['agent', 'lead', 'head'] as const;
const MANAGERS = ['lead', 'head'] as const;

describe('access (RBAC)', () => {
  const someId = randomUUID();
  const ROUTES: readonly [string, string, unknown, readonly ('agent' | 'lead' | 'head')[]][] = [
    ['GET', '/v1/alerts/correlations', undefined, STAFF],
    ['GET', '/v1/alerts/noise', undefined, STAFF],
    ['GET', '/v1/heartbeats', undefined, STAFF],
    ['GET', '/v1/correlation-rules', undefined, STAFF],
    ['POST', `/v1/alerts/${someId}/snooze`, { minutes: 5, reason: 'rbac probe' }, MANAGERS],
    ['POST', `/v1/alerts/${someId}/unsnooze`, undefined, MANAGERS],
    [
      'POST',
      '/v1/heartbeats',
      { slug: 'rbac-probe', name: 'Probe', expectedIntervalSeconds: 60 },
      MANAGERS,
    ],
    ['PATCH', `/v1/heartbeats/${someId}`, { name: 'x' }, MANAGERS],
    ['DELETE', `/v1/heartbeats/${someId}`, undefined, MANAGERS],
    [
      'POST',
      '/v1/correlation-rules',
      { name: 'rbac-probe', windowMinutes: 5, minAlerts: 2 },
      MANAGERS,
    ],
    ['PATCH', `/v1/correlation-rules/${someId}`, { name: 'x' }, MANAGERS],
    ['DELETE', `/v1/correlation-rules/${someId}`, undefined, MANAGERS],
  ];

  it.each(ROUTES)(
    '%s %s: only the roles that hold the permission',
    async (method, path, body, allowed) => {
      const people = { agent, lead, head } as const;
      for (const role of ['agent', 'lead', 'head'] as const) {
        const response = await call(people[role], method as 'GET', path, body);
        if (allowed.includes(role)) {
          expect([200, 201, 204, 404, 409], `${role} ${method} ${path}`).toContain(response.status);
        } else {
          expect(response.status, `${role} ${method} ${path}`).toBe(403);
        }
      }
      expect((await call(client, method as 'GET', path, body)).status, `client ${path}`).toBe(403);
      const anonymous = await h
        .client()
        .request(method, path, body === undefined ? {} : { body, csrf: false });
      expect(anonymous.status, `anonymous ${method} ${path}`).toBe(401);
    },
  );
});

describe('snooze (R-3.9)', () => {
  it('snoozes with a reason and a time, audits it, and lists it for the handoff', async () => {
    const alertId = await insertAlert();
    const response = await call<AlertSnoozeResult>(lead, 'POST', `/v1/alerts/${alertId}/snooze`, {
      minutes: 45,
      reason: 'Planned failover',
    });
    expect(response.status).toBe(200);
    expect(response.body.changed).toBe(true);
    expect(response.body.alert.snoozeReason).toBe('Planned failover');
    const until = Date.parse(response.body.alert.snoozedUntil ?? '');
    expect(until).toBeGreaterThan(Date.now() + 44 * 60_000 - 60_000);
    expect(until).toBeLessThan(Date.now() + 46 * 60_000);

    const audited = await owner().query<{ actor_id: string; metadata: { minutes: number } }>(
      `SELECT actor_id, metadata FROM audit_log WHERE action = $1 AND target_id = $2`,
      [ALERTS_AUDIT_ACTIONS.alertSnooze, alertId],
    );
    expect(audited.rows).toHaveLength(1);
    expect(audited.rows[0]).toMatchObject({ actor_id: lead.userId, metadata: { minutes: 45 } });

    const listed = await call<{ items: { id: string }[] }>(
      agent,
      'GET',
      '/v1/alerts?snoozed=true&limit=100',
    );
    expect(listed.body.items.map((item) => item.id)).toContain(alertId);
  });

  it('refuses a missing reason, no time, a time past the longest, and a resolved alert', async () => {
    const alertId = await insertAlert();
    const path = `/v1/alerts/${alertId}/snooze`;
    expect((await call(lead, 'POST', path, { minutes: 10 })).status).toBe(400);
    expect((await call(lead, 'POST', path, { reason: 'because' })).status).toBe(400);
    expect((await call(lead, 'POST', path, { minutes: 10, reason: '  ' })).status).toBe(400);
    expect((await call(lead, 'POST', path, { minutes: 0, reason: 'because' })).status).toBe(400);
    expect(
      (await call(lead, 'POST', path, { minutes: ALERT_SNOOZE_MAX_MINUTES + 1, reason: 'because' }))
        .status,
    ).toBe(400);
    // The client cannot hand in a timestamp of its own.
    expect(
      (await call(lead, 'POST', path, { until: '2099-01-01T00:00:00Z', reason: 'because' })).status,
    ).toBe(400);
    const resolved = await insertAlert({ state: 'resolved' });
    expect(
      (await call(lead, 'POST', `/v1/alerts/${resolved}/snooze`, { minutes: 5, reason: 'late' }))
        .status,
    ).toBe(409);
    expect(
      (await call(lead, 'POST', `/v1/alerts/${randomUUID()}/snooze`, { minutes: 5, reason: 'who' }))
        .status,
    ).toBe(404);
  });

  it('lifts a snooze by hand, once', async () => {
    const alertId = await insertAlert();
    await call(lead, 'POST', `/v1/alerts/${alertId}/snooze`, { minutes: 30, reason: 'Watching' });
    const lifted = await call<AlertSnoozeResult>(lead, 'POST', `/v1/alerts/${alertId}/unsnooze`);
    expect(lifted.body.changed).toBe(true);
    expect(lifted.body.alert.snoozedUntil).toBeNull();
    const again = await call<AlertSnoozeResult>(lead, 'POST', `/v1/alerts/${alertId}/unsnooze`);
    expect(again.body.changed).toBe(false);
  });
});

describe('heartbeats (R-3.10)', () => {
  const beatPath = (slug: string) => `/v1/inbound/heartbeats/${slug}`;
  async function sendBeat(slug: string, header: string | undefined, raw = '{}') {
    const response = await fetch(`${h.base}${beatPath(slug)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': freshIp(),
        ...(header === undefined ? {} : { [ALERT_WEBHOOK_SIGNATURE_HEADER]: header }),
      },
      body: raw,
    });
    return { status: response.status, body: await response.json().catch((): unknown => null) };
  }
  const sign = (raw = '{}', offsetSeconds = 0) =>
    alerts.signAlertWebhook({
      rawBody: raw,
      secret: SECRET,
      timestampSeconds: Math.floor(Date.now() / 1000) + offsetSeconds,
    });

  it('creates, lists, edits and removes a heartbeat, each audited', async () => {
    const created = await call<Heartbeat>(lead, 'POST', '/v1/heartbeats', {
      slug: 'nightly-export',
      name: 'Nightly export',
      expectedIntervalSeconds: 3600,
      graceSeconds: 120,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      slug: 'nightly-export',
      state: 'ok',
      severity: 'error',
      active: true,
      lastBeatAt: null,
    });
    expect(
      (
        await call(lead, 'POST', '/v1/heartbeats', {
          slug: 'nightly-export',
          name: 'Again',
          expectedIntervalSeconds: 60,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(lead, 'POST', '/v1/heartbeats', {
          slug: 'too-quick',
          name: 'Too quick',
          expectedIntervalSeconds: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(lead, 'POST', '/v1/heartbeats', {
          slug: 'no-such-service',
          name: 'Orphan',
          expectedIntervalSeconds: 60,
          serviceId: randomUUID(),
        })
      ).status,
    ).toBe(400);

    const patched = await call<Heartbeat>(lead, 'PATCH', `/v1/heartbeats/${created.body.id}`, {
      graceSeconds: 300,
      active: false,
    });
    expect(patched.body).toMatchObject({ graceSeconds: 300, active: false });
    const list = await call<{ items: Heartbeat[] }>(agent, 'GET', '/v1/heartbeats');
    expect(list.body.items.map((item) => item.slug)).toContain('nightly-export');

    expect((await call(lead, 'DELETE', `/v1/heartbeats/${created.body.id}`)).status).toBe(204);
    expect((await call(lead, 'DELETE', `/v1/heartbeats/${created.body.id}`)).status).toBe(404);
    const audited = await owner().query<{ action: string }>(
      `SELECT action FROM audit_log WHERE target_id = $1 AND outcome = 'success' ORDER BY created_at`,
      [created.body.id],
    );
    expect(audited.rows.map((row) => row.action)).toEqual([
      ALERTS_AUDIT_ACTIONS.heartbeatCreate,
      ALERTS_AUDIT_ACTIONS.heartbeatUpdate,
      ALERTS_AUDIT_ACTIONS.heartbeatDelete,
    ]);
  });

  it('a signed signal stamps the heartbeat with the database clock', async () => {
    const created = await call<Heartbeat>(lead, 'POST', '/v1/heartbeats', {
      slug: 'warehouse-sync',
      name: 'Warehouse sync',
      expectedIntervalSeconds: 600,
    });
    const response = await sendBeat('warehouse-sync', sign());
    expect(response).toEqual({ status: 200, body: { recovered: false } });
    const row = await owner().query<{ last_beat_at: Date | null }>(
      `SELECT last_beat_at FROM heartbeat WHERE id = $1`,
      [created.body.id],
    );
    expect(row.rows[0]?.last_beat_at).not.toBeNull();
  });

  it('a missing heartbeat is brought back by the next signal, which resolves its alert', async () => {
    const created = await call<Heartbeat>(lead, 'POST', '/v1/heartbeats', {
      slug: 'report-mailer',
      name: 'Report mailer',
      expectedIntervalSeconds: 600,
    });
    // As the worker's sweep would have left it.
    await owner().query(
      `UPDATE heartbeat SET state = 'missing', missing_since = clock_timestamp() WHERE id = $1`,
      [created.body.id],
    );
    const fingerprint = heartbeatFingerprint(created.body.id);
    await owner().query(
      `INSERT INTO alert (fingerprint, source, title) VALUES ($1, 'heartbeat', 'Heartbeat missing: Report mailer')`,
      [fingerprint],
    );
    const response = await sendBeat('report-mailer', sign());
    expect(response).toEqual({ status: 200, body: { recovered: true } });
    const state = await owner().query<{ state: string }>(
      `SELECT state FROM alert WHERE fingerprint = $1`,
      [fingerprint],
    );
    expect(state.rows.map((row) => row.state)).toEqual(['resolved']);
  });

  it('refuses a missing, wrong or old signature with one answer, and an unknown slug only once signed', async () => {
    await call(lead, 'POST', '/v1/heartbeats', {
      slug: 'sig-check',
      name: 'Sig check',
      expectedIntervalSeconds: 600,
    });
    const unsigned = await sendBeat('sig-check', undefined);
    const wrong = await sendBeat('sig-check', sign('{"a":1}'));
    const old = await sendBeat('sig-check', sign('{}', -3600));
    expect([unsigned.status, wrong.status, old.status]).toEqual([401, 401, 401]);
    expect(unsigned.body).toEqual(wrong.body);
    expect(unsigned.body).toEqual(old.body);
    // The slug is not looked up before the signature checks out: unsigned unknown == unsigned known.
    expect((await sendBeat('does-not-exist', undefined)).status).toBe(401);
    expect((await sendBeat('does-not-exist', sign())).status).toBe(404);
  });
});

describe('correlation rules and groups (R-3.6)', () => {
  it('creates, edits and removes a rule, audited; refuses nonsense', async () => {
    const created = await call<CorrelationRule>(head, 'POST', '/v1/correlation-rules', {
      name: 'Platform burst',
      windowMinutes: 15,
      minAlerts: 3,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: 'same_service', active: true });
    expect(
      (
        await call(head, 'POST', '/v1/correlation-rules', {
          name: 'platform burst',
          windowMinutes: 5,
          minAlerts: 2,
        })
      ).status,
    ).toBe(409);
    for (const bad of [
      { name: 'x', windowMinutes: 0, minAlerts: 2 },
      { name: 'x', windowMinutes: 5, minAlerts: 1 },
      { name: 'x', windowMinutes: 5, minAlerts: 2, kind: 'same_org' },
    ]) {
      expect((await call(head, 'POST', '/v1/correlation-rules', bad)).status).toBe(400);
    }
    const patched = await call<CorrelationRule>(
      head,
      'PATCH',
      `/v1/correlation-rules/${created.body.id}`,
      { active: false },
    );
    expect(patched.body.active).toBe(false);
    const list = await call<{ items: CorrelationRule[] }>(agent, 'GET', '/v1/correlation-rules');
    // The seeded default is there too.
    expect(list.body.items.map((item) => item.name)).toEqual(
      expect.arrayContaining(['Platform burst', 'Same service']),
    );
    expect((await call(head, 'DELETE', `/v1/correlation-rules/${created.body.id}`)).status).toBe(
      204,
    );
  });

  it('lists the groups of alerts that share a correlation id', async () => {
    const correlationId = randomUUID();
    const service = await owner().query<{ id: string }>(
      `INSERT INTO service (slug, name) VALUES ($1, 'Grouped') RETURNING id`,
      [`grouped-${randomUUID().slice(0, 8)}`],
    );
    const serviceId = service.rows[0]?.id ?? '';
    await insertAlert({ correlationId, serviceId });
    await insertAlert({ correlationId, serviceId, state: 'resolved' });
    const response = await call<{ items: CorrelationGroup[] }>(
      agent,
      'GET',
      '/v1/alerts/correlations',
    );
    const group = response.body.items.find((item) => item.correlationId === correlationId);
    expect(group).toMatchObject({ alerts: 2, openAlerts: 1, serviceId, incidentId: null });
  });
});

describe('noise metrics (R-3.11)', () => {
  it('counts actionable against self-resolved alerts per rule, and does not judge open ones', async () => {
    const title = `Noisy rule ${randomUUID()}`;
    await insertAlert({ title, ackedAt: true, state: 'acknowledged' });
    await insertAlert({ title, incident: true });
    await insertAlert({ title, state: 'resolved', count: 3 });
    await insertAlert({ title, state: 'resolved' });
    await insertAlert({ title, state: 'resolved' });
    await insertAlert({ title });
    const report = await call<NoiseReport>(agent, 'GET', '/v1/alerts/noise?limit=100');
    expect(report.status).toBe(200);
    const rule = report.body.items.find((item) => item.title === title);
    expect(rule).toMatchObject({
      source: 'alertmanager',
      alerts: 6,
      occurrences: 8,
      actionable: 2,
      noise: 3,
      stillOpen: 1,
    });
    expect(rule?.actionableRatio).toBeCloseTo(2 / 5, 5);
    expect(report.body.windowDays).toBeGreaterThan(0);
  });

  it('puts the noisiest rule first, null ratio when nothing is judged, and validates the window', async () => {
    const quiet = `Quiet rule ${randomUUID()}`;
    await insertAlert({ title: quiet });
    const report = await call<NoiseReport>(agent, 'GET', '/v1/alerts/noise?limit=100');
    const noise = report.body.items.map((item) => item.noise);
    expect(noise).toEqual(noise.toSorted((a, b) => b - a));
    expect(report.body.items.find((item) => item.title === quiet)?.actionableRatio).toBeNull();
    expect((await call(agent, 'GET', '/v1/alerts/noise?days=0')).status).toBe(400);
    expect((await call(agent, 'GET', '/v1/alerts/noise?days=91')).status).toBe(400);
  });
});
