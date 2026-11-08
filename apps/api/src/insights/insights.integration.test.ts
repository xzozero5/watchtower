import { randomBytes } from 'node:crypto';

import type { Database } from '@watchtower/db';
import { seedElementInsight } from '@watchtower/db/testing';
import { buildAlertsNoiseFacts, factsFingerprint } from '@watchtower/domain';
import {
  DEFAULT_ROLE_PERMISSIONS,
  INSIGHT_ELEMENTS,
  insightsResponseSchema,
  type InsightItem,
  type InsightsResponse,
  type Permission,
  type Role,
} from '@watchtower/shared';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Principal } from '../auth/principal.js';
import { DATABASE } from '../database/database.module.js';
import { REDIS } from '../redis/redis.module.js';
import { startHarness, type Harness } from '../testing/harness.js';
import {
  apiIntent,
  apiOrg,
  apiQueue,
  fileTicket,
  signIn,
  type Persona,
} from '../testing/ticketing.js';
import { InsightAccess } from './insight-access.js';
import { dirtyKey, userDirtyKey, viewedKey } from './insight-marks.js';
import { InsightsService } from './insights.service.js';

// T-416 on the real application module, Postgres (restricted role) and Redis: `GET /v1/insights` (ADR-029 section 9.3).
let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let dev: Persona;
let client: Persona;
let orgId: string;
let queueA: string;
const sentinel = randomBytes(6).toString('hex');
const owner = () => h.db.owner.pool;
const redis = () => h.app.get<Redis>(REDIS);
const executor = () => h.app.get<Database>(DATABASE).db;

const WAVE_9A = [
  'home.my_work',
  'home.team',
  'dashboard.ops.sla',
  'dashboard.ops.volume',
  'shift.overview',
  'incidents.open',
  'alerts.noise',
] as const;

async function insights(
  who: Persona,
  elements: readonly string[],
  extra = '',
): Promise<InsightItem[]> {
  const response = await who.client.get<InsightsResponse>(
    `/v1/insights?elements=${elements.join(',')}${extra}`,
  );
  expect(response.status).toBe(200);
  return insightsResponseSchema.parse(response.body).items;
}

const keys = (items: readonly InsightItem[]): string[] => items.map((item) => item.element);

async function aiRuns(): Promise<number> {
  const result = await owner().query<{ n: string }>('SELECT count(*)::text AS n FROM ai_run');
  return Number(result.rows[0]?.n);
}

async function setKillSwitch(on: boolean): Promise<void> {
  await owner().query(`UPDATE ai_switch SET is_on = $1 WHERE key = 'ai_kill_switch'`, [on]);
}

/** Puts a stored narration where the worker would, for an instance-scope element. */
async function storeNarration(fields: {
  element: string;
  period: string;
  locale: 'th' | 'en';
  fingerprint: string;
  claims: unknown;
  expiresInMinutes: number;
}): Promise<void> {
  await seedElementInsight(owner(), {
    element: fields.element,
    period: fields.period,
    locale: fields.locale,
    factsFingerprint: fields.fingerprint,
    claims: fields.claims,
    expiresInMinutes: fields.expiresInMinutes,
  });
}

async function currentFingerprint(): Promise<string> {
  const facts = await buildAlertsNoiseFacts({ executor: executor(), days: 7 });
  return factsFingerprint(facts.facts, INSIGHT_ELEMENTS['alerts.noise'].materiality);
}

function principalOf(persona: Persona, role: Role, permissions?: readonly Permission[]): Principal {
  return {
    userId: persona.userId,
    sessionId: 'test-session',
    email: persona.email,
    name: 'Test',
    role,
    orgId: null,
    authMethod: 'dev',
    accessExpiresAt: new Date(Date.now() + 3_600_000),
    permissions: new Set(permissions ?? DEFAULT_ROLE_PERMISSIONS[role]),
    orgScope: { kind: 'all' },
  };
}

async function insertAlert(title: string, state: string, serviceId?: string): Promise<void> {
  await owner().query(
    `INSERT INTO alert (fingerprint, source, title, state, service_id, resolved_at)
     VALUES ($1, 'alertmanager', $2, $3, $4, CASE WHEN $3 = 'resolved' THEN clock_timestamp() END)`,
    [randomBytes(32).toString('hex'), title, state, serviceId ?? null],
  );
}

