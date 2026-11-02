import type { TicketStats, TicketSummary } from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import {
  apiCalendar,
  apiOrg,
  apiPolicy,
  apiQueue,
  fileTicket,
  signIn,
  type ApiErrorBody,
  type Page,
  type Persona,
} from '../testing/ticketing.js';

// T-127: GET /v1/tickets/stats, the `slaState` filter and the `created_asc` / `sla_due_asc` sorts.
// The SLA state is computed on the server (UI spec 17 Q9): 30 minutes or 25 % of the target left,
// in business time, whichever is first.

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let otherAgent: Persona;
let client: Persona;
let orgId: string;
let queueA: string;
let queueB: string;

/** Tickets of the scenario by role in the test; every one belongs to `orgId`. */
const t: Record<string, string> = {};

const owner = () => h.db.owner.pool;
const minutes = (n: number): Date => new Date(Date.now() + n * 60_000);

interface Fix {
  status?: string;
  priority?: string;
  assigneeId?: string | null;
  queueId?: string | null;
  policyId?: string | null;
  firstDue?: Date | null;
  resolutionDue?: Date | null;
  firstRespondedAt?: Date | null;
  pausedAt?: Date | null;
  createdAt?: Date;
}

/** Writes ticket columns directly as the schema owner: due dates relative to now cannot come from the api. */
async function fix(id: string, f: Fix): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [id];
  const add = (column: string, value: unknown): void => {
    values.push(value);
    sets.push(`${column} = $${String(values.length)}`);
  };
  if (f.status !== undefined) add('status', f.status);
  if (f.priority !== undefined) add('priority', f.priority);
  if (f.assigneeId !== undefined) add('assignee_id', f.assigneeId);
  if (f.queueId !== undefined) add('queue_id', f.queueId);
  if (f.policyId !== undefined) add('sla_policy_id', f.policyId);
  if (f.firstDue !== undefined) add('first_response_due_at', f.firstDue);
  if (f.resolutionDue !== undefined) add('resolution_due_at', f.resolutionDue);
  if (f.firstRespondedAt !== undefined) add('first_responded_at', f.firstRespondedAt);
  if (f.pausedAt !== undefined) add('sla_paused_at', f.pausedAt);
  if (f.createdAt !== undefined) add('created_at', f.createdAt);
  await owner().query(`UPDATE ticket SET ${sets.join(', ')} WHERE id = $1`, values);
}

async function ticket(name: string, f: Fix): Promise<void> {
  const created = await fileTicket(agent, orgId, { subject: `stats ${name}` });
  t[name] = created.id;
  await fix(created.id, f);
}

const stats = (who: Persona, query = '') =>
  who.client.get<TicketStats & ApiErrorBody>(
    `/v1/tickets/stats?orgId=${orgId}${query === '' ? '' : `&${query}`}`,
  );

async function idsOf(query: string): Promise<string[]> {
  const response = await lead.client.get<Page<TicketSummary>>(
    `/v1/tickets?orgId=${orgId}&limit=200&${query}`,
  );
  expect(response.status).toBe(200);
  return response.body.items.map((item) => item.id).sort();
}

const idsFor = (...names: string[]): string[] => names.map((name) => t[name] ?? '').sort();

