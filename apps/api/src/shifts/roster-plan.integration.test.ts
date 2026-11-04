import { DevMockLlmProvider, type LlmProvider, type LlmRequest } from '@watchtower/ai';
import type {
  ApplyRosterPlanResult,
  RosterList,
  RosterPlan,
  RosterPlanDefaults,
  RosterPlanList,
  ShiftDefinition,
} from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_LLM } from '../ai/ai-runtime.js';
import { startHarness, type Harness } from '../testing/harness.js';
import { apiCalendar, signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';
import { SHIFT_NOW } from './shift-core.js';

// T-305e: the roster planner over HTTP. The solver is tested on its own in @watchtower/shared; here: RBAC, the
// draft, the leave and the shifts that have started, the hand edit and its re-check, apply (a person, through the
// roster service and its audit), and the AI explanation (names never sent, offline is a 503 and nothing else).

const WEEK = '2026-11-02'; // a Monday
let h: Harness;
let head: Persona;
let lead: Persona;
let agents: Persona[] = [];
let day: ShiftDefinition;
let evening: ShiftDefinition;
let night: ShiftDefinition;
/** Friday before the week, 10:00 in Bangkok. */
let fakeNow: Date | null = null;
const BEFORE = new Date('2026-10-30T03:00:00Z');
const calls: LlmRequest[] = [];
let answer: unknown = undefined;

const owner = () => h.db.owner.pool;
const spy: LlmProvider = (() => {
  const inner = new DevMockLlmProvider();
  return {
    kind: 'mock' as const,
    generate: (request: LlmRequest) => {
      calls.push(request);
      if (request.prompt.id === 'roster_planner' && answer !== undefined) {
        return Promise.resolve({
          text: typeof answer === 'string' ? answer : JSON.stringify(answer),
          finishReason: 'stop' as const,
          usage: { inputTokens: 50, outputTokens: 20 },
          model: request.model,
        });
      }
      return inner.generate(request);
    },
  };
})();

const AGENT_NAMES = [
  'Anan Planner',
  'Bella Planner',
  'Chai Planner',
  'Dara Planner',
  'Eka Planner',
  'Fah Planner',
];

beforeAll(async () => {
  h = await startHarness({
    overrides: [
      { token: SHIFT_NOW, value: () => fakeNow ?? BEFORE },
      { token: API_LLM, value: spy },
    ],
  });
  head = await signIn(h, 'head', undefined, 'Head Planner');
  lead = await signIn(h, 'lead', undefined, 'Lead Planner');
  await apiCalendar(head, {
    name: 'Bangkok office hours',
    timezone: 'Asia/Bangkok',
    isDefault: true,
  });
  agents = [];
  for (const name of AGENT_NAMES) agents.push(await signIn(h, 'agent', undefined, name));
  const make = async (name: string, startsAt: string, endsAt: string, onCall = false) => {
    const response = await lead.client.post<ShiftDefinition>('/v1/shifts/definitions', {
      name,
      startsAt,
      endsAt,
      onCall,
    });
    expect(response.status).toBe(201);
    return response.body;
  };
  day = await make('Day', '08:00', '17:00');
  evening = await make('Evening', '13:00', '22:00');
  night = await make('Night', '22:00', '08:00', true);
});
afterAll(async () => {
  await h.close();
});

const ids = () => agents.map((agent) => agent.userId);
const baseBody = (over: Record<string, unknown> = {}) => ({
  weekStart: WEEK,
  userIds: ids(),
  coverage: [
    { shiftId: day.id, required: 1 },
    { shiftId: evening.id, required: 1 },
    { shiftId: night.id, required: 1 },
  ],
  ...over,
});

async function makePlan(body: Record<string, unknown> = baseBody()): Promise<RosterPlan> {
  const response = await lead.client.post<RosterPlan>('/v1/roster/plans', body);
  if (response.status !== 201)
    throw new Error(`plan: ${String(response.status)} ${JSON.stringify(response.body)}`);
  return response.body;
}

async function rosterOfWeek(): Promise<RosterList> {
  const response = await lead.client.get<RosterList>(`/v1/roster?from=${WEEK}&to=2026-11-08`);
  expect(response.status).toBe(200);
  return response.body;
}

async function actions(action: string): Promise<number> {
  const rows = await owner().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = $1`,
    [action],
  );
  return rows.rows[0]?.n ?? 0;
}

describe('who may use the planner', () => {
  it('turns away a visitor (401) and an agent or a client (403) on every route; lead and head may', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const routes: [string, string, unknown?][] = [
      ['GET', '/v1/roster/plans'],
      ['GET', `/v1/roster/plans/defaults?weekStart=${WEEK}`],
      ['POST', '/v1/roster/plans', baseBody()],
      ['GET', `/v1/roster/plans/${id}`],
      ['PATCH', `/v1/roster/plans/${id}/entries`, { add: [], remove: [] }],
      ['POST', `/v1/roster/plans/${id}/explain`, { locale: 'en' }],
      ['POST', `/v1/roster/plans/${id}/apply`, {}],
      ['POST', `/v1/roster/plans/${id}/discard`],
    ];
    const orgForClient = (
      await lead.client.post<{ id: string }>('/v1/orgs', { name: 'Planner client org' })
    ).body.id;
    const client = await signIn(h, 'client', orgForClient);
    for (const [method, path, body] of routes) {
      const stranger = await h.client().request(method, path, { csrf: false });
      expect(stranger.status, `${method} ${path} visitor`).toBe(401);
      for (const who of [agents[0], client]) {
        const response = await who?.client.request(
          method,
          path,
          body === undefined ? {} : { body },
        );
        expect(response?.status, `${method} ${path}`).toBe(403);
      }
    }
    expect((await lead.client.get('/v1/roster/plans')).status).toBe(200);
    expect((await head.client.get('/v1/roster/plans')).status).toBe(200);
  });
});

describe('defaults', () => {
  it('lists people with their queues, the active shifts, the default rules and a coverage guess', async () => {
    const response = await lead.client.get<RosterPlanDefaults>(
      `/v1/roster/plans/defaults?weekStart=${WEEK}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.timezone).toBe('Asia/Bangkok');
    expect(response.body.shifts.map((shift) => shift.name)).toEqual(['Day', 'Evening', 'Night']);
    expect(response.body.people.map((person) => person.name)).toEqual(
      expect.arrayContaining(AGENT_NAMES),
    );
    expect(response.body.rules.minRestHours).toBe(11);
    expect(response.body.coverageSource).toBe('suggested');
    // no tickets yet: the minimum of one on every shift
    expect(response.body.coverage.map((rule) => rule.required)).toEqual([1, 1, 1]);
  });
});

