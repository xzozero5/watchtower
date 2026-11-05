import { randomBytes } from 'node:crypto';

import {
  buildAlertsNoiseFacts,
  buildDashboardSlaFacts,
  buildDashboardVolumeFacts,
  buildIncidentsOpenFacts,
  buildMyWorkFacts,
  buildShiftOverviewFacts,
  factsFingerprint,
} from '@watchtower/domain';
import {
  DEFAULT_ROLE_PERMISSIONS,
  INSIGHT_ELEMENTS,
  OPEN_STATUSES,
  dashboardOpsSchema,
  noiseReportSchema,
  shiftOverviewSchema,
  ticketStatsSchema,
  type InsightElementKey,
  type InsightFact,
  type InsightFactsResult,
  type Permission,
  type Role,
} from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DATABASE } from '../database/database.module.js';
import { startHarness, type Harness } from '../testing/harness.js';
import {
  apiIntent,
  apiOrg,
  apiQueue,
  fileTicket,
  signIn,
  type Persona,
} from '../testing/ticketing.js';

// T-415 on the real application module and Postgres: a facts builder (ADR-029 section 9.2) reads the same data
// the GET route behind its element reads, so a screen and its insight cannot disagree, and the answer does not
// depend on who is asking: the builder takes no principal, so what the lowest role that holds the element's rule
// gets from the route is what the head gets, and both are what the builder summed up.
let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let otherAgent: Persona;
let orgId: string;
let intentA: string;
let queueA: string;
const owner = () => h.db.owner.pool;
const executor = () => h.app.get(DATABASE).db;
const sentinel = randomBytes(6).toString('hex');
const SUBJECT = `Subject-${sentinel}`;
const ORG_NAME = `Org-${sentinel}`;
const ALERT_TITLE = `AlertTitle-${sentinel}`;
const INCIDENT_TITLE = `IncidentTitle-${sentinel}`;
const REQUESTER_EMAIL = `requester-${sentinel}@customer.example`;
const AGENT_NAME = `Agent Name ${sentinel}`;
let counter = 40_000;

const byId = (result: InsightFactsResult): Map<string, InsightFact> =>
  new Map(result.facts.map((fact) => [fact.id, fact]));
const value = (facts: Map<string, InsightFact>, id: string): number | string | undefined =>
  facts.get(id)?.value;

/** The role with the fewest permissions that still holds the element's rule: the weakest reader of its route. */
function weakestHolder(key: InsightElementKey): Persona {
  const rule = INSIGHT_ELEMENTS[key].rule;
  if (rule === null) throw new Error(`${key} has no rule`);
  const holds = (role: Role): boolean => {
    const granted = new Set<Permission>(DEFAULT_ROLE_PERMISSIONS[role]);
    return 'all' in rule
      ? rule.all.every((permission) => granted.has(permission))
      : rule.anyOf.some((permission) => granted.has(permission));
  };
  const order = [
    ['agent', agent],
    ['lead', lead],
    ['head', head],
  ] as const;
  for (const [role, persona] of order) if (holds(role)) return persona;
  throw new Error(`no staff role holds the rule of ${key}`);
}

async function insertAlert(fields: {
  title: string;
  state: string;
  acked?: boolean;
  incident?: boolean;
  serviceId?: string;
}): Promise<void> {
  counter += 1;
  await owner().query(
    `INSERT INTO alert (fingerprint, source, title, state, acked_at, incident_id, service_id, resolved_at)
     VALUES ($1, 'alertmanager', $2, $3, CASE WHEN $4 THEN clock_timestamp() END,
             CASE WHEN $5 THEN (SELECT id FROM incident ORDER BY created_at LIMIT 1) END, $6,
             CASE WHEN $3 = 'resolved' THEN clock_timestamp() END)`,
    [
      counter.toString(16).padStart(64, '0'),
      fields.title,
      fields.state,
      fields.acked ?? false,
      fields.incident ?? false,
      fields.serviceId ?? null,
    ],
  );
}