beforeAll(async () => {
  h = await startHarness();
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent', undefined, 'Stats Agent');
  otherAgent = await signIn(h, 'agent', undefined, 'Other Agent');
  orgId = (await apiOrg(lead, { name: 'Stats Org' })).id;
  client = await signIn(h, 'client', orgId);
  queueA = (await apiQueue(lead, { name: 'Stats queue A' })).id;
  queueB = (await apiQueue(lead, { name: 'Stats queue B' })).id;

  // A 24x7 policy, and a "business" one whose calendar has one hour a day (00:00-01:00 UTC), so
  // two days of wall clock are exactly 120 business minutes and a day-long wall gap means little.
  const wallPolicy = await apiPolicy(head, {
    name: 'Stats 24x7',
    targets: { P3: { first_response_min: 1000, resolution_min: 5000, calendar: '24x7' } },
  });
  const hour = [{ start: '00:00', end: '01:00' }];
  const calendar = await apiCalendar(head, {
    name: 'Stats one hour a day',
    timezone: 'UTC',
    hours: { sun: hour, mon: hour, tue: hour, wed: hour, thu: hour, fri: hour, sat: hour },
  });
  const businessPolicy = await apiPolicy(head, {
    name: 'Stats business',
    targets: { P3: { first_response_min: 600, resolution_min: 6000, calendar: 'business' } },
    businessCalendarId: calendar.id,
  });
  const wall = wallPolicy.id;
  const business = businessPolicy.id;

  // Open, first response still due.
  await ticket('breached', {
    status: 'new',
    policyId: wall,
    firstDue: minutes(-5),
    assigneeId: agent.userId,
    queueId: queueA,
  });
  await ticket('soon', {
    status: 'open',
    policyId: wall,
    firstDue: minutes(20),
    assigneeId: agent.userId,
    queueId: queueA,
    priority: 'P1',
  });
  await ticket('fractionRisk', {
    // 200 of 1000 minutes left = 20 %.
    status: 'triage',
    policyId: wall,
    firstDue: minutes(200),
    assigneeId: otherAgent.userId,
    queueId: queueB,
  });
  await ticket('fine', {
    status: 'open',
    policyId: wall,
    firstDue: minutes(900),
    assigneeId: otherAgent.userId,
    queueId: queueB,
  });
  // Answered: the resolution target is the running one.
  await ticket('resolutionRisk', {
    status: 'waiting_on_dev',
    policyId: wall,
    firstRespondedAt: minutes(-60),
    firstDue: minutes(-30),
    resolutionDue: minutes(100),
    queueId: null,
  });
  await ticket('paused', {
    status: 'waiting_on_customer',
    policyId: wall,
    firstDue: minutes(-500),
    pausedAt: minutes(-100),
    assigneeId: agent.userId,
  });
  // Business time: due in two days = 120 business minutes of a 600 minute target = 20 %.
  await ticket('businessRisk', {
    status: 'open',
    policyId: business,
    firstDue: minutes(2 * 24 * 60),
    priority: 'P3',
    queueId: queueA,
  });
  // Due in four days = 240 business minutes = 40 %.
  await ticket('businessFine', {
    status: 'open',
    policyId: business,
    firstDue: minutes(4 * 24 * 60),
    queueId: queueA,
  });
  // No running target: finished, and open but without a due date.
  await ticket('closed', {
    status: 'closed',
    policyId: wall,
    firstDue: minutes(-5000),
    firstRespondedAt: minutes(-6000),
    resolutionDue: minutes(-4000),
  });
  await ticket('noSla', { status: 'open', policyId: null, firstDue: null, resolutionDue: null });
});

afterAll(async () => {
  await h.close();
});