beforeAll(async () => {
  h = await startHarness();
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  dev = await signIn(h, 'dev');
  orgId = (await apiOrg(lead, { name: `Org-${sentinel}` })).id;
  const intentId = (
    await apiIntent(lead, {
      key: `intent_${sentinel}`,
      name: `Intent ${sentinel}`,
      description: 'x',
    })
  ).id;
  queueA = (await apiQueue(lead, { name: `Queue ${sentinel}` })).id;
  client = await signIn(h, 'client', orgId);
  for (let index = 0; index < 3; index += 1) {
    await fileTicket(lead, orgId, {
      subject: `Subject-${sentinel}`,
      requester: { email: `requester-${sentinel}@customer.example`, name: 'Requester' },
      assigneeId: agent.userId,
      queueId: queueA,
      intentId,
    });
  }
  expect(
    (await lead.client.post('/v1/incidents', { title: `Incident-${sentinel}`, severity: 'SEV2' }))
      .status,
  ).toBe(201);
  const service = await lead.client.post<{ id: string }>('/v1/services', {
    slug: `svc-${sentinel}`,
    name: `Service ${sentinel}`,
  });
  await insertAlert(`Alert-${sentinel}`, 'resolved', service.body.id);
  await insertAlert(`Alert-${sentinel} b`, 'resolved', service.body.id);
  await insertAlert(`Alert-${sentinel} c`, 'open');
  expect((await agent.client.post('/v1/shifts/clock-in', {})).status).toBe(200);
  await setKillSwitch(false);
}, 120_000);

afterAll(async () => {
  await h.close();
});

describe('who may call it', () => {
  it('refuses a customer (client), however they signed in, and an anonymous caller', async () => {
    const asClient = await client.client.get('/v1/insights?elements=alerts.noise');
    expect(asClient.status).toBe(403);
    expect((await h.client().get('/v1/insights?elements=alerts.noise')).status).toBe(401);
  });

  it('rejects a malformed request before it reads anything', async () => {
    expect((await lead.client.get('/v1/insights')).status).toBe(400);
    expect((await lead.client.get('/v1/insights?elements=')).status).toBe(400);
    const thirteen = Array.from({ length: 13 }, (_, i) => `e${String(i)}`).join(',');
    expect((await lead.client.get(`/v1/insights?elements=${thirteen}`)).status).toBe(400);
    expect((await lead.client.get('/v1/insights?elements=alerts.noise&period=junk')).status).toBe(
      400,
    );
    expect((await lead.client.get('/v1/insights?elements=alerts.noise&scope=org:x')).status).toBe(
      400,
    );
  });
});

describe('element x role (the rule of the GET route behind each element)', () => {
  const TABLE: Record<'agent' | 'lead' | 'head' | 'dev', readonly string[]> = {
    // dashboard.ops.read, alert.read, ticket.read; no roster.manage, no performance.read.all.
    agent: [
      'home.my_work',
      'dashboard.ops.sla',
      'dashboard.ops.volume',
      'incidents.open',
      'alerts.noise',
    ],
    lead: [...WAVE_9A],
    head: [...WAVE_9A],
    // A masked developer holds none of the rules: ticket.read, dashboard.ops.read and alert.read are not theirs.
    dev: [],
  };

  for (const role of ['agent', 'lead', 'head', 'dev'] as const) {
    it(`gives ${role} exactly the elements whose rule they satisfy`, async () => {
      const who = { agent, lead, head, dev }[role];
      const items = await insights(who, WAVE_9A);
      expect(keys(items).sort()).toEqual([...TABLE[role]].sort());
      // In the order asked.
      expect(keys(items)).toEqual(WAVE_9A.filter((key) => TABLE[role].includes(key)));
    });
  }

  it('answers every element as the registry says: mode, no free text, facts the route would show', async () => {
    const items = await insights(lead, WAVE_9A, '&period=d7');
    // `home.my_work` has no period of its own (`-`) and `d7` is not one of its periods; period-less elements go.
    expect(keys(items)).toEqual(['dashboard.ops.sla', 'dashboard.ops.volume', 'alerts.noise']);
    const text = JSON.stringify(items);
    for (const secret of [`Subject-${sentinel}`, `Incident-${sentinel}`, `Alert-${sentinel}`]) {
      expect(text).not.toContain(secret);
    }
    const noise = items.find((item) => item.element === 'alerts.noise');
    expect(noise?.facts.find((fact) => fact.id === 'noise')?.value).toBe(2);
    expect(noise?.claims.length).toBeGreaterThan(0);
  });

  it('leaves out an element that does not exist, one with a scope of the wrong kind, and a period it does not allow', async () => {
    expect(keys(await insights(head, ['nope.nothing', 'alerts.noise']))).toEqual(['alerts.noise']);
    expect(await insights(head, ['alerts.noise'], `&scope=org:${orgId}`)).toEqual([]);
    expect(await insights(head, ['incidents.open'], '&period=d7')).toEqual([]);
    expect(await insights(head, ['dashboard.ops.sla'], '&period=d91')).toEqual([]);
    expect(await insights(head, ['dashboard.ops.sla'], '&period=d90')).toHaveLength(1);
    // Elements of mode R or X, and of wave 9b with no builder yet, are simply absent.
    expect(await insights(head, ['kb', 'shift.notes', 'ticket.workspace', 'org.health'])).toEqual(
      [],
    );
  });

  it('shows a person only their own home.my_work', async () => {
    const mine = await insights(agent, ['home.my_work']);
    expect(mine[0]?.scope).toBe('user');
    expect(mine[0]?.facts.find((fact) => fact.id === 'open')?.value).toBe(3);
    const others = await insights(lead, ['home.my_work']);
    expect(others[0]?.facts.find((fact) => fact.id === 'open')?.value).toBe(0);
    // Asking for somebody else's scope is not possible: `user` has no id, and an org scope is the wrong kind.
    expect(await insights(agent, ['home.my_work'], `&scope=org:${orgId}`)).toEqual([]);
  });
});