beforeAll(async () => {
  h = await startHarness();
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent', undefined, AGENT_NAME);
  otherAgent = await signIn(h, 'agent');
  orgId = (await apiOrg(lead, { name: ORG_NAME })).id;
  intentA = (
    await apiIntent(lead, {
      key: `intent_${sentinel}`,
      name: `Intent ${sentinel}`,
      description: 'x',
    })
  ).id;
  queueA = (await apiQueue(lead, { name: `Queue ${sentinel}` })).id;

  for (const [who, n] of [
    [agent, 3],
    [otherAgent, 1],
  ] as const) {
    for (let index = 0; index < n; index += 1) {
      await fileTicket(lead, orgId, {
        subject: SUBJECT,
        requester: { email: REQUESTER_EMAIL, name: 'Requester' },
        assigneeId: who.userId,
        queueId: queueA,
        intentId: intentA,
      });
    }
  }
  // One ticket already past its first-response target, one with an hour left.
  await owner().query(
    `UPDATE ticket SET first_response_due_at = now() - interval '2 hours' WHERE subject = $1 AND assignee_id = $2
       AND id = (SELECT id FROM ticket WHERE subject = $1 AND assignee_id = $2 ORDER BY number LIMIT 1)`,
    [SUBJECT, agent.userId],
  );
  await owner().query(
    `UPDATE ticket SET first_response_due_at = now() + interval '10 minutes' WHERE subject = $1 AND assignee_id = $2
       AND id = (SELECT id FROM ticket WHERE subject = $1 AND assignee_id = $2 ORDER BY number DESC LIMIT 1)`,
    [SUBJECT, agent.userId],
  );

  const incident = await lead.client.post<{ id: string }>('/v1/incidents', {
    title: INCIDENT_TITLE,
    severity: 'SEV2',
  });
  expect(incident.status).toBe(201);
  await lead.client.post('/v1/incidents', { title: `${INCIDENT_TITLE} two`, severity: 'SEV4' });

  const service = await lead.client.post<{ id: string }>('/v1/services', {
    slug: `svc-${sentinel}`,
    name: `Service ${sentinel}`,
  });
  expect(service.status).toBe(201);
  const serviceId = service.body.id;
  await insertAlert({ title: ALERT_TITLE, state: 'resolved', serviceId });
  await insertAlert({ title: ALERT_TITLE, state: 'resolved', serviceId });
  await insertAlert({ title: `${ALERT_TITLE} b`, state: 'resolved', acked: true });
  await insertAlert({ title: `${ALERT_TITLE} c`, state: 'open' });

  expect((await agent.client.post('/v1/shifts/clock-in', {})).status).toBe(200);
  expect((await otherAgent.client.post('/v1/shifts/clock-in', {})).status).toBe(200);
});

afterAll(async () => {
  await h.close();
});

const noFreeText = (result: InsightFactsResult): void => {
  const text = JSON.stringify(result);
  for (const secret of [
    SUBJECT,
    ORG_NAME,
    ALERT_TITLE,
    INCIDENT_TITLE,
    REQUESTER_EMAIL,
    AGENT_NAME,
  ]) {
    expect(text).not.toContain(secret);
  }
};