describe('GET /v1/tickets/stats', () => {
  it('answers a staff member who gives no filter at all (the assistant asks like this)', async () => {
    const response = await lead.client.get<TicketStats>('/v1/tickets/stats');
    expect(response.status).toBe(200);
    expect(response.body.total.count).toBeGreaterThanOrEqual(10);
  });

  it('counts by status, queue, assignee, priority and SLA state in one answer', async () => {
    const response = await stats(lead);
    expect(response.status).toBe(200);
    const body = response.body;

    expect(body.total).toEqual({
      count: 10,
      open: 9,
      // soon + fractionRisk + resolutionRisk + businessRisk
      sla: { ok: 2, at_risk: 4, breached: 1, paused: 1 },
    });

    const byStatus = Object.fromEntries(body.byStatus.map((row) => [row.status, row.count]));
    expect(byStatus).toEqual({
      new: 1,
      triage: 1,
      open: 5,
      waiting_on_customer: 1,
      waiting_on_dev: 1,
      closed: 1,
    });
    // Workflow order, not alphabetical.
    expect(body.byStatus.map((row) => row.status)).toEqual([
      'new',
      'triage',
      'open',
      'waiting_on_customer',
      'waiting_on_dev',
      'closed',
    ]);
    expect(body.byStatus.find((row) => row.status === 'closed')).toMatchObject({
      count: 1,
      open: 0,
      sla: { ok: 0, at_risk: 0, breached: 0, paused: 0 },
    });

    const mine = body.byAssignee.find((row) => row.assigneeId === agent.userId);
    expect(mine).toMatchObject({
      count: 3,
      open: 3,
      sla: { ok: 0, at_risk: 1, breached: 1, paused: 1 },
    });
    const theirs = body.byAssignee.find((row) => row.assigneeId === otherAgent.userId);
    expect(theirs).toMatchObject({ count: 2, sla: { ok: 1, at_risk: 1, breached: 0, paused: 0 } });
    const unassigned = body.byAssignee.find((row) => row.assigneeId === null);
    expect(unassigned).toMatchObject({ count: 5, open: 4 });
    // Largest group first.
    expect(body.byAssignee[0]?.assigneeId).toBe(null);

    expect(body.byQueue.find((row) => row.queueId === queueA)).toMatchObject({
      count: 4,
      sla: { ok: 1, at_risk: 2, breached: 1, paused: 0 },
    });
    expect(body.byQueue.find((row) => row.queueId === queueB)).toMatchObject({ count: 2 });
    expect(body.byQueue.find((row) => row.queueId === null)).toMatchObject({ count: 4 });

    expect(body.byPriority.map((row) => [row.priority, row.count])).toEqual([
      ['P1', 1],
      ['P3', 9],
    ]);
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
  });

  it('measures "at risk" in business time, not wall clock', async () => {
    const at = await idsOf('slaState=at_risk');
    expect(at).toContain(t.businessRisk);
    expect(at).not.toContain(t.businessFine);
  });

  it('takes the filters of the list: status, queue, assignee and slaState', async () => {
    const open = await stats(lead, 'status=new,triage,open,waiting_on_customer,waiting_on_dev');
    expect(open.body.total.count).toBe(9);
    expect(open.body.byStatus.some((row) => row.status === 'closed')).toBe(false);

    const unassigned = await stats(lead, 'assignee=unassigned');
    expect(unassigned.body.total.count).toBe(5);
    expect(unassigned.body.byAssignee).toHaveLength(1);

    const inQueue = await stats(lead, `queueId=${queueB}`);
    expect(inQueue.body.total.count).toBe(2);

    const risky = await stats(lead, 'slaState=at_risk');
    expect(risky.body.total.count).toBe(4);
    expect(risky.body.total.sla).toEqual({ ok: 0, at_risk: 4, breached: 0, paused: 0 });

    const mineOnly = await stats(agent, 'assignee=me&slaState=breached,paused');
    expect(mineOnly.body.total.count).toBe(2);
  });

  it('returns zero, not an error, when nothing matches', async () => {
    const response = await stats(lead, 'priority=P4');
    expect(response.status).toBe(200);
    expect(response.body.total).toEqual({
      count: 0,
      open: 0,
      sla: { ok: 0, at_risk: 0, breached: 0, paused: 0 },
    });
    expect(response.body.byStatus).toEqual([]);
  });

  it('is for staff: a client is refused, and nobody signed in gets 401', async () => {
    expect((await stats(client)).status).toBe(403);
    expect((await h.client().get('/v1/tickets/stats')).status).toBe(401);
  });

  it('rejects an unknown SLA state or status with 400', async () => {
    expect((await stats(lead, 'slaState=nearly')).status).toBe(400);
    expect((await stats(lead, 'status=lost')).status).toBe(400);
  });

  it('is not shadowed by the ticket route: a real ticket reference still works', async () => {
    const one = await lead.client.get<{ id: string }>(`/v1/tickets/${t.soon ?? ''}`);
    expect(one.status).toBe(200);
    expect(one.body.id).toBe(t.soon);
  });
});