describe('scope resolver (canViewInsight, used by the feedback of T-408)', () => {
  it('needs the rule, the kind of scope and a scope the person may read', async () => {
    const access = h.app.get(InsightAccess);
    const leadP = principalOf(lead, 'lead');
    const agentP = principalOf(agent, 'agent');
    expect(await access.canViewInsight(leadP, 'org.health', `org:${orgId}`)).toBe(true);
    // Not allowed by the rule (an agent has no org.health.read), whatever the scope.
    expect(await access.canViewInsight(agentP, 'org.health', `org:${orgId}`)).toBe(false);
    // The scope does not exist: the same answer as "not yours".
    expect(
      await access.canViewInsight(leadP, 'org.health', 'org:00000000-0000-4000-8000-000000000000'),
    ).toBe(false);
    // The wrong kind of scope for the element, and keys that are not scopes.
    expect(await access.canViewInsight(leadP, 'org.health', 'instance')).toBe(false);
    expect(await access.canViewInsight(leadP, 'org.health', 'org:nope')).toBe(false);
    expect(await access.canViewInsight(leadP, 'alerts.noise', 'instance')).toBe(true);
    expect(await access.canViewInsight(leadP, 'alerts.noise', `org:${orgId}`)).toBe(false);
    expect(await access.canViewInsight(leadP, 'not.an.element', 'instance')).toBe(false);
    // Mode X has no insight to view.
    expect(await access.canViewInsight(leadP, 'kb', 'instance')).toBe(false);
    // A customer and a system identity never do, even holding the permission.
    const granted = [...DEFAULT_ROLE_PERMISSIONS.lead];
    expect(
      await access.canViewInsight(
        principalOf(client, 'client', granted),
        'alerts.noise',
        'instance',
      ),
    ).toBe(false);
    expect(
      await access.canViewInsight(
        principalOf(client, 'system', granted),
        'alerts.noise',
        'instance',
      ),
    ).toBe(false);
    // A scope row the person cannot read (an incident / intent / service that is not there).
    const ghost = '00000000-0000-4000-8000-000000000000';
    expect(await access.canViewInsight(leadP, 'incident.detail', `incident:${ghost}`)).toBe(false);
    expect(await access.canReadScope(leadP, `intent:${ghost}`)).toBe(false);
    expect(await access.canReadScope(leadP, `service:${ghost}`)).toBe(false);
    // Without the permission that opens the module, even a real row is not readable.
    expect(await access.canReadScope(principalOf(dev, 'dev'), `org:${orgId}`)).toBe(false);
    expect(await access.canReadScope(principalOf(dev, 'dev'), `intent:${ghost}`)).toBe(false);
  });

  it('is the same check the endpoint uses: a masked developer holding the rule alone reads facts, no customer', async () => {
    const access = h.app.get(InsightAccess);
    const masked = principalOf(dev, 'dev', ['assistant.use', 'ticket.read.masked', 'alert.read']);
    expect(await access.canViewInsight(masked, 'alerts.noise', 'instance')).toBe(true);
    expect(await access.canViewInsight(masked, 'incidents.open', 'instance')).toBe(false);
    expect(await access.canViewInsight(masked, 'home.my_work', 'user')).toBe(false);
  });
});