describe('dashboard.ops.sla and dashboard.ops.volume', () => {
  it('agree with GET /v1/dashboard/ops, for the weakest reader and for the head alike', async () => {
    const path = '/v1/dashboard/ops?days=9';
    const weak = weakestHolder('dashboard.ops.sla');
    const asWeak = dashboardOpsSchema.parse((await weak.client.request('GET', path, {})).body);
    const asHead = dashboardOpsSchema.parse((await head.client.request('GET', path, {})).body);
    for (const section of ['queue', 'volume', 'sla'] as const) {
      expect(asWeak[section]).toEqual(asHead[section]);
    }

    const sla = await buildDashboardSlaFacts({ executor: executor(), days: 9 });
    const slaFacts = byId(sla);
    expect(value(slaFacts, 'open')).toBe(asHead.queue.open);
    expect(value(slaFacts, 'at_risk')).toBe(asHead.queue.atRiskNow);
    expect(value(slaFacts, 'breached')).toBe(asHead.queue.breachedNow);
    expect(value(slaFacts, 'paused')).toBe(asHead.queue.paused);
    expect(value(slaFacts, 'window_days')).toBe(9);
    expect(value(slaFacts, 'breached')).toBeGreaterThanOrEqual(1);
    expect(value(slaFacts, 'sla_state')).toBe('breached');
    const frt = asHead.sla.firstResponseBreach;
    if (frt.status === 'ok') {
      expect(value(slaFacts, 'frt_breach_pct')).toBe(Math.round(frt.data.rate * 100));
    }
    const median = asHead.sla.firstResponse;
    if (median.status === 'ok') {
      expect(value(slaFacts, 'frt_median_s')).toBe(Math.round(median.data.medianSeconds));
    }
    // The queue that holds the trouble is a catalog entity with a name a staff member set.
    expect(sla.facts.some((fact) => fact.ref?.kind === 'queue' && fact.ref.id === queueA)).toBe(
      true,
    );
    noFreeText(sla);

    const volume = await buildDashboardVolumeFacts({ executor: executor(), days: 9 });
    const volumeFacts = byId(volume);
    expect(value(volumeFacts, 'created')).toBe(asHead.volume.created);
    expect(value(volumeFacts, 'created_prev')).toBe(asHead.volume.previous.created);
    expect(value(volumeFacts, 'created')).toBeGreaterThanOrEqual(4);
    expect(volume.facts.find((fact) => fact.id === 'intent_driver_1')).toMatchObject({
      value: 4,
      ref: { kind: 'intent', id: intentA },
    });
    noFreeText(volume);
  });

  it('does not change with the view of a masked reader (no customer in these facts)', async () => {
    const full = await buildDashboardVolumeFacts({ executor: executor(), days: 9, view: 'full' });
    const masked = await buildDashboardVolumeFacts({
      executor: executor(),
      days: 9,
      view: 'masked',
    });
    expect(factsFingerprint(masked.facts)).toBe(factsFingerprint(full.facts));
  });
});

describe('alerts.noise', () => {
  it('sums to what GET /v1/alerts/noise lists, whoever reads it', async () => {
    const path = '/v1/alerts/noise?days=7&limit=100';
    const weak = weakestHolder('alerts.noise');
    const asWeak = noiseReportSchema.parse((await weak.client.request('GET', path, {})).body);
    const asHead = noiseReportSchema.parse((await head.client.request('GET', path, {})).body);
    expect(asWeak).toEqual(asHead);
    const sum = (key: 'alerts' | 'actionable' | 'noise' | 'stillOpen') =>
      asHead.items.reduce((total, item) => total + item[key], 0);

    const result = await buildAlertsNoiseFacts({ executor: executor(), days: 7 });
    const facts = byId(result);
    expect(value(facts, 'alerts')).toBe(sum('alerts'));
    expect(value(facts, 'actionable')).toBe(sum('actionable'));
    expect(value(facts, 'noise')).toBe(sum('noise'));
    expect(value(facts, 'still_open')).toBe(sum('stillOpen'));
    expect(value(facts, 'noise')).toBe(2);
    expect(result.facts.find((fact) => fact.id === 'service_driver_1')).toMatchObject({
      value: 2,
      ref: { kind: 'service' },
    });
    // Alert titles come from a webhook: they are not a driver and not in any fact.
    noFreeText(result);
  });
});

describe('incidents.open', () => {
  it('counts what GET /v1/incidents?open=true lists, whoever reads it', async () => {
    const path = '/v1/incidents?open=true&limit=100';
    const weak = weakestHolder('incidents.open');
    const asWeak = (await weak.client.request<{ items: unknown[] }>('GET', path, {})).body;
    const asHead = (
      await head.client.request<{
        items: { severity: string; commanderId: string | null }[];
      }>('GET', path, {})
    ).body;
    expect(asWeak.items).toEqual(asHead.items);

    const result = await buildIncidentsOpenFacts({ executor: executor() });
    const facts = byId(result);
    expect(value(facts, 'open')).toBe(asHead.items.length);
    expect(value(facts, 'open')).toBeGreaterThanOrEqual(2);
    expect(value(facts, 'open_sev2')).toBe(
      asHead.items.filter((item) => item.severity === 'SEV2').length,
    );
    expect(value(facts, 'open_sev4')).toBe(
      asHead.items.filter((item) => item.severity === 'SEV4').length,
    );
    expect(value(facts, 'no_commander')).toBe(
      asHead.items.filter((item) => item.commanderId === null).length,
    );
    expect(value(facts, 'top_severity')).toBe('SEV2');
    noFreeText(result);
  });
});