describe('a draft plan', () => {
  it('is made by the solver, meets coverage, breaks no rule, and writes nothing to the roster', async () => {
    const before = await actions('roster.assign');
    const plan = await makePlan();
    expect(plan.status).toBe('draft');
    expect(plan.solver.status).toBe('complete');
    expect(plan.report.hardOk).toBe(true);
    expect(plan.report.coverageOk).toBe(true);
    expect(plan.entries.filter((entry) => !entry.locked)).toHaveLength(21);
    expect(plan.diff).toMatchObject({ add: 21, remove: 0, keep: 0, started: 0 });
    expect((await rosterOfWeek()).entries).toHaveLength(0);
    expect(await actions('roster.assign')).toBe(before);
    expect(await actions('roster.plan_create')).toBeGreaterThan(0);

    const again = await lead.client.get<RosterPlan>(`/v1/roster/plans/${plan.id}`);
    expect(again.status).toBe(200);
    expect(again.body.entries).toEqual(plan.entries);
    const list = await lead.client.get<RosterPlanList>('/v1/roster/plans');
    expect(list.body.plans.find((p) => p.id === plan.id)?.entryCount).toBe(21);
  });

  it('keeps people away on the days they are on leave', async () => {
    const [first] = agents;
    const plan = await makePlan(
      baseBody({ unavailable: [{ userId: first?.userId, dates: ['2026-11-03', '2026-11-04'] }] }),
    );
    expect(plan.report.hardOk).toBe(true);
    const mine = plan.entries.filter((entry) => entry.userId === first?.userId);
    expect(mine.some((entry) => ['2026-11-03', '2026-11-04'].includes(entry.workDate))).toBe(false);
  });

  it('says when no plan can meet the coverage, with the reason, and still returns the best plan', async () => {
    const plan = await makePlan(
      baseBody({ coverage: [{ shiftId: day.id, required: 8 }], userIds: ids().slice(0, 4) }),
    );
    expect(plan.solver.status).toBe('no_solution');
    expect(plan.report.hardOk).toBe(true);
    expect(plan.report.coverageOk).toBe(false);
    const coverage = plan.report.items.find((item) => item.id === 'coverage');
    expect(coverage?.status).toBe('fail');
    expect(coverage?.failures[0]?.params).toMatchObject({ required: 8, assigned: 4 });
  });

  it('refuses a week that is over, nobody to roster, an unknown shift, and a person outside the plan on leave', async () => {
    const post = (body: Record<string, unknown>) =>
      lead.client.post<ApiErrorBody>('/v1/roster/plans', body);
    expect((await post(baseBody({ weekStart: '2026-10-05' }))).status).toBe(400);
    expect(
      (
        await post(
          baseBody({
            coverage: [{ shiftId: '00000000-0000-4000-8000-000000000009', required: 1 }],
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await post(baseBody({ unavailable: [{ userId: head.userId, dates: ['2026-11-03'] }] })))
        .status,
    ).toBe(400);
    expect((await post({ weekStart: 'not-a-date' })).status).toBe(400);
  });

  it('does not plan a shift that has started, and keeps the one that stands', async () => {
    const [first] = agents;
    // Monday 09:00 in Bangkok: the Monday day shift is running.
    fakeNow = new Date('2026-11-02T02:00:00Z');
    try {
      const stand = await lead.client.post<{ id: string }>('/v1/roster', {
        shiftId: day.id,
        userId: first?.userId,
        workDate: WEEK,
      });
      expect(stand.status).toBe(201);
      const plan = await makePlan(baseBody({ coverage: [{ shiftId: day.id, required: 1 }] }));
      expect(plan.report.coverageOk).toBe(true);
      const monday = plan.entries.filter(
        (entry) => entry.workDate === WEEK && entry.shiftId === day.id,
      );
      expect(monday).toHaveLength(1);
      expect(monday[0]).toMatchObject({ userId: first?.userId, locked: true });
      expect(plan.diff.locked).toBeGreaterThanOrEqual(1);

      const add = await lead.client.patch<ApiErrorBody>(`/v1/roster/plans/${plan.id}/entries`, {
        add: [{ userId: agents[1]?.userId, shiftId: day.id, workDate: WEEK }],
      });
      expect(add.status).toBe(400);
      expect(add.body.message).toContain('already started');

      const applied = await lead.client.post<ApplyRosterPlanResult>(
        `/v1/roster/plans/${plan.id}/apply`,
        {},
      );
      expect(applied.status).toBe(200);
      const roster = await rosterOfWeek();
      // the started shift is still there, untouched
      expect(
        roster.entries.filter((entry) => entry.workDate === WEEK && entry.shiftName === 'Day'),
      ).toHaveLength(1);
      await lead.client.delete(`/v1/roster/${stand.body.id}`);
      for (const entry of roster.entries) await lead.client.delete(`/v1/roster/${entry.id}`);
    } finally {
      fakeNow = null;
    }
  });
});

describe('a hand edit', () => {
  it('checks the plan again: a broken rest rule shows in the report and blocks apply', async () => {
    const plan = await makePlan();
    const [first] = agents;
    const first_ = plan.entries.filter((entry) => entry.userId === first?.userId);
    // Night of Monday, then the day shift of Tuesday: the rest between them is far under 11 hours.
    const edited = await lead.client.patch<RosterPlan>(`/v1/roster/plans/${plan.id}/entries`, {
      remove: first_.map((entry) => ({
        userId: entry.userId,
        shiftId: entry.shiftId,
        workDate: entry.workDate,
      })),
      add: [
        { userId: first?.userId, shiftId: night.id, workDate: WEEK },
        { userId: first?.userId, shiftId: day.id, workDate: '2026-11-03' },
      ],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.report.hardOk).toBe(false);
    expect(edited.body.report.items.find((item) => item.id === 'rest')?.status).toBe('fail');
    const refused = await lead.client.post<ApiErrorBody>(`/v1/roster/plans/${plan.id}/apply`, {});
    expect(refused.status).toBe(409);
    expect(await actions('roster.plan_edit')).toBeGreaterThan(0);

    // Take the Tuesday day shift away again: the rule holds, and the plan may be applied once coverage is accepted.
    const fixed = await lead.client.patch<RosterPlan>(`/v1/roster/plans/${plan.id}/entries`, {
      remove: [{ userId: first?.userId, shiftId: day.id, workDate: '2026-11-03' }],
    });
    expect(fixed.body.report.hardOk).toBe(true);
    expect(fixed.body.report.coverageOk).toBe(false);
    const noShortfall = await lead.client.post<ApiErrorBody>(
      `/v1/roster/plans/${plan.id}/apply`,
      {},
    );
    expect(noShortfall.status).toBe(409);
    expect(noShortfall.body.message).toContain('acceptShortfall');
    await lead.client.post(`/v1/roster/plans/${plan.id}/discard`);
  });

  it('refuses a shift of someone outside the plan, outside the week, or one that is not in the plan to remove', async () => {
    const plan = await makePlan();
    const patch = (body: Record<string, unknown>) =>
      lead.client.patch<ApiErrorBody>(`/v1/roster/plans/${plan.id}/entries`, body);
    expect(
      (await patch({ add: [{ userId: head.userId, shiftId: day.id, workDate: WEEK }] })).status,
    ).toBe(400);
    expect(
      (
        await patch({
          add: [{ userId: agents[0]?.userId, shiftId: day.id, workDate: '2026-11-20' }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await patch({
          remove: [{ userId: agents[0]?.userId, shiftId: day.id, workDate: '2026-12-20' }],
        })
      ).status,
    ).toBe(400);
    expect((await patch({})).status).toBe(400);
    await lead.client.post(`/v1/roster/plans/${plan.id}/discard`);
  });
});

describe('apply', () => {
  it('is a person who decides: it writes the roster through the roster service, audited, replaces strays, and cannot run twice', async () => {
    // A stray entry of a person in the plan that the plan does not keep: applying removes it.
    const stray = await lead.client.post<{ id: string }>('/v1/roster', {
      shiftId: night.id,
      userId: agents[5]?.userId,
      workDate: '2026-11-08',
    });
    expect(stray.status).toBe(201);
    const plan = await makePlan();
    expect(plan.diff.remove).toBe(1);
    const assignsBefore = await actions('roster.assign');

    const applied = await lead.client.post<ApplyRosterPlanResult>(
      `/v1/roster/plans/${plan.id}/apply`,
      {},
    );
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ added: 21, removed: 1 });
    expect(applied.body.plan.status).toBe('applied');
    expect(applied.body.plan.appliedAt).not.toBeNull();

    const roster = await rosterOfWeek();
    expect(roster.entries).toHaveLength(21);
    expect(roster.entries.some((entry) => entry.id === stray.body.id)).toBe(false);
    expect(await actions('roster.assign')).toBe(assignsBefore + 21);
    expect(await actions('roster.plan_apply')).toBeGreaterThan(0);
    expect(await actions('roster.remove')).toBeGreaterThan(0);

    expect((await lead.client.post(`/v1/roster/plans/${plan.id}/apply`, {})).status).toBe(409);
    expect((await lead.client.post(`/v1/roster/plans/${plan.id}/discard`)).status).toBe(409);
    expect(
      (
        await lead.client.patch(`/v1/roster/plans/${plan.id}/entries`, {
          remove: [plan.entries[0]],
        })
      ).status,
    ).toBe(409);
    const stored = await lead.client.get<RosterPlan>(`/v1/roster/plans/${plan.id}`);
    expect(stored.body.status).toBe('applied');
    for (const entry of roster.entries) await lead.client.delete(`/v1/roster/${entry.id}`);
  });

  it('keeps a shift that has a clock-in on it, and a plan cannot contain one that has started', async () => {
    const [first] = agents;
    const entry = await lead.client.post<{ id: string }>('/v1/roster', {
      shiftId: day.id,
      userId: first?.userId,
      workDate: '2026-11-04',
    });
    expect(entry.status).toBe(201);
    const plan = await makePlan(baseBody({ coverage: [{ shiftId: evening.id, required: 1 }] }));
    expect(plan.diff.remove).toBe(1);
    // The person clocks in on it (Wednesday 08:00 in Bangkok): from then it is not the planner's to remove.
    fakeNow = new Date('2026-11-04T01:00:00Z');
    try {
      const clock = await first?.client.post('/v1/shifts/clock-in', {});
      expect(clock?.status).toBe(200);
      const applied = await lead.client.post<ApplyRosterPlanResult>(
        `/v1/roster/plans/${plan.id}/apply`,
        {
          acceptShortfall: true,
        },
      );
      // Tuesday and Wednesday morning have started by then: a plan that holds them is refused as a whole.
      expect(applied.status).toBe(409);
      expect((applied.body as unknown as ApiErrorBody).message).toContain('already started');
    } finally {
      fakeNow = null;
    }
    expect((await rosterOfWeek()).entries.some((e) => e.id === entry.body.id)).toBe(true);
    await lead.client.post(`/v1/roster/plans/${plan.id}/discard`);
  });
});

describe('discard', () => {
  it('throws a draft away', async () => {
    const plan = await makePlan();
    const discarded = await lead.client.post<RosterPlan>(`/v1/roster/plans/${plan.id}/discard`);
    expect(discarded.status).toBe(200);
    expect(discarded.body.status).toBe('discarded');
    expect((await lead.client.post(`/v1/roster/plans/${plan.id}/apply`, {})).status).toBe(409);
    expect(
      (await lead.client.get('/v1/roster/plans/00000000-0000-4000-8000-0000000000ff')).status,
    ).toBe(404);
  });
});

describe('the AI explanation', () => {
  it('sends labels instead of names, puts the names back, audits the run, and is dropped by a hand edit', async () => {
    const plan = await makePlan();
    calls.length = 0;
    answer = { explanation: 'Every shift is covered. staff-1 and staff-2 share the nights.' };
    try {
      const explained = await lead.client.post<RosterPlan>(`/v1/roster/plans/${plan.id}/explain`, {
        locale: 'th',
      });
      expect(explained.status).toBe(200);
      const sorted = [...agents].sort((a, b) => (a.userId < b.userId ? -1 : 1));
      const nameOf = (persona: Persona | undefined) =>
        AGENT_NAMES[agents.indexOf(persona as Persona)] ?? '';
      expect(explained.body.explanation?.text).toContain(nameOf(sorted[0]));
      expect(explained.body.explanation?.text).not.toContain('staff-1');
      expect(explained.body.explanation?.locale).toBe('th');

      const sent = calls.filter((call) => call.prompt.id === 'roster_planner');
      expect(sent).toHaveLength(1);
      const seen =
        (sent[0]?.system ?? '') + (sent[0]?.messages ?? []).map((m) => m.content).join('');
      for (const name of AGENT_NAMES) expect(seen).not.toContain(name);
      expect(seen).toContain('staff-1');

      const runs = await owner().query<{ agent: string }>(
        `SELECT agent FROM ai_run WHERE prompt_id = 'roster_planner'`,
      );
      expect(runs.rowCount).toBe(1);
      expect(await actions('roster.plan_explain')).toBeGreaterThan(0);

      const kept = await lead.client.get<RosterPlan>(`/v1/roster/plans/${plan.id}`);
      expect(kept.body.explanation).not.toBeNull();
      const edited = await lead.client.patch<RosterPlan>(`/v1/roster/plans/${plan.id}/entries`, {
        remove: [plan.entries[0]],
      });
      expect(edited.body.explanation).toBeNull();
    } finally {
      answer = undefined;
    }
    await lead.client.post(`/v1/roster/plans/${plan.id}/discard`);
  });

  it('answers 502 for an answer that does not fit and leaves the plan as it was', async () => {
    const plan = await makePlan();
    answer = 'not json';
    try {
      const response = await lead.client.post<ApiErrorBody>(
        `/v1/roster/plans/${plan.id}/explain`,
        {},
      );
      expect(response.status).toBe(502);
      expect(response.body.code).toBe('ai_unavailable');
      const stored = await lead.client.get<RosterPlan>(`/v1/roster/plans/${plan.id}`);
      expect(stored.body.explanation).toBeNull();
      expect(stored.body.status).toBe('draft');
    } finally {
      answer = undefined;
    }
    await lead.client.post(`/v1/roster/plans/${plan.id}/discard`);
  });
});

describe('the AI is switched off', () => {
  it('answers 503 with no model call while the kill switch is on; the plan stands', async () => {
    const plan = await makePlan();
    await owner().query(`UPDATE ai_switch SET is_on = true WHERE key = 'ai_kill_switch'`);
    try {
      calls.length = 0;
      const response = await lead.client.post<ApiErrorBody>(
        `/v1/roster/plans/${plan.id}/explain`,
        {},
      );
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('ai_unavailable');
      expect(response.body.message).toContain('kill_switch_on');
      expect(calls.filter((call) => call.prompt.id === 'roster_planner')).toHaveLength(0);
      expect((await lead.client.get(`/v1/roster/plans/${plan.id}`)).status).toBe(200);
    } finally {
      await owner().query(`UPDATE ai_switch SET is_on = false WHERE key = 'ai_kill_switch'`);
    }
    await lead.client.post(`/v1/roster/plans/${plan.id}/discard`);
  });
});

describe('the AI is offline', () => {
  it('answers 503 ai_unavailable for the explanation and leaves everything else working', async () => {
    // A live provider that is selected but not set up: the runtime is not ready (no key, no token source).
    const offline = await startHarness({
      env: { AI_PROVIDER: 'vertex' },
      overrides: [{ token: SHIFT_NOW, value: () => BEFORE }],
    });
    try {
      const boss = await signIn(offline, 'lead', undefined, 'Offline Lead');
      await apiCalendar(await signIn(offline, 'head'), {
        name: 'Cal',
        timezone: 'Asia/Bangkok',
        isDefault: true,
      });
      const shift = await boss.client.post<ShiftDefinition>('/v1/shifts/definitions', {
        name: 'Day',
        startsAt: '08:00',
        endsAt: '17:00',
      });
      const people = [await signIn(offline, 'agent'), await signIn(offline, 'agent')];
      const made = await boss.client.post<RosterPlan>('/v1/roster/plans', {
        weekStart: WEEK,
        userIds: people.map((p) => p.userId),
        coverage: [{ shiftId: shift.body.id, required: 1 }],
      });
      expect(made.status).toBe(201);
      const explained = await boss.client.post<ApiErrorBody>(
        `/v1/roster/plans/${made.body.id}/explain`,
        {},
      );
      expect(explained.status).toBe(503);
      expect(explained.body.code).toBe('ai_unavailable');
      const applied = await boss.client.post(`/v1/roster/plans/${made.body.id}/apply`, {});
      expect(applied.status).toBe(200);
    } finally {
      await offline.close();
    }
  });
});