describe('reading never creates an ai_run, and leaves marks only in Redis', () => {
  it('makes no model call and writes no ai_run, even with no narration at all', async () => {
    const before = await aiRuns();
    for (let index = 0; index < 3; index += 1) await insights(lead, WAVE_9A);
    expect(await aiRuns()).toBe(before);
  });

  it('marks the element viewed (user and language) and dirty when there is no narration', async () => {
    await redis().del(
      viewedKey('alerts.noise', 'instance', 'd7'),
      dirtyKey('alerts.noise', 'instance', 'd7'),
    );
    const items = await insights(lead, ['alerts.noise'], '&locale=th');
    expect(items[0]?.state).toBe('none');
    expect(items[0]?.stateLabel).toBe('ยังไม่มีสรุป AI ล่าสุด — แสดงข้อมูลจากระบบ');
    const viewers = await redis().zrange(viewedKey('alerts.noise', 'instance', 'd7'), '0', '-1');
    expect(viewers).toEqual([`${lead.userId}:th`]);
    expect(await redis().ttl(viewedKey('alerts.noise', 'instance', 'd7'))).toBeGreaterThan(0);
    const dirty = await redis().hgetall(dirtyKey('alerts.noise', 'instance', 'd7'));
    expect(Number(dirty['firstAt'])).toBeGreaterThan(0);
    expect(Number(dirty['lastAt'])).toBeGreaterThanOrEqual(Number(dirty['firstAt']));
  });

  it('marks nothing for an element that is F only (nothing for the worker to write)', async () => {
    await redis().del(viewedKey('incidents.open', 'instance', 'now'));
    await redis().del(userDirtyKey(agent.userId, 'home.my_work'));
    const items = await insights(agent, ['home.my_work', 'incidents.open']);
    // `home.my_work` is F in 9a; `incidents.open` is N.
    expect(items.find((item) => item.element === 'home.my_work')?.state).toBe('system');
    expect(await redis().exists(userDirtyKey(agent.userId, 'home.my_work'))).toBe(0);
    expect(await redis().zcard(viewedKey('incidents.open', 'instance', 'now'))).toBe(1);
  });
});