describe('shift.overview (section 9.9: persons as refs and placeholders only)', () => {
  it('matches GET /v1/shifts/overview for a lead and a head, and names nobody', async () => {
    const weak = weakestHolder('shift.overview');
    const asWeak = shiftOverviewSchema.parse(
      (await weak.client.request('GET', '/v1/shifts/overview', {})).body,
    );
    const asHead = shiftOverviewSchema.parse(
      (await head.client.request('GET', '/v1/shifts/overview', {})).body,
    );
    const { generatedAt: _a, ...weakRest } = asWeak;
    const { generatedAt: _b, ...headRest } = asHead;
    void _a;
    void _b;
    expect(weakRest).toEqual(headRest);

    const result = await buildShiftOverviewFacts({ executor: executor() });
    const facts = byId(result);
    expect(value(facts, 'on_shift')).toBe(new Set(asHead.onShift.map((s) => s.userId)).size);
    expect(value(facts, 'on_shift')).toBeGreaterThanOrEqual(2);
    expect(value(facts, 'no_shows')).toBe(asHead.noShows.length);
    expect(value(facts, 'unack_count')).toBe(asHead.unacknowledged.count);
    expect(value(facts, 'unack_overdue')).toBe(asHead.unacknowledged.overdue);
    expect(value(facts, 'open_questions')).toBe(asHead.openQuestions);
    expect(value(facts, 'questions_overdue')).toBe(asHead.questions.overdue);

    // Persons: a ref of kind `user` and a placeholder; their open-ticket counts are the route's own counts.
    const persons = result.facts.filter((fact) => /^person_[a-h]_held$/.test(fact.id));
    expect(persons.length).toBeGreaterThanOrEqual(2);
    const held = new Map(persons.map((fact) => [fact.ref?.id, fact.value]));
    expect(held.get(agent.userId)).toBe(3);
    expect(held.get(otherAgent.userId)).toBe(1);
    for (const fact of result.facts.filter((f) => f.id.startsWith('person_'))) {
      expect(fact.ref?.kind).toBe('user');
      expect(fact.display.en).toMatch(/^\{person_[a-h]\} /);
      expect(fact.display.th).toMatch(/^\{person_[a-h]\} /);
    }
    // No order by workload: the persons come in the order of their ids.
    const ids = persons.map((fact) => fact.ref?.id ?? '');
    expect(ids).toEqual([...ids].sort());
    noFreeText(result);
    expect(JSON.stringify(result)).not.toContain(agent.email);
  });
});

describe('home.my_work (F, user scope)', () => {
  it('is the stats the person gets for assignee=me, and is about that person only', async () => {
    const status = OPEN_STATUSES.join(',');
    const stats = ticketStatsSchema.parse(
      (await agent.client.request('GET', `/v1/tickets/stats?assignee=me&status=${status}`, {}))
        .body,
    );
    const result = await buildMyWorkFacts({ executor: executor(), subjectUserId: agent.userId });
    const facts = byId(result);
    expect(value(facts, 'open')).toBe(stats.total.open);
    expect(value(facts, 'open')).toBe(3);
    expect(value(facts, 'at_risk')).toBe(stats.total.sla.at_risk);
    expect(value(facts, 'breached')).toBe(stats.total.sla.breached);
    expect(value(facts, 'paused')).toBe(stats.total.sla.paused);
    expect(value(facts, 'breached')).toBe(1);
    expect(value(facts, 'my_work_state')).toBe('breached');
    expect(facts.get('open')?.ref).toEqual({ kind: 'user', id: agent.userId });
    noFreeText(result);

    const other = byId(
      await buildMyWorkFacts({ executor: executor(), subjectUserId: otherAgent.userId }),
    );
    expect(value(other, 'open')).toBe(1);
    expect(value(other, 'breached')).toBe(0);
    // Nobody else's id is in this person's facts.
    expect(JSON.stringify(result)).not.toContain(otherAgent.userId);
  });
});