describe('GET /v1/tickets?slaState=', () => {
  it('lists exactly the tickets in each state, the same ones the counts show', async () => {
    expect(await idsOf('slaState=breached')).toEqual(idsFor('breached'));
    expect(await idsOf('slaState=paused')).toEqual(idsFor('paused'));
    expect(await idsOf('slaState=at_risk')).toEqual(
      idsFor('soon', 'fractionRisk', 'resolutionRisk', 'businessRisk'),
    );
    expect(await idsOf('slaState=ok')).toEqual(idsFor('fine', 'businessFine'));
    expect(await idsOf('slaState=at_risk,breached')).toEqual(
      idsFor('soon', 'fractionRisk', 'resolutionRisk', 'businessRisk', 'breached'),
    );
  });

  it('combines with the other filters', async () => {
    expect(await idsOf(`slaState=at_risk&assignee=${agent.userId}`)).toEqual(idsFor('soon'));
    expect(await idsOf(`slaState=at_risk&queueId=${queueA}`)).toEqual(
      idsFor('soon', 'businessRisk'),
    );
    expect(await idsOf('slaState=breached&priority=P1')).toEqual([]);
  });

  it('leaves out tickets with no running target, whatever the state asked for', async () => {
    const all = [
      ...(await idsOf('slaState=ok')),
      ...(await idsOf('slaState=at_risk')),
      ...(await idsOf('slaState=breached')),
      ...(await idsOf('slaState=paused')),
    ];
    expect(all).not.toContain(t.closed);
    expect(all).not.toContain(t.noSla);
  });

  it('is ignored for a client, like the other staff filters', async () => {
    const response = await client.client.get<Page<{ id: string }>>('/v1/tickets?slaState=breached');
    expect(response.status).toBe(200);
    expect(response.body.items.length).toBeGreaterThanOrEqual(10);
  });

  it('rejects an unknown state with 400', async () => {
    expect((await lead.client.get('/v1/tickets?slaState=late')).status).toBe(400);
  });
});

describe('GET /v1/tickets sorts created_asc and sla_due_asc', () => {
  async function walk(sort: string, limit: number): Promise<TicketSummary[]> {
    const items: TicketSummary[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const more: string = cursor === null ? '' : `&cursor=${cursor}`;
      const response = await lead.client.get<Page<TicketSummary>>(
        `/v1/tickets?orgId=${orgId}&sort=${sort}&limit=${String(limit)}${more}`,
      );
      expect(response.status).toBe(200);
      items.push(...response.body.items);
      cursor = response.body.nextCursor;
      if (cursor === null) break;
    }
    return items;
  }

  it('created_asc is oldest first and pages without skipping or repeating', async () => {
    const all = await walk('created_asc', 3);
    expect(all).toHaveLength(10);
    expect(new Set(all.map((item) => item.id)).size).toBe(10);
    const times = all.map((item) => Date.parse(item.createdAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const newest = await walk('created_desc', 4);
    expect(newest.map((item) => item.id)).toEqual(all.map((item) => item.id).reverse());
  });

  it('sla_due_asc orders by the running target, tickets without one last', async () => {
    const all = await walk('sla_due_asc', 4);
    expect(all).toHaveLength(10);
    const ids = all.map((item) => item.id);
    const position = (name: string): number => ids.indexOf(t[name] ?? '');
    // Running due: paused -500 (still its first-response date), breached -5, soon +20, resolutionRisk +100,
    // fractionRisk +200, fine +900, businessRisk +2 days, businessFine +4 days.
    expect(position('paused')).toBeLessThan(position('breached'));
    expect(position('breached')).toBeLessThan(position('soon'));
    expect(position('soon')).toBeLessThan(position('resolutionRisk'));
    expect(position('resolutionRisk')).toBeLessThan(position('fractionRisk'));
    expect(position('fractionRisk')).toBeLessThan(position('fine'));
    expect(position('fine')).toBeLessThan(position('businessRisk'));
    expect(position('businessRisk')).toBeLessThan(position('businessFine'));
    // The two with no running target come after all eight.
    expect(position('closed')).toBeGreaterThan(position('businessFine'));
    expect(position('noSla')).toBeGreaterThan(position('businessFine'));
    expect(new Set(ids).size).toBe(10);
  });

  it('a client asking for sla_due_asc gets newest first, not an error', async () => {
    const response = await client.client.get<Page<{ createdAt: string }>>(
      '/v1/tickets?sort=sla_due_asc',
    );
    expect(response.status).toBe(200);
    const times = response.body.items.map((item) => Date.parse(item.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});