describe('state selection: narration, fingerprint and expiry', () => {
  const claim = (factId: string, text: string) => [
    { text, evidence: [{ kind: 'service', id: '00000000-0000-4000-8000-000000000001', factId }] },
  ];

  it('is system for an F element, whatever is stored', async () => {
    const items = await insights(lead, ['dashboard.ops.sla']);
    expect(items[0]?.mode).toBe('N');
    const mine = await insights(agent, ['home.my_work']);
    expect(mine[0]).toMatchObject({
      mode: 'F',
      state: 'system',
      stateLabel: 'From system',
      narration: null,
    });
  });

  it('is fresh when the stored fingerprint matches, with the narration and its age', async () => {
    await storeNarration({
      element: 'alerts.noise',
      period: 'd7',
      locale: 'en',
      fingerprint: await currentFingerprint(),
      claims: claim('noise', '2 alerts were noise'),
      expiresInMinutes: 60,
    });
    await redis().del(dirtyKey('alerts.noise', 'instance', 'd7'));
    const [item] = await insights(lead, ['alerts.noise']);
    expect(item?.state).toBe('fresh');
    expect(item?.stateLabel).toMatch(/^AI · \d+m ago$/);
    expect(item?.narration?.claims[0]?.text).toBe('2 alerts were noise');
    expect(item?.narration?.mock).toBe(true);
    // A catalog ref is restored with the viewer's rights: the name of the service is not there (no such row),
    // so the chip says "No access" and carries no link.
    expect(item?.narration?.claims[0]?.evidence[0]).toEqual({ kind: 'data', label: 'No access' });
    // Fresh = nothing for the worker to do.
    expect(await redis().exists(dirtyKey('alerts.noise', 'instance', 'd7'))).toBe(0);
  });

  it('is stale when the data moved on: live facts plus the old narration, and a dirty mark', async () => {
    await storeNarration({
      element: 'alerts.noise',
      period: 'd7',
      locale: 'en',
      fingerprint: 'deadbeefdeadbeefdeadbeefdeadbeef',
      claims: claim('noise', '2 alerts were noise'),
      expiresInMinutes: 60,
    });
    await redis().del(dirtyKey('alerts.noise', 'instance', 'd7'));
    const [item] = await insights(lead, ['alerts.noise']);
    expect(item?.state).toBe('stale');
    expect(item?.stateLabel).toBe('Summary predates latest data');
    expect(item?.narration?.claims).toHaveLength(1);
    expect(item?.facts.find((fact) => fact.id === 'noise')?.value).toBe(2);
    expect(await redis().exists(dirtyKey('alerts.noise', 'instance', 'd7'))).toBe(1);
  });

  it('is none once the narration has expired, and ignores a narration in the other language', async () => {
    await storeNarration({
      element: 'alerts.noise',
      period: 'd7',
      locale: 'en',
      fingerprint: await currentFingerprint(),
      claims: claim('noise', '2 alerts were noise'),
      expiresInMinutes: -1,
    });
    const [expired] = await insights(lead, ['alerts.noise']);
    expect(expired).toMatchObject({ state: 'none', narration: null });
    await storeNarration({
      element: 'alerts.noise',
      period: 'd7',
      locale: 'en',
      fingerprint: await currentFingerprint(),
      claims: claim('noise', '2 alerts were noise'),
      expiresInMinutes: 60,
    });
    const [thai] = await insights(lead, ['alerts.noise'], '&locale=th');
    expect(thai).toMatchObject({ state: 'none', narration: null });
    // The facts and sentences are still there, in Thai.
    expect(thai?.claims.every((entry) => !/[A-Za-z]{4,} (is|are)\b/.test(entry.text))).toBe(true);
  });

  it('is paused while the kill switch is on, and hides the narration', async () => {
    await storeNarration({
      element: 'alerts.noise',
      period: 'd7',
      locale: 'en',
      fingerprint: await currentFingerprint(),
      claims: claim('noise', '2 alerts were noise'),
      expiresInMinutes: 60,
    });
    await setKillSwitch(true);
    try {
      const [item] = await insights(lead, ['alerts.noise']);
      expect(item).toMatchObject({
        state: 'paused',
        stateLabel: 'AI paused — showing system data',
        narration: null,
      });
      expect(item?.facts.length).toBeGreaterThan(0);
    } finally {
      await setKillSwitch(false);
    }
  });

  it('never shows a narration to a masked developer that names a customer or a number the facts lack', async () => {
    const orgClaim = [
      { text: '2 alerts were noise', evidence: [{ kind: 'org', id: orgId, factId: 'noise' }] },
    ];
    await storeNarration({
      element: 'alerts.noise',
      period: 'd7',
      locale: 'en',
      fingerprint: await currentFingerprint(),
      claims: orgClaim,
      expiresInMinutes: 60,
    });
    // The developer here holds alert.read and dashboard.ops.read by a granted role; they have no ticket.read.
    const boss = head;
    const roles = await boss.client.get<{ roles: { role: string; permissions: string[] }[] }>(
      '/v1/rbac/roles',
    );
    const before = roles.body.roles.find((entry) => entry.role === 'dev')?.permissions ?? [];
    const set = (permissions: string[]) =>
      boss.client.put('/v1/rbac/roles/dev/permissions', { permissions });
    expect((await set([...before, 'alert.read'])).status).toBe(200);
    try {
      const [masked] = await insights(dev, ['alerts.noise']);
      // Its only claim names an organization: not for a masked reader. They read the facts, "From system".
      expect(masked).toMatchObject({ state: 'system', stateLabel: 'From system', narration: null });
      expect(JSON.stringify(masked)).not.toContain(orgId);
      // The same stored narration reaches a person with the full read, as a chip of the org.
      const [full] = await insights(lead, ['alerts.noise']);
      expect(full?.state).toBe('fresh');
      expect(full?.narration?.claims[0]?.evidence[0]).toMatchObject({
        kind: 'data',
        label: `Org-${sentinel}`,
      });
    } finally {
      expect((await set(before)).status).toBe(200);
    }
  });
});

