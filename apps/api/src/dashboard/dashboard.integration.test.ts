import { randomBytes } from 'node:crypto';

import { billingPeriod } from '@watchtower/domain';
import { HEALTH_FORMULA_VERSION, dashboardOpsSchema, type DashboardOps } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Principal } from '../auth/principal.js';
import { DATABASE } from '../database/database.module.js';
import { startHarness, type Harness } from '../testing/harness.js';
import { apiOrg, signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';
import { DashboardService } from './dashboard.service.js';

// T-206b on the real application module and Postgres: who may read the dashboard, what a role does not see, that
// a figure without data says so instead of reading zero, the counts themselves, and that it stays cheap.
const net = disableNetConnect();

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let client: Persona;
let orgId: string;
let otherOrgId: string;
const owner = () => h.db.owner.pool;
const run = (text: string, values: unknown[] = []) => owner().query(text, values);
const hex = () => randomBytes(32).toString('hex');

const ROUTE = '/v1/dashboard/ops?days=7';
const fetchOps = async (who: Persona, path = ROUTE) => {
  const response = await who.client.request<DashboardOps>('GET', path, {});
  expect(response.status, path).toBe(200);
  return dashboardOpsSchema.parse(response.body);
};

/** The principal of a signed-in persona, as the service sees it (permissions are what the guard resolved). */
const principalOf = (
  role: Principal['role'],
  permissions: string[],
  scope: Principal['orgScope'],
) =>
  ({
    userId: '00000000-0000-4000-8000-000000000001',
    sessionId: '00000000-0000-4000-8000-000000000002',
    email: 'probe@example.test',
    name: 'Probe',
    role,
    orgId: scope.kind === 'org' ? scope.orgId : null,
    authMethod: 'dev',
    accessExpiresAt: new Date(Date.now() + 60_000),
    permissions: new Set(permissions),
    orgScope: scope,
  }) as unknown as Principal;

beforeAll(async () => {
  h = await startHarness();
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  orgId = (await apiOrg(lead, { name: 'Dashboard Org' })).id;
  otherOrgId = (await apiOrg(lead, { name: 'Other Dashboard Org' })).id;
  client = await signIn(h, 'client', orgId);
});
afterAll(async () => {
  await h.close();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

describe('access (RBAC)', () => {
  it('lets staff with dashboard.ops.read in, refuses a customer and a visitor', async () => {
    // A window of its own: the answers are cached per window and the figures below must not meet an empty one.
    const early = '/v1/dashboard/ops?days=2';
    for (const who of [agent, lead, head]) {
      expect((await who.client.request('GET', early, {})).status).toBe(200);
    }
    expect((await client.client.request('GET', early, {})).status).toBe(403);
    expect((await h.client().request('GET', early, { csrf: false })).status).toBe(401);
  });

  it('refuses a caller whose scope is one organization even if the permission were granted', async () => {
    const service = h.app.get(DashboardService);
    const scoped = principalOf('client', ['dashboard.ops.read'], { kind: 'org', orgId });
    await expect(service.ops(7, scoped)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('validates the window', async () => {
    for (const bad of ['days=0', 'days=91', 'days=abc', 'days=1.5']) {
      const response = await lead.client.request<ApiErrorBody>(
        'GET',
        `/v1/dashboard/ops?${bad}`,
        {},
      );
      expect(response.status, bad).toBe(400);
    }
  });
});

describe('a database with nothing in it', () => {
  it('says "not available" for every figure that has no data, and a real zero only for a count', async () => {
    const ops = await fetchOps(head, '/v1/dashboard/ops?days=30');
    expect(ops.queue).toMatchObject({ open: 0, unassigned: 0, atRiskNow: 0, breachedNow: 0 });
    expect(ops.volume.created).toBe(0);
    expect(ops.volume.byDay).toHaveLength(30);
    for (const value of [
      ops.sla.firstResponse,
      ops.sla.resolution,
      ops.sla.firstResponseBreach,
      ops.sla.resolutionBreach,
      ops.quality.csat,
      ops.quality.reopen,
      ops.quality.toDev,
      ops.reliability.incidents.mttr,
      ops.reliability.alerts.mtta,
      ops.reliability.alerts.noise,
      ops.reliability.changeFailure,
      ops.team.perAgent,
      ops.team.lineQuota,
      ops.health,
      ops.services,
      ops.usage,
    ]) {
      expect(value).toMatchObject({ status: 'not_available' });
    }
    // The figures that wait for the grader are never computed, whatever the data.
    expect(ops.quality.escalation).toEqual({ status: 'not_available', reason: 'not_collected' });
    if (ops.ai.status !== 'ok') throw new Error('head must see the AI section');
    expect(ops.ai.data.noTouchRate).toEqual({ status: 'not_available', reason: 'needs_grader' });
    expect(ops.ai.data.verifiedVsAssumed).toEqual({
      status: 'not_available',
      reason: 'needs_grader',
    });
    expect(ops.ai.data.kbCoverage).toEqual({ status: 'not_available', reason: 'needs_grader' });
    expect(ops.ai.data.drafts).toMatchObject({ status: 'not_available', reason: 'no_data' });
    expect(ops.ai.data.cost).toMatchObject({ status: 'not_available', reason: 'no_data' });
  });
});

describe('the figures', () => {
  let assignee: string;

  beforeAll(async () => {
    assignee = agent.userId;
    const interval = (expression: string) => `now() - interval '${expression}'`;
    const ticket = async (
      org: string,
      fields: {
        channel?: string;
        status?: string;
        created: string;
        assignee?: boolean;
        responded?: string;
        resolved?: string;
        frDue?: string;
        resDue?: string;
        paused?: string;
        reopen?: number;
      },
    ): Promise<string> => {
      const { rows } = await run(
        `INSERT INTO ticket (subject, org_id, channel, status, assignee_id, created_at, first_responded_at,
           resolved_at, first_response_due_at, resolution_due_at, sla_paused_at, reopen_count)
         VALUES ('dash probe', $1, $2, $3, $4, ${fields.created}, ${fields.responded ?? 'NULL'},
           ${fields.resolved ?? 'NULL'}, ${fields.frDue ?? 'NULL'}, ${fields.resDue ?? 'NULL'},
           ${fields.paused ?? 'NULL'}, $5) RETURNING id`,
        [
          org,
          fields.channel ?? 'portal',
          fields.status ?? 'open',
          fields.assignee === true ? assignee : null,
          fields.reopen ?? 0,
        ],
      );
      return (rows[0] as { id: string }).id;
    };

    // Resolved quickly: first answer after 20 minutes, resolved after an hour, both targets met.
    const resolved = await ticket(orgId, {
      status: 'resolved',
      created: interval('2 hours'),
      responded: interval('100 minutes'),
      resolved: interval('1 hour'),
      frDue: `now() + interval '1 hour'`,
      resDue: `now() + interval '3 hours'`,
      assignee: true,
    });
    // Unanswered, deadline in 30 minutes: at risk.
    await ticket(orgId, {
      created: interval('1 hour'),
      frDue: `now() + interval '30 minutes'`,
    });
    // Unanswered, deadline passed 10 minutes ago, assigned: breached; it also waited on the developers.
    const breached = await ticket(orgId, {
      created: interval('1 hour'),
      frDue: interval('10 minutes'),
      resDue: `now() + interval '5 hours'`,
      assignee: true,
    });
    // Old, answered, not due for two days: queue only.
    await ticket(orgId, {
      channel: 'gmail',
      created: interval('30 days'),
      responded: interval('29 days'),
      resDue: `now() + interval '2 days'`,
    });
    // Waiting on the customer: the clock is stopped, so it is neither at risk nor breached.
    await ticket(otherOrgId, {
      channel: 'line',
      status: 'waiting_on_customer',
      created: interval('30 minutes'),
      frDue: interval('1 hour'),
      paused: interval('10 minutes'),
    });
    // Reopened once.
    await ticket(orgId, { created: interval('1 hour'), reopen: 1 });

    await run(
      `INSERT INTO ticket_event (ticket_id, type, actor_type, payload)
       VALUES ($1, 'ticket.status_changed', 'system', '{"from":"open","to":"waiting_on_dev"}'::jsonb)`,
      [breached],
    );

    const { rows: contacts } = await run(
      `INSERT INTO contact (org_id, name, emails) VALUES ($1, 'Probe', ARRAY['probe@example.test']) RETURNING id`,
      [orgId],
    );
    const contactId = (contacts[0] as { id: string }).id;
    await run(
      `INSERT INTO csat_survey (ticket_id, contact_id, org_id, status, send_after, sent_at, token_expires_at,
         answered_at, score) VALUES ($1, $2, $3, 'answered', now() - interval '1 hour', now() - interval '1 hour',
         now() + interval '1 day', now() - interval '30 minutes', 5)`,
      [resolved, contactId, orgId],
    );

    // Incidents: one open SEV1 (linked to an organization and a service), one SEV2 resolved after two hours.
    const { rows: services } = await run(
      `INSERT INTO service (slug, name) VALUES ('dash-probe', 'Dash probe') RETURNING id`,
    );
    const serviceId = (services[0] as { id: string }).id;
    const { rows: openIncident } = await run(
      `INSERT INTO incident (title, severity, status, started_at)
       VALUES ('Probe outage', 'SEV1', 'investigating', now() - interval '1 hour') RETURNING id`,
    );
    const incidentId = (openIncident[0] as { id: string }).id;
    await run(
      `INSERT INTO incident (title, severity, status, started_at, resolved_at)
       VALUES ('Probe slowdown', 'SEV2', 'resolved', now() - interval '3 hours', now() - interval '1 hour')`,
    );
    await run(`INSERT INTO incident_org (incident_id, org_id) VALUES ($1, $2)`, [
      incidentId,
      orgId,
    ]);
    await run(`INSERT INTO incident_service (incident_id, service_id) VALUES ($1, $2)`, [
      incidentId,
      serviceId,
    ]);
    // One deploy 30 minutes before the SEV1 started (inside the two hour attribution window), one a day earlier.
    await run(
      `INSERT INTO deploy (service_id, service_slug, version, env, source, external_id, finished_at)
       VALUES ($1, 'dash-probe', '1.0.1', 'prod', 'ci', 'dash-1', now() - interval '90 minutes'),
              ($1, 'dash-probe', '1.0.0', 'prod', 'ci', 'dash-0', now() - interval '20 hours')`,
      [serviceId],
    );

    // Alerts: one settled by itself, one acknowledged after five minutes, one still open.
    await run(
      `INSERT INTO alert (fingerprint, source, severity, state, title, first_seen_at, resolved_at)
       VALUES ($1, 'alertmanager', 'info', 'resolved', 'noise', now() - interval '2 hours', now() - interval '110 minutes')`,
      [hex()],
    );
    await run(
      `INSERT INTO alert (fingerprint, source, severity, state, title, first_seen_at, acked_at)
       VALUES ($1, 'alertmanager', 'critical', 'acknowledged', 'acked', now() - interval '2 hours',
         now() - interval '115 minutes')`,
      [hex()],
    );
    await run(
      `INSERT INTO alert (fingerprint, source, severity, state, title) VALUES ($1, 'alertmanager', 'warning', 'open', 'open')`,
      [hex()],
    );

    // AI: three decided drafts (one of each), an intent, and a priced and an unpriced run on one ticket.
    await run(
      `INSERT INTO intent (key, name, autonomy_stage) VALUES ('dash_probe', 'Dash probe', 2)`,
    );
    await run(
      `INSERT INTO ai_draft (ticket_id, body_text, status, disposition, edit_distance, reject_reason, resolved_at)
       VALUES ($1, 'a', 'draft', 'approved', NULL, NULL, now()),
              ($1, 'b', 'draft', 'edited', 0.4, NULL, now()),
              ($1, 'c', 'rejected', 'rejected', NULL, 'wrong_answer', now())`,
      [resolved],
    );
    await run(
      `INSERT INTO ai_run (started_at, agent, ticket_id, provider, model, tier, prompt_id, prompt_version,
         prompt_hash, input_hmac, redaction, status, cost_usd)
       VALUES (now(), 'drafter', $1, 'mock', 'm', 'light', 'p', 1, $2, $3, '{"total":0,"byKind":{}}'::jsonb, 'ok', 0.5),
              (now(), 'drafter', $1, 'mock', 'm', 'light', 'p', 1, $2, $3, '{"total":0,"byKind":{}}'::jsonb, 'ok', NULL)`,
      [resolved, hex(), hex()],
    );

    // LINE quota, the Health Score of two organizations, a status component, and one active usage metric.
    const { rows: accounts } = await run(
      `INSERT INTO channel_account (type, name) VALUES ('line', 'Dash LINE') RETURNING id`,
    );
    await run(
      `INSERT INTO channel_quota_usage (channel_account_id, period, used, quota_limit) VALUES ($1, $2, 7, 500)`,
      [(accounts[0] as { id: string }).id, billingPeriod(new Date())],
    );
    await run(
      `INSERT INTO org_health_snapshot (org_id, day, formula_version, status, score, components)
       VALUES ($1, current_date, $3, 'scored', 40, '{}'::jsonb),
              ($2, current_date, $3, 'insufficient_data', NULL, '{}'::jsonb)`,
      [orgId, otherOrgId, HEALTH_FORMULA_VERSION],
    );
    await run(`INSERT INTO status_component (slug, name) VALUES ('dash-api', 'API')`);
    const created = await head.client.post('/v1/usage/metrics', {
      key: 'dash_probe_metric',
      name: 'Dash probe',
      sqlTemplate:
        "SELECT date_trunc('hour', t) AS ts, count(*) AS value FROM x WHERE t >= $1 AND t < $2 GROUP BY 1",
      dims: [],
    });
    expect(created.status).toBe(201);
  });

  it('counts the queue, the clock and the volume', async () => {
    const ops = await fetchOps(head);
    expect(ops.queue).toMatchObject({
      open: 5,
      unassigned: 4,
      paused: 1,
      breachedNow: 1,
      atRiskNow: 1,
      byStatus: { open: 4, waiting_on_customer: 1 },
      aging: { lt_4h: 4, h4_24: 0, d1_3: 0, gt_3d: 1 },
    });
    expect(ops.volume.created).toBe(5);
    expect(ops.volume.byChannel).toEqual({ portal: 4, line: 1 });
    expect(ops.volume.byDay).toHaveLength(7);
    expect(ops.volume.byDay.reduce((sum, day) => sum + day.created, 0)).toBe(5);
    expect(ops.window.days).toBe(7);
  });

  it('computes response and resolution times and the breach rates from the tickets', async () => {
    const { sla, quality } = await fetchOps(head);
    expect(sla.firstResponse).toEqual({
      status: 'ok',
      data: { medianSeconds: 1200, p90Seconds: 1200, samples: 1 },
    });
    expect(sla.resolution).toEqual({
      status: 'ok',
      data: { medianSeconds: 3600, p90Seconds: 3600, samples: 1 },
    });
    // Answered in time + unanswered past its deadline = 2 evaluated; the paused ticket and the open one are not.
    expect(sla.firstResponseBreach).toEqual({
      status: 'ok',
      data: { evaluated: 2, breached: 1, rate: 0.5 },
    });
    expect(sla.resolutionBreach).toEqual({
      status: 'ok',
      data: { evaluated: 1, breached: 0, rate: 0 },
    });
    expect(quality.reopen).toEqual({ status: 'ok', data: { resolved: 2, reopened: 1, rate: 0.5 } });
    expect(quality.toDev).toEqual({
      status: 'ok',
      data: { tickets: 5, waitedOnDev: 1, rate: 0.2 },
    });
    expect(quality.csat).toEqual({
      status: 'ok',
      data: { answered: 1, sent: 1, average: 5, responseRate: 1 },
    });
  });

  it('computes reliability: incidents, alert noise and acknowledgement, change failures', async () => {
    const { reliability } = await fetchOps(head);
    expect(reliability.incidents).toMatchObject({
      started: 2,
      openNow: 1,
      bySeverity: { SEV1: 1, SEV2: 1, SEV3: 0, SEV4: 0 },
      affectedOrgs: 1,
      mttr: { status: 'ok', data: { medianSeconds: 7200, samples: 1 } },
    });
    expect(reliability.incidents.open).toHaveLength(1);
    expect(reliability.incidents.open[0]).toMatchObject({
      title: 'Probe outage',
      severity: 'SEV1',
    });
    expect(reliability.alerts).toMatchObject({
      openNow: 2,
      openBySeverity: { critical: 1, warning: 1 },
      mtta: { status: 'ok', data: { medianSeconds: 300, samples: 1 } },
      noise: { status: 'ok', data: { settled: 1, noisy: 1, ratio: 1 } },
    });
    expect(reliability.changeFailure).toEqual({
      status: 'ok',
      data: { deploys: 2, followedByIncident: 1, rate: 0.5, attributionHours: 2 },
    });
  });

  it('computes the AI, team, usage, health and service sections for a head', async () => {
    const ops = await fetchOps(head);
    if (ops.ai.status !== 'ok') throw new Error('head must see the AI section');
    expect(ops.ai.data.stages).toContainEqual({
      intent: 'dash_probe',
      name: 'Dash probe',
      stage: 2,
      pinned: false,
    });
    if (ops.ai.data.drafts.status !== 'ok') throw new Error('drafts were decided');
    expect(ops.ai.data.drafts.data).toMatchObject({
      decided: 3,
      approved: 1,
      edited: 1,
      rejected: 1,
    });
    expect(ops.ai.data.drafts.data.acceptanceRate).toBeCloseTo(2 / 3, 10);
    expect(ops.ai.data.drafts.data.averageEditDistance).toBeCloseTo(0.4, 5);
    expect(ops.ai.data.cost).toEqual({
      status: 'ok',
      data: { totalUsd: 0.5, tickets: 1, perTicketUsd: 0.5, unpricedRuns: 1 },
    });
    // No published article: coverage of the KB is unknown, not zero.
    expect(ops.ai.data.kb).toMatchObject({ status: 'not_available', reason: 'no_data' });

    expect(ops.team.perAgent).toMatchObject({
      status: 'ok',
      data: [{ userId: assignee, open: 1, resolved: 1 }],
    });
    expect(ops.team.coverage).toEqual({ status: 'not_available', reason: 'not_implemented' });
    expect(ops.team.lineQuota).toEqual({
      status: 'ok',
      data: { period: billingPeriod(new Date()), used: 7, limit: 500, accounts: 1 },
    });
    // A metric exists but nothing deviated: zero anomalies is a fact here.
    expect(ops.usage).toEqual({ status: 'ok', data: { anomalies: 0, recent: [] } });
    expect(ops.health).toMatchObject({
      status: 'ok',
      data: {
        scored: 1,
        insufficientData: 1,
        lowest: [{ orgId, orgName: 'Dashboard Org', score: 40 }],
      },
    });
    expect(ops.services).toMatchObject({
      status: 'ok',
      data: [{ slug: 'dash-api', name: 'API', status: 'operational', public: false }],
    });
  });

  it('shows an agent the reduced view and a lead what the lead role includes', async () => {
    const asAgent = await fetchOps(agent);
    expect(asAgent.queue.open).toBe(5);
    expect(asAgent.services.status).toBe('ok');
    expect(asAgent.quality.csat).toEqual({ status: 'restricted', requires: 'csat.read' });
    expect(asAgent.ai).toEqual({ status: 'restricted', requires: 'ai.run.read' });
    expect(asAgent.team.perAgent).toEqual({
      status: 'restricted',
      requires: 'performance.read.all',
    });
    expect(asAgent.usage).toEqual({ status: 'restricted', requires: 'metric.read' });
    expect(asAgent.health).toEqual({ status: 'restricted', requires: 'org.health.read' });
    // Nothing of the restricted sections travels: not even a count.
    expect(JSON.stringify(asAgent)).not.toContain('Dashboard Org');
    expect(JSON.stringify(asAgent)).not.toContain('dash_probe');

    const asLead = await fetchOps(lead);
    expect(asLead.health.status).toBe('ok');
    expect(asLead.usage.status).toBe('ok');
    expect(asLead.ai.status).toBe('ok');
    expect(asLead.team.perAgent.status).toBe('ok');
  });
});

describe('cost', () => {
  it('runs a bounded number of queries once per window per 30 seconds, then none', async () => {
    const database = h.app.get<{ pool: { query: (...args: unknown[]) => unknown } }>(DATABASE);
    const service = h.app.get(DashboardService);
    const full = principalOf(
      'head',
      [
        'dashboard.ops.read',
        'csat.read',
        'ai.run.read',
        'performance.read.all',
        'metric.read',
        'org.health.read',
      ],
      { kind: 'all' },
    );
    const spy = vi.spyOn(database.pool, 'query');
    try {
      const started = performance.now();
      await service.ops(14, full);
      const elapsedMs = performance.now() - started;
      const firstRun = spy.mock.calls.length;
      // One query per figure group; a loop over rows would show up here as a number that grows with the data.
      expect(firstRun).toBeGreaterThan(10);
      expect(firstRun).toBeLessThanOrEqual(25);
      // A generous bound on a loaded machine; the point is "milliseconds, not seconds".
      expect(elapsedMs).toBeLessThan(5000);

      await service.ops(14, full);
      await service.ops(14, principalOf('agent', ['dashboard.ops.read'], { kind: 'all' }));
      expect(spy.mock.calls.length).toBe(firstRun);

      // Another window is another computation.
      await service.ops(15, full);
      expect(spy.mock.calls.length).toBe(firstRun * 2);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not scan the tables a window filter reaches: the 0070 indexes are there', async () => {
    const { rows } = await run(
      `SELECT indexname FROM pg_indexes WHERE indexname = ANY($1) ORDER BY indexname`,
      [
        [
          'ticket_resolved_idx',
          'alert_first_seen_idx',
          'incident_started_idx',
          'csat_survey_sent_idx',
          'ai_draft_resolved_idx',
        ],
      ],
    );
    expect(rows.map((row) => (row as { indexname: string }).indexname)).toEqual([
      'ai_draft_resolved_idx',
      'alert_first_seen_idx',
      'csat_survey_sent_idx',
      'incident_started_idx',
      'ticket_resolved_idx',
    ]);
  });
});