describe('pii.read (section 9.3: a read that names people is on the audit log)', () => {
  async function piiRows(actor: string): Promise<number> {
    const result = await owner().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = 'pii.read' AND actor_id = $1
         AND target_type = 'shift_overview'`,
      [actor],
    );
    return Number(result.rows[0]?.n);
  }

  it('is written for shift.overview and home.team, not for elements without people', async () => {
    const before = await piiRows(lead.userId);
    const items = await insights(lead, ['shift.overview', 'home.team']);
    expect(keys(items)).toEqual(['shift.overview', 'home.team']);
    const overview = items[0];
    // The person is a placeholder restored with the name; this viewer holds roster.manage.
    const person = overview?.facts.find((fact) => /^person_[a-h]_held$/.test(fact.id));
    expect(person).toBeDefined();
    expect(person?.text).not.toMatch(/\{person_/);
    // One row for the call (the two elements share a kind), naming the elements and nothing else.
    expect(await piiRows(lead.userId)).toBe(before + 1);
    const last = await owner().query<{ metadata: { elements: string[]; via: string } }>(
      `SELECT metadata FROM audit_log WHERE action = 'pii.read' AND actor_id = $1 AND target_type = 'shift_overview'
        ORDER BY created_at DESC LIMIT 1`,
      [lead.userId],
    );
    expect(last.rows[0]?.metadata).toMatchObject({
      via: 'insights',
      elements: ['shift.overview', 'home.team'],
    });
    const agentBefore = await piiRows(agent.userId);
    await insights(agent, ['alerts.noise', 'home.my_work', 'shift.overview']);
    expect(await piiRows(agent.userId)).toBe(agentBefore);
  });

  it('home.team is shift.overview: same facts, narration of shift.overview', async () => {
    const [overview, team] = await insights(lead, ['shift.overview', 'home.team']);
    expect(team?.facts).toEqual(overview?.facts);
  });
});

describe('rate limit and single-flight (C-11)', () => {
  it('computes the facts once for many callers asking at the same time, and shares them for 30 s', async () => {
    const service = h.app.get(InsightsService);
    const before = service.computations;
    // Eight callers, one (element, scope, period, view): d13 has not been asked before.
    const who = [lead, head, agent, lead, head, agent, lead, head];
    const answers = await Promise.all(
      who.map((persona) => insights(persona, ['dashboard.ops.volume'], '&period=d13')),
    );
    for (const items of answers) expect(items).toHaveLength(1);
    expect(service.computations - before).toBe(1);
    await insights(lead, ['dashboard.ops.volume'], '&period=d13');
    expect(service.computations - before).toBe(1);
    // Another period is another computation.
    await insights(lead, ['dashboard.ops.volume'], '&period=d14');
    expect(service.computations - before).toBe(2);
  });

  it('answers 429 after 60 requests in a minute, per person and not for anybody else', async () => {
    const busy = await signIn(h, 'lead');
    const quiet = await signIn(h, 'lead');
    for (let index = 0; index < 60; index += 1) {
      expect((await busy.client.get('/v1/insights?elements=kb')).status).toBe(200);
    }
    const refused = await busy.client.get('/v1/insights?elements=kb');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).not.toBeNull();
    expect((await quiet.client.get('/v1/insights?elements=kb')).status).toBe(200);
  }, 60_000);

  it('marks at most 30 different (element, scope, period) viewed per person per hour, and still answers', async () => {
    const reader = await signIn(h, 'lead');
    const marked = async (period: string): Promise<number> =>
      redis()
        .zscore(viewedKey('alerts.noise', 'instance', period), `${reader.userId}:en`)
        .then((score) => (score === null ? 0 : 1));
    for (let day = 1; day <= 30; day += 1) {
      expect(await insights(reader, ['alerts.noise'], `&period=d${String(day)}`)).toHaveLength(1);
    }
    expect(await marked('d30')).toBe(1);
    // The 31st different one is read in full and not marked.
    expect(await insights(reader, ['alerts.noise'], '&period=d31')).toHaveLength(1);
    expect(await marked('d31')).toBe(0);
    // One already marked still is.
    expect(await insights(reader, ['alerts.noise'], '&period=d5')).toHaveLength(1);
    expect(await marked('d5')).toBe(1);
  }, 60_000);
});

describe('budget state', () => {
  it('is budget when no narration exists and the daily AI budget is used up (F stays on)', async () => {
    const own = await startHarness();
    try {
      const boss = await signIn(own, 'lead');
      await own.db.owner.pool.query(
        `UPDATE ai_switch SET is_on = false WHERE key = 'ai_kill_switch'`,
      );
      const open = await boss.client.get<InsightsResponse>('/v1/insights?elements=alerts.noise');
      expect(open.body.items[0]?.state).toBe('none');
      await own.db.owner.pool.query(
        `INSERT INTO ai_run (started_at, agent, provider, model, tier, prompt_id, prompt_version, prompt_hash, input_hmac, redaction, input_tokens, output_tokens, cost_usd, status)
         VALUES (now(), 'classifier', 'anthropic', 'm', 'light', 'classifier', 1, repeat('a', 64), repeat('b', 64), '{"total":0,"byKind":{}}', 400000, 200000, 5, 'ok')`,
      );
      const closed = await boss.client.get<InsightsResponse>('/v1/insights?elements=alerts.noise');
      expect(closed.body.items[0]).toMatchObject({
        state: 'budget',
        stateLabel: 'AI summaries paused (daily budget reached)',
        narration: null,
      });
      expect(closed.body.items[0]?.facts.length).toBeGreaterThan(0);
    } finally {
      await own.close();
    }
  }, 120_000);

  it('narration.id matches ai_element_insight.id so feedback target is found (P0 wiring)', async () => {
    const fp = await currentFingerprint();
    await storeNarration({
      element: 'alerts.noise',
      period: 'd7',
      locale: 'en',
      fingerprint: fp,
      claims: [
        {
          text: '2 alerts were noise',
          evidence: [
            { kind: 'service', id: '00000000-0000-4000-8000-000000000001', factId: 'noise' },
          ],
        },
      ],
      expiresInMinutes: 60,
    });
    const row = await owner().query<{ id: string }>(
      `SELECT id FROM ai_element_insight WHERE element = 'alerts.noise' AND scope_key = 'instance' AND period = 'd7' AND locale = 'en' LIMIT 1`,
    );
    const items = await insights(lead, ['alerts.noise']);
    const item = items[0];
    expect(item?.narration).toBeDefined();
    expect(item?.narration?.id).toBe(row.rows[0]?.id);
  });

  it('auto-pauses narration when 7-day negative feedback is >50% with >=20 votes (AC-J21)', async () => {
    const fp = await currentFingerprint();
    await storeNarration({
      element: 'alerts.noise',
      period: 'd7',
      locale: 'en',
      fingerprint: fp,
      claims: [
        {
          text: '2 alerts were noise',
          evidence: [
            { kind: 'service', id: '00000000-0000-4000-8000-000000000001', factId: 'noise' },
          ],
        },
      ],
      expiresInMinutes: 60,
    });
    const row = await owner().query<{ id: string }>(
      `SELECT id FROM ai_element_insight WHERE element = 'alerts.noise' AND scope_key = 'instance' AND period = 'd7' AND locale = 'en' LIMIT 1`,
    );
    const targetId = row.rows[0]?.id;
    for (let i = 0; i < 20; i++) {
      const u = await owner().query<{ id: string }>(
        `INSERT INTO users (email, name, role) VALUES ($1, $2, 'agent') RETURNING id`,
        [`voter_${sentinel}_${String(i)}@example.com`, `Voter ${String(i)}`],
      );
      await owner().query(
        `INSERT INTO assistant_feedback (user_id, target_kind, target_id, element, rating, created_at, updated_at)
         VALUES ($1, 'insight', $2, 'alerts.noise', 'down', clock_timestamp(), clock_timestamp())`,
        [u.rows[0]?.id, targetId],
      );
    }
    const items = await insights(lead, ['alerts.noise']);
    const item = items[0];
    expect(item?.state).toBe('paused');
    expect(item?.narration).toBeNull();
  });

  it('R-1: auto-pauses when user switches to down via updatedAt within 7 days even with older createdAt and unlinked targetId', async () => {
    const fp = await currentFingerprint();
    await storeNarration({
      element: 'alerts.noise',
      period: 'd7',
      locale: 'en',
      fingerprint: fp,
      claims: [
        {
          text: '2 alerts were noise',
          evidence: [
            { kind: 'service', id: '00000000-0000-4000-8000-000000000001', factId: 'noise' },
          ],
        },
      ],
      expiresInMinutes: 60,
    });
    // Insert 20 feedback entries with createdAt 10 days ago, but updatedAt now, with random targetId
    for (let i = 0; i < 20; i++) {
      const u = await owner().query<{ id: string }>(
        `INSERT INTO users (email, name, role) VALUES ($1, $2, 'agent') RETURNING id`,
        [`voter_r1_${sentinel}_${String(i)}@example.com`, `Voter R1 ${String(i)}`],
      );
      await owner().query(
        `INSERT INTO assistant_feedback (user_id, target_kind, target_id, element, rating, created_at, updated_at)
         VALUES ($1, 'insight', gen_random_uuid(), 'alerts.noise', 'down', clock_timestamp() - interval '10 days', clock_timestamp())`,
        [u.rows[0]?.id],
      );
    }
    const items = await insights(lead, ['alerts.noise']);
    const item = items[0];
    expect(item?.state).toBe('paused');
    expect(item?.narration).toBeNull();
  });

  it('R-4: returns mode F and state system when INSIGHT_PERSON_NARRATION_ENABLED is false for person element', async () => {
    // Lead reads shift.overview (element.mode = 'N', personRefs = 'others')
    const items = await insights(lead, ['shift.overview']);
    const item = items[0];
    expect(item?.element).toBe('shift.overview');
    expect(item?.mode).toBe('F');
    expect(item?.state).toBe('system');
    expect(item?.stateLabel).toBe('From system');
    expect(item?.narration).toBeNull();
    expect(item?.facts.length).toBeGreaterThan(0);
  });

  it('Wave 9b: wires all mode F and mode N elements through GET /v1/insights (T-420)', async () => {
    const items = await insights(head, [
      'home.status',
      'home.volume',
      'queue.list',
      'dashboard.ops.now',
      'statuspage.admin',
      'admin.ai',
      'admin.queues',
    ]);
    const byElement = new Map(items.map((it) => [it.element, it]));

    // home.status (mode F)
    const homeStatus = byElement.get('home.status');
    expect(homeStatus).toBeDefined();
    expect(homeStatus?.mode).toBe('F');
    expect(homeStatus?.state).toBe('system');
    expect(homeStatus?.facts.some((f) => f.id === 'active_intents')).toBe(true);

    // home.volume (mode N)
    const homeVolume = byElement.get('home.volume');
    expect(homeVolume).toBeDefined();
    expect(homeVolume?.facts.some((f) => f.id === 'window_days')).toBe(true);

    // queue.list (mode F)
    const queueList = byElement.get('queue.list');
    expect(queueList).toBeDefined();
    expect(queueList?.mode).toBe('F');
    expect(queueList?.state).toBe('system');
    expect(queueList?.facts.some((f) => f.id === 'my_open')).toBe(true);

    // dashboard.ops.now (mode N)
    const dashNow = byElement.get('dashboard.ops.now');
    expect(dashNow).toBeDefined();
    expect(dashNow?.facts.some((f) => f.id === 'open_tickets')).toBe(true);

    // statuspage.admin (mode F)
    const statusAdmin = byElement.get('statuspage.admin');
    expect(statusAdmin).toBeDefined();
    expect(statusAdmin?.mode).toBe('F');
    expect(statusAdmin?.state).toBe('system');
    expect(statusAdmin?.facts.some((f) => f.id === 'total_components')).toBe(true);

    // admin.ai (mode F)
    const adminAi = byElement.get('admin.ai');
    expect(adminAi).toBeDefined();
    expect(adminAi?.mode).toBe('F');
    expect(adminAi?.state).toBe('system');
    expect(adminAi?.facts.some((f) => f.id === 'kill_switch')).toBe(true);

    // admin.queues (mode F)
    const adminQueues = byElement.get('admin.queues');
    expect(adminQueues).toBeDefined();
    expect(adminQueues?.mode).toBe('F');
    expect(adminQueues?.state).toBe('system');
    expect(adminQueues?.facts.some((f) => f.id === 'outbox_pending')).toBe(true);
  });

  it('C-1: reports.ai_cost resolves intent ref UUID without 22P02 PostgresError', async () => {
    let intentKey: string;
    const [existingIntent] = await owner()
      .query<{ id: string; key: string }>('SELECT id, key FROM intent LIMIT 1')
      .then((res) => res.rows);
    let intentId = existingIntent?.id;
    if (!existingIntent) {
      const [inserted] = await owner()
        .query<{ id: string; key: string }>(
          `INSERT INTO intent (key, name, description) VALUES ('billing_inquiry', 'Billing Inquiry', 'Billing questions') RETURNING id, key`,
        )
        .then((res) => res.rows);
      intentId = inserted?.id;
      intentKey = inserted?.key ?? 'billing_inquiry';
    } else {
      intentKey = existingIntent.key;
    }

    await owner().query(
      `INSERT INTO ai_run (
        started_at, agent, intent, provider, model, tier,
        prompt_id, prompt_version, prompt_hash, input_hmac,
        cost_usd, input_tokens, output_tokens, status, redaction
      ) VALUES (
        NOW(), 'investigator', $1, 'mock', 'mock-model', 'standard',
        'test_investigate', 1, $2, $3,
        '1.2500', 500, 100, 'ok', '{"total": 0, "byKind": {}}'::jsonb
      )`,
      [intentKey, 'c'.repeat(64), 'c'.repeat(64)],
    );

    const items = await insights(head, ['reports.ai_cost'], '&period=d7');
    expect(items).toHaveLength(1);
    const costItem = items[0];
    expect(costItem?.element).toBe('reports.ai_cost');

    // Intent driver fact is present
    const intentDriverFact = costItem?.facts.find((f) => f.id.startsWith('cost_intent_'));
    expect(intentDriverFact).toBeDefined();

    // Intent evidence chip must be resolved from the valid UUID intent
    const allEvidence = costItem?.claims.flatMap((c) => c.evidence) ?? [];
    const intentChip = allEvidence.find((e) => e.kind === 'intent');
    expect(intentChip).toBeDefined();
    expect(intentChip?.ref).toEqual({
      kind: 'intent',
      id: intentId,
    });
    expect(intentChip?.label).not.toBe('No access');
    expect(intentChip?.label).toBeTruthy();

    // Top agent is a metric fact without ref (does not map to schema.service)
    const topAgentFact = costItem?.facts.find((f) => f.id === 'top_agent_runs');
    expect(topAgentFact).toBeDefined();
    expect(topAgentFact?.value).toBe(1);
  });
});
