import {
  DEFAULT_ROLE_PERMISSIONS,
  shiftWindow,
  type Permission,
  type AssigneeList,
  type Handoff,
  type HandoffItem,
  type IncomingHandoffs,
  type CurrentHandoff,
  type RosterList,
  type RosterEntry,
  type ShiftBrief,
  type AckResult,
  type ShiftDefinition,
  type ShiftDefinitionList,
  type ShiftNote,
  type ShiftNotePage,
  type ShiftOverview,
  type ShiftSession,
  type ShiftStatus,
  type TeamQueue,
  type TicketDetail,
  type ClockOutResult,
} from '@watchtower/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { SlaRemaining } from '../tickets/sla-remaining.js';
import { startHarness, uniqueEmail, type Harness } from '../testing/harness.js';
import {
  apiCalendar,
  apiOrg,
  apiPolicy,
  apiQueue,
  fileTicket,
  signIn,
  type ApiErrorBody,
  type Persona,
} from '../testing/ticketing.js';
import { SHIFT_NOW } from './shift-core.js';

// T-111: shifts, roster, clock in/out, the AC-7 handoff gate, acknowledgment, notes, the brief,
// the assignee list and the SLA time left. Postgres, Redis and the real application module.

let h: Harness;
let head: Persona;
let lead: Persona;
let orgId: string;
/** When set, the shift features read this instant instead of the system clock. */
let fakeNow: Date | null = null;

const owner = () => h.db.owner.pool;

beforeAll(async () => {
  h = await startHarness({
    overrides: [{ token: SHIFT_NOW, value: () => fakeNow ?? new Date() }],
  });
  head = await signIn(h, 'head', undefined, 'Head One');
  lead = await signIn(h, 'lead', undefined, 'Lead One');
  const calendar = await apiCalendar(head, {
    name: 'Bangkok office hours',
    timezone: 'Asia/Bangkok',
    isDefault: true,
  });
  await apiPolicy(head, {
    name: 'Gold',
    tier: 'gold',
    businessCalendarId: calendar.id,
    targets: {
      P1: { first_response_min: 15, resolution_min: 240, calendar: '24x7' },
      P2: { first_response_min: 60, resolution_min: 480, calendar: 'business' },
      P3: { first_response_min: 240, resolution_min: 2400, calendar: 'business' },
    },
  });
  orgId = (await apiOrg(lead, { name: 'Acme Shifts', tier: 'gold' })).id;
});
afterEach(() => {
  fakeNow = null;
});
afterAll(async () => {
  await h.close();
});

// --- helpers ---

const agentNamed = (name: string) => signIn(h, 'agent', undefined, name);

async function clockIn(who: Persona, body: Record<string, unknown> = {}): Promise<ShiftSession> {
  const response = await who.client.post<ShiftSession>('/v1/shifts/clock-in', body);
  if (response.status !== 200) {
    throw new Error(`clock in failed: ${String(response.status)} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

async function assigned(priority: 'P1' | 'P2' | 'P3', who: Persona): Promise<TicketDetail> {
  return fileTicket(lead, orgId, { priority, assigneeId: who.userId });
}

async function prefill(who: Persona): Promise<Handoff> {
  const response = await who.client.post<Handoff>('/v1/handoffs/prefill');
  if (response.status !== 200) {
    throw new Error(`prefill failed: ${String(response.status)} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

/** Saves the draft with the next action filled in for every ticket item, and confirms. */
async function confirmHandoff(
  who: Persona,
  options: { nextAction?: string; toUserId?: string; message?: string } = {},
): Promise<Handoff> {
  const draft = await prefill(who);
  const saved = await who.client.put<Handoff>(`/v1/handoffs/${draft.id}`, {
    ...(options.toUserId === undefined ? {} : { toUserId: options.toUserId }),
    ...(options.message === undefined ? {} : { messageForNext: options.message }),
    items: draft.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      nextAction: item.kind === 'pending' ? (options.nextAction ?? 'Wait for the customer') : null,
    })),
  });
  expect(saved.status).toBe(200);
  const confirmed = await who.client.post<Handoff>(`/v1/handoffs/${draft.id}/confirm`);
  expect(confirmed.status).toBe(200);
  return confirmed.body;
}

async function auditRows(action: string, actorId?: string) {
  const result = await owner().query<{
    outcome: string;
    target_id: string | null;
    metadata: Record<string, unknown>;
    after: Record<string, unknown> | null;
  }>(
    `SELECT outcome, target_id, metadata, after FROM audit_log
      WHERE action = $1 AND ($2::text IS NULL OR actor_id::text = $2) ORDER BY created_at`,
    [action, actorId ?? null],
  );
  return result.rows;
}

interface GateBody extends ApiErrorBody {
  noConfirmedHandoff: boolean;
  blockers: { ticketId: string; key: string; priority: string; reason: string; cause?: string }[];
}

// --- who may call what ---

describe('RBAC: every route needs its permission, and a client or a stranger gets nothing', () => {
  it('turns away someone who is not signed in', async () => {
    const stranger = h.client();
    const routes: [string, string][] = [
      ['GET', '/v1/shifts/definitions'],
      ['GET', '/v1/roster?from=2026-11-01&to=2026-11-02'],
      ['GET', '/v1/shifts/status'],
      ['POST', '/v1/shifts/clock-in'],
      ['POST', '/v1/shifts/clock-out'],
      ['GET', '/v1/shifts/overview'],
      ['GET', '/v1/shifts/brief'],
      ['GET', '/v1/assignees'],
      ['GET', '/v1/handoffs/current'],
      ['GET', '/v1/handoffs/incoming'],
      ['GET', '/v1/shift-notes'],
    ];
    for (const [method, path] of routes) {
      const response = await stranger.request(method, path, { csrf: false });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it('turns away a client on every shift route', async () => {
    const orgForClient = await apiOrg(lead, { name: `Client org ${uniqueEmail('c')}` });
    const client = await signIn(h, 'client', orgForClient.id);
    const id = '00000000-0000-4000-8000-000000000001';
    const routes: [string, string, unknown?][] = [
      ['GET', '/v1/shifts/definitions'],
      ['POST', '/v1/shifts/definitions', { name: 'X', startsAt: '01:00', endsAt: '02:00' }],
      ['PATCH', `/v1/shifts/definitions/${id}`, { name: 'Y' }],
      ['GET', '/v1/roster?from=2026-11-01&to=2026-11-02'],
      ['POST', '/v1/roster', { shiftId: id, userId: id, workDate: '2026-11-02' }],
      ['DELETE', `/v1/roster/${id}`],
      ['GET', '/v1/shifts/status'],
      ['POST', '/v1/shifts/clock-in', {}],
      ['POST', '/v1/shifts/clock-out', {}],
      ['GET', '/v1/shifts/overview'],
      ['GET', '/v1/shifts/brief'],
      ['POST', '/v1/shifts/brief/read'],
      ['GET', '/v1/assignees'],
      ['GET', '/v1/handoffs/current'],
      ['POST', '/v1/handoffs/prefill'],
      ['GET', '/v1/handoffs/incoming'],
      ['PUT', `/v1/handoffs/${id}`, { items: [] }],
      ['POST', `/v1/handoffs/${id}/confirm`],
      ['POST', `/v1/handoffs/${id}/reopen`],
      ['POST', `/v1/handoffs/items/${id}/ack`, { decision: 'accept' }],
      ['GET', '/v1/shift-notes'],
      ['POST', '/v1/shift-notes', { audience: 'next_shift', body: 'hi' }],
      ['POST', `/v1/shift-notes/${id}/read`],
    ];
    for (const [method, path, body] of routes) {
      const response = await client.client.request(method, path, {
        ...(body === undefined ? {} : { body }),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });

  it('lets an agent read and clock but not manage: definitions, roster and the overview are for lead and head', async () => {
    const agent = await agentNamed('Plain Agent');
    const id = '00000000-0000-4000-8000-000000000001';
    expect((await agent.client.get('/v1/shifts/definitions')).status).toBe(200);
    expect((await agent.client.get('/v1/roster?from=2026-11-01&to=2026-11-02')).status).toBe(200);
    expect((await agent.client.get('/v1/shifts/status')).status).toBe(200);
    expect((await agent.client.get('/v1/assignees')).status).toBe(200);
    expect((await agent.client.get('/v1/shift-notes')).status).toBe(200);

    const denied: [string, string, unknown?][] = [
      ['POST', '/v1/shifts/definitions', { name: 'X', startsAt: '01:00', endsAt: '02:00' }],
      ['PATCH', `/v1/shifts/definitions/${id}`, { name: 'Y' }],
      ['POST', '/v1/roster', { shiftId: id, userId: agent.userId, workDate: '2026-11-02' }],
      ['DELETE', `/v1/roster/${id}`],
      ['GET', '/v1/shifts/overview'],
    ];
    for (const [method, path, body] of denied) {
      const response = await agent.client.request(method, path, {
        ...(body === undefined ? {} : { body }),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
    // Overriding a clock out, and clocking someone else out, are lead and head only.
    await clockIn(agent);
    const override = await agent.client.post('/v1/shifts/clock-out', {
      override: { reason: 'I would like to leave now' },
    });
    expect(override.status).toBe(403);
    const other = await agent.client.post('/v1/shifts/clock-out', { userId: lead.userId });
    expect(other.status).toBe(403);
  });

  it('lets a lead and a head manage the roster and see the overview', async () => {
    for (const who of [lead, head]) {
      expect((await who.client.get('/v1/shifts/overview')).status).toBe(200);
    }
  });
});

// --- definitions and roster (R-7.1) ---

describe('shift definitions and the roster', () => {
  it('creates, edits and retires a shift, and refuses a duplicate name', async () => {
    const created = await lead.client.post<ShiftDefinition>('/v1/shifts/definitions', {
      name: 'Early',
      startsAt: '06:00',
      endsAt: '14:00',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Early',
      overnight: false,
      onCall: false,
      active: true,
    });
    expect(
      (
        await lead.client.post('/v1/shifts/definitions', {
          name: 'early',
          startsAt: '01:00',
          endsAt: '02:00',
        })
      ).status,
    ).toBe(409);

    const night = await lead.client.post<ShiftDefinition>('/v1/shifts/definitions', {
      name: 'Late night on-call',
      startsAt: '23:00',
      endsAt: '07:00',
      onCall: true,
    });
    expect(night.body).toMatchObject({ overnight: true, onCall: true });

    const edited = await lead.client.patch<ShiftDefinition>(
      `/v1/shifts/definitions/${created.body.id}`,
      {
        endsAt: '15:00',
      },
    );
    expect(edited.body.endsAt).toBe('15:00');
    expect(
      (await lead.client.patch(`/v1/shifts/definitions/${created.body.id}`, { endsAt: '06:00' }))
        .status,
    ).toBe(400);
    const retired = await lead.client.patch<ShiftDefinition>(
      `/v1/shifts/definitions/${created.body.id}`,
      {
        active: false,
      },
    );
    expect(retired.body.active).toBe(false);
    expect(
      (
        await lead.client.patch('/v1/shifts/definitions/00000000-0000-4000-8000-000000000001', {
          name: 'Z',
        })
      ).status,
    ).toBe(404);

    const list = await lead.client.get<ShiftDefinitionList>('/v1/shifts/definitions');
    expect(list.body.timezone).toBe('Asia/Bangkok'); // the default business calendar's, not the server's
    expect(list.body.definitions.map((d) => d.name)).toEqual(
      expect.arrayContaining(['Early', 'Late night on-call']),
    );

    const audited = await auditRows('shift.definition_create', lead.userId);
    expect(audited.length).toBeGreaterThanOrEqual(2);
    expect((await auditRows('shift.definition_update', lead.userId)).length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('puts people on shifts, shows each agent only their own schedule, and removes an entry', async () => {
    const day = (
      await lead.client.post<ShiftDefinition>('/v1/shifts/definitions', {
        name: `Roster day ${uniqueEmail('d')}`,
        startsAt: '08:00',
        endsAt: '17:00',
      })
    ).body;
    const a = await agentNamed('Roster A');
    const b = await agentNamed('Roster B');
    const put = (userId: string) =>
      lead.client.post<RosterEntry>('/v1/roster', {
        shiftId: day.id,
        userId,
        workDate: '2026-12-01',
      });
    const first = await put(a.userId);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      workDate: '2026-12-01',
      userId: a.userId,
      shiftName: day.name,
    });
    expect(first.body.startsAt).toBe('2026-12-01T01:00:00.000Z'); // 08:00 in Bangkok
    expect(first.body.endsAt).toBe('2026-12-01T10:00:00.000Z');
    const again = await put(a.userId);
    expect(again.body.id).toBe(first.body.id); // idempotent
    await put(b.userId);

    const query = '/v1/roster?from=2026-12-01&to=2026-12-01';
    const asLead = await lead.client.get<RosterList>(query);
    expect(
      asLead.body.entries
        .filter((e) => e.shiftId === day.id)
        .map((e) => e.userId)
        .sort(),
    ).toEqual([a.userId, b.userId].sort());
    const asA = await a.client.get<RosterList>(query);
    expect(asA.body.entries.map((e) => e.userId)).toEqual([a.userId]);
    // An agent cannot look at someone else by asking for them.
    const sneaky = await a.client.get<RosterList>(`${query}&userId=${b.userId}`);
    expect(sneaky.body.entries.map((e) => e.userId)).toEqual([a.userId]);

    expect((await lead.client.delete(`/v1/roster/${first.body.id}`)).status).toBe(204);
    expect((await lead.client.delete(`/v1/roster/${first.body.id}`)).status).toBe(404);
    expect((await auditRows('roster.assign', lead.userId)).length).toBeGreaterThanOrEqual(3);
    // One removal worked; the second request (404) is audited as a failure.
    expect((await auditRows('roster.remove', lead.userId)).map((row) => row.outcome)).toEqual([
      'success',
      'failure',
    ]);
  });

  it('refuses a client, a disabled person, an inactive shift and a range over 62 days', async () => {
    const shift = (
      await lead.client.post<ShiftDefinition>('/v1/shifts/definitions', {
        name: `Odd ${uniqueEmail('o')}`,
        startsAt: '10:00',
        endsAt: '11:00',
      })
    ).body;
    const gone = await agentNamed('Gone');
    await head.client.patch(`/v1/users/${gone.userId}`, { status: 'disabled' });
    const clientOrg = await apiOrg(lead, { name: `Roster client ${uniqueEmail('c')}` });
    const client = await signIn(h, 'client', clientOrg.id);
    const body = (userId: string) => ({ shiftId: shift.id, userId, workDate: '2026-12-02' });
    expect((await lead.client.post('/v1/roster', body(gone.userId))).status).toBe(400);
    expect((await lead.client.post('/v1/roster', body(client.userId))).status).toBe(400);
    await lead.client.patch(`/v1/shifts/definitions/${shift.id}`, { active: false });
    const live = await agentNamed('Live');
    expect((await lead.client.post('/v1/roster', body(live.userId))).status).toBe(400);
    expect((await lead.client.get('/v1/roster?from=2026-01-01&to=2026-12-31')).status).toBe(400);
  });

  it('answers 400, not 500, for a date that is not on the calendar', async () => {
    const shift = (
      await lead.client.post<ShiftDefinition>('/v1/shifts/definitions', {
        name: `Calendar ${uniqueEmail('o')}`,
        startsAt: '10:00',
        endsAt: '11:00',
      })
    ).body;
    const person = await agentNamed('Feb 31');
    for (const workDate of ['2026-02-31', '2026-04-31', '2027-02-29']) {
      const created = await lead.client.post('/v1/roster', {
        shiftId: shift.id,
        userId: person.userId,
        workDate,
      });
      expect(created.status, workDate).toBe(400);
    }
    expect((await lead.client.get('/v1/roster?from=2026-02-31&to=2026-03-02')).status).toBe(400);
    expect((await lead.client.get('/v1/roster?from=2026-03-01&to=2026-06-31')).status).toBe(400);
  });
});

// --- clock in (R-7.3) ---

describe('clock in', () => {
  it('attaches the rostered shift, counts lateness, and reads the time in the calendar zone', async () => {
    const day = (
      await lead.client.post<ShiftDefinition>('/v1/shifts/definitions', {
        name: `Clock day ${uniqueEmail('d')}`,
        startsAt: '08:00',
        endsAt: '17:00',
      })
    ).body;
    const a = await agentNamed('Late Agent');
    const onTime = await agentNamed('Punctual Agent');
    const early = await agentNamed('Early Agent');
    const none = await agentNamed('Unrostered Agent');
    for (const who of [a, onTime, early]) {
      await lead.client.post('/v1/roster', {
        shiftId: day.id,
        userId: who.userId,
        workDate: '2026-11-02',
      });
    }

    fakeNow = new Date('2026-11-02T01:12:30Z'); // 08:12 in Bangkok
    const late = await clockIn(a, { device: 'Firefox on Linux', locationConsent: true });
    expect(late).toMatchObject({
      onRoster: true,
      shiftName: day.name,
      lateMinutes: 12,
      late: true,
      device: 'Firefox on Linux',
      locationConsent: true,
      scheduledStart: '2026-11-02T01:00:00.000Z',
      scheduledEnd: '2026-11-02T10:00:00.000Z',
    });

    fakeNow = new Date('2026-11-02T01:03:00Z'); // 3 minutes late is inside the grace period
    const punctual = await clockIn(onTime);
    expect(punctual).toMatchObject({ lateMinutes: 3, late: false, locationConsent: false });

    fakeNow = new Date('2026-11-02T00:20:00Z'); // 07:20, 40 minutes before the start
    expect(await clockIn(early)).toMatchObject({ onRoster: true, lateMinutes: 0, late: false });

    fakeNow = new Date('2026-11-02T01:30:00Z');
    const anyway = await clockIn(none);
    expect(anyway).toMatchObject({
      onRoster: false,
      shiftId: null,
      lateMinutes: 0,
      scheduledStart: null,
    });

    const audited = await auditRows('shift.clock_in', a.userId);
    expect(audited).toHaveLength(1);
    expect(audited[0]?.metadata).toMatchObject({ onRoster: true, lateMinutes: 12, late: true });
  });

  it('refuses a second clock in, and a clock out when not clocked in', async () => {
    const a = await agentNamed('Twice');
    await clockIn(a);
    const again = await a.client.post<ApiErrorBody>('/v1/shifts/clock-in', {});
    expect(again.status).toBe(409);
    const idle = await agentNamed('Idle');
    expect((await idle.client.post('/v1/shifts/clock-out', {})).status).toBe(409);
  });

  it('shows the shift chip state: off shift, then on shift with the time left', async () => {
    const day = (
      await lead.client.post<ShiftDefinition>('/v1/shifts/definitions', {
        name: `Chip day ${uniqueEmail('d')}`,
        startsAt: '08:00',
        endsAt: '17:00',
      })
    ).body;
    const a = await agentNamed('Chip Agent');
    await lead.client.post('/v1/roster', {
      shiftId: day.id,
      userId: a.userId,
      workDate: '2026-11-03',
    });
    fakeNow = new Date('2026-11-03T01:00:00Z');
    const off = await a.client.get<ShiftStatus>('/v1/shifts/status');
    expect(off.body.session).toBeNull();
    expect(off.body.clockOutBlocked).toBeNull();
    expect(off.body.roster.map((entry) => entry.shiftName)).toContain(day.name);
    expect(off.body.timezone).toBe('Asia/Bangkok');

    await clockIn(a);
    fakeNow = new Date('2026-11-03T06:48:00Z'); // 13:48 local: 3h12m before 17:00
    const on = await a.client.get<ShiftStatus>('/v1/shifts/status');
    expect(on.body.session?.shiftName).toBe(day.name);
    expect(on.body.minutesToEnd).toBe(192);
    fakeNow = new Date('2026-11-03T10:10:00Z'); // 10 minutes after the end
    const over = await a.client.get<ShiftStatus>('/v1/shifts/status');
    expect(over.body.minutesToEnd).toBe(-10);
  });

  it('reports the lead who is on shift, and a rostered person who never showed up', async () => {
    const day = (
      await lead.client.post<ShiftDefinition>('/v1/shifts/definitions', {
        name: `Overview day ${uniqueEmail('d')}`,
        startsAt: '08:00',
        endsAt: '17:00',
      })
    ).body;
    const here = await agentNamed('Here');
    const absent = await agentNamed('Absent');
    for (const who of [here, absent]) {
      await lead.client.post('/v1/roster', {
        shiftId: day.id,
        userId: who.userId,
        workDate: '2026-11-04',
      });
    }
    fakeNow = new Date('2026-11-04T01:00:00Z');
    await clockIn(here);
    fakeNow = new Date('2026-11-04T01:20:00Z');
    const overview = await lead.client.get<ShiftOverview>('/v1/shifts/overview');
    expect(overview.body.onShift.map((s) => s.userId)).toContain(here.userId);
    const noShows = overview.body.noShows.filter((entry) => entry.shiftId === day.id);
    expect(noShows.map((entry) => entry.userId)).toEqual([absent.userId]);
    // Before the grace period has passed, nobody is a no-show yet.
    fakeNow = new Date('2026-11-04T01:03:00Z');
    const early = await lead.client.get<ShiftOverview>('/v1/shifts/overview');
    expect(early.body.noShows.filter((entry) => entry.shiftId === day.id)).toEqual([]);
  });
});

// --- the handoff gate (AC-7) ---

describe('AC-7: clock out is blocked until the handoff is complete', () => {
  it('refuses an open P1 ticket without a handoff entry, then lets the agent out once it has a next action', async () => {
    const agent = await agentNamed('Gate Agent');
    await clockIn(agent);
    const p1 = await assigned('P1', agent);

    const status = await agent.client.get<ShiftStatus>('/v1/shifts/status');
    expect(status.body.clockOutBlocked).toMatchObject({
      noConfirmedHandoff: true,
      blockers: [{ ticketId: p1.id, key: p1.key, priority: 'P1', reason: 'not_listed' }],
    });

    const refused = await agent.client.post<GateBody>('/v1/shifts/clock-out', {});
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'handoff_incomplete',
      noConfirmedHandoff: true,
      blockers: [{ ticketId: p1.id, reason: 'not_listed' }],
    });
    // Still clocked in.
    expect((await agent.client.get<ShiftStatus>('/v1/shifts/status')).body.session).not.toBeNull();

    // The prefill lists the ticket, but without a next action the handoff cannot be confirmed.
    const draft = await prefill(agent);
    const item = draft.items.find((entry) => entry.ticket?.id === p1.id);
    expect(item).toMatchObject({
      kind: 'pending',
      nextAction: null,
      source: 'prefill',
      carriedShifts: 0,
      requiresAck: true,
    });
    const noAction = await agent.client.post<GateBody>(`/v1/handoffs/${draft.id}/confirm`);
    expect(noAction.status).toBe(409);
    expect(noAction.body).toMatchObject({
      code: 'handoff_incomplete',
      blockers: [{ ticketId: p1.id, reason: 'missing_next_action' }],
    });
    expect((await agent.client.post(`/v1/shifts/clock-out`, {})).status).toBe(409);

    const saved = await agent.client.put<Handoff>(`/v1/handoffs/${draft.id}`, {
      notes: 'Customer is waiting for the vendor',
      items: [
        {
          id: item?.id,
          kind: 'pending',
          title: item?.title,
          nextAction: 'Wait for the log file',
          dueAt: '2026-11-03T02:00:00Z',
        },
      ],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.items[0]).toMatchObject({
      nextAction: 'Wait for the log file',
      dueAt: '2026-11-03T02:00:00.000Z',
    });
    expect((await agent.client.post<Handoff>(`/v1/handoffs/${draft.id}/confirm`)).body.status).toBe(
      'confirmed',
    );

    const out = await agent.client.post<ClockOutResult>('/v1/shifts/clock-out', {});
    expect(out.status).toBe(200);
    expect(out.body.overridden).toBe(false);
    expect(out.body.session.clockedOutAt).not.toBeNull();

    // The refused attempts and the successful one are on the audit log.
    const rows = await auditRows('shift.clock_out', agent.userId);
    expect(rows.map((row) => row.outcome)).toEqual(['failure', 'failure', 'success']);
  });

  it('a person with nothing assigned still has to confirm a handoff before clocking out', async () => {
    const agent = await agentNamed('Empty Handed');
    await clockIn(agent);
    const refused = await agent.client.post<GateBody>('/v1/shifts/clock-out', {});
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ noConfirmedHandoff: true, blockers: [] });
    await confirmHandoff(agent);
    expect((await agent.client.post('/v1/shifts/clock-out', {})).status).toBe(200);
  });

  it('checks again at clock out: a P1 ticket assigned after the handoff was confirmed blocks it', async () => {
    const agent = await agentNamed('Late Arrival');
    await clockIn(agent);
    await confirmHandoff(agent);
    const late = await assigned('P1', agent);
    const refused = await agent.client.post<GateBody>('/v1/shifts/clock-out', {});
    expect(refused.status).toBe(409);
    expect(refused.body.noConfirmedHandoff).toBe(false);
    expect(refused.body.blockers).toEqual([
      { ticketId: late.id, key: late.key, priority: 'P1', reason: 'not_listed' },
    ]);
    // Reopen, refill, confirm again, and out.
    const reopened = await agent.client.post<Handoff>(
      `/v1/handoffs/${(await agent.client.get<CurrentHandoff>('/v1/handoffs/current')).body.handoff?.id ?? ''}/reopen`,
    );
    expect(reopened.body.status).toBe('draft');
    await confirmHandoff(agent);
    expect((await agent.client.post('/v1/shifts/clock-out', {})).status).toBe(200);
  });

  it('does not require a P3 ticket to be listed, but does require a P2 one', async () => {
    const agent = await agentNamed('Priorities');
    await clockIn(agent);
    await assigned('P3', agent);
    await confirmHandoff(agent);
    expect((await agent.client.post('/v1/shifts/clock-out', {})).status).toBe(200);

    const second = await agentNamed('Priorities Two');
    await clockIn(second);
    const p2 = await assigned('P2', second);
    const refused = await second.client.post<GateBody>('/v1/shifts/clock-out', {});
    expect(refused.body.blockers).toEqual([
      expect.objectContaining({ ticketId: p2.id, priority: 'P2', reason: 'not_listed' }),
    ]);
  });

  it('lets a lead override with a reason, audits the reason and what was missing, and refuses a weak reason', async () => {
    const agent = await agentNamed('Overridden');
    await clockIn(agent);
    const p1 = await assigned('P1', agent);

    const weak = await lead.client.post('/v1/shifts/clock-out', {
      userId: agent.userId,
      override: { reason: 'short' },
    });
    expect(weak.status).toBe(400);
    // A lead who does not override is held to the same gate.
    const gated = await lead.client.post<GateBody>('/v1/shifts/clock-out', {
      userId: agent.userId,
    });
    expect(gated.status).toBe(409);
    expect(gated.body.code).toBe('handoff_incomplete');

    const reason = 'Agent went home sick; the lead takes the ticket';
    const out = await lead.client.post<ClockOutResult>('/v1/shifts/clock-out', {
      userId: agent.userId,
      override: { reason },
    });
    expect(out.status).toBe(200);
    expect(out.body.overridden).toBe(true);
    expect(out.body.session).toMatchObject({
      userId: agent.userId,
      override: { byId: lead.userId, byName: 'Lead One', reason },
    });
    expect(out.body.session.clockedOutAt).not.toBeNull();

    const rows = await auditRows('shift.clock_out_override', lead.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({
      userId: agent.userId,
      reason,
      noConfirmedHandoff: true,
      blockers: [{ ticketId: p1.id, reason: 'not_listed' }],
    });
  });

  it('an override on a handoff that is complete changes nothing and records no override', async () => {
    const agent = await agentNamed('Fine Anyway');
    await clockIn(agent);
    await confirmHandoff(agent);
    const out = await lead.client.post<ClockOutResult>('/v1/shifts/clock-out', {
      userId: agent.userId,
      override: { reason: 'Just in case, the lead is closing the shift' },
    });
    expect(out.status).toBe(200);
    expect(out.body.overridden).toBe(false);
    expect(out.body.session.override).toBeNull();
  });
});

// --- editing the handoff ---

describe('the handoff draft', () => {
  it('prefills once and again without duplicates, and counts the shifts a ticket has crossed', async () => {
    const first = await agentNamed('Carry One');
    await clockIn(first);
    const ticket = await assigned('P2', first);
    const draft = await prefill(first);
    expect(draft.items).toHaveLength(1);
    expect(draft.items[0]?.carriedShifts).toBe(0);
    expect((await prefill(first)).items).toHaveLength(1); // idempotent

    // A new ticket arrives; refreshing adds only it.
    const another = await assigned('P3', first);
    const refreshed = await prefill(first);
    expect(refreshed.items.map((item) => item.ticket?.id).sort()).toEqual(
      [ticket.id, another.id].sort(),
    );

    await confirmHandoff(first);
    await first.client.post('/v1/shifts/clock-out', {});

    // The next holder's handoff: the ticket has crossed one shift.
    await lead.client.post(`/v1/tickets/${ticket.id}/assign`, {
      assigneeId: (await agentNamed('Carry Two')).userId,
    });
    const holder = await agentNamed('Carry Holder');
    await clockIn(holder);
    await lead.client.post(`/v1/tickets/${ticket.id}/assign`, { assigneeId: holder.userId });
    const next = await prefill(holder);
    expect(next.items.find((item) => item.ticket?.id === ticket.id)?.carriedShifts).toBe(1);
  });

  it('keeps manual items for incidents and watch items, tracks edits to prefilled text, and removes what is left out', async () => {
    const agent = await agentNamed('Editor');
    await clockIn(agent);
    const ticket = await assigned('P3', agent);
    const draft = await prefill(agent);
    const item = draft.items[0];
    const saved = await agent.client.put<Handoff>(`/v1/handoffs/${draft.id}`, {
      notes: 'Quiet shift',
      messageForNext: 'Please check the nightly job',
      items: [
        { id: item?.id, kind: 'pending', title: 'Reworded title', nextAction: 'Call back' },
        {
          kind: 'incident',
          title: 'SEV2 error rate',
          nextAction: 'Confirm it is below 1%',
          severity: 'SEV2',
        },
        { kind: 'watch', title: 'Go-live tonight at 23:00' },
      ],
    });
    expect(saved.status).toBe(200);
    expect(
      saved.body.items.map((entry) => [entry.kind, entry.source, entry.edited, entry.requiresAck]),
    ).toEqual([
      ['pending', 'prefill', true, true],
      ['incident', 'manual', false, true],
      ['watch', 'manual', false, false],
    ]);
    expect(saved.body).toMatchObject({
      notes: 'Quiet shift',
      messageForNext: 'Please check the nightly job',
    });

    // Leaving an item out removes it; a pending item for a ticket can be added again by id.
    const slim = await agent.client.put<Handoff>(`/v1/handoffs/${draft.id}`, {
      items: [{ kind: 'watch', id: saved.body.items[2]?.id, title: 'Go-live tonight at 23:00' }],
    });
    expect(slim.body.items.map((entry) => entry.kind)).toEqual(['watch']);
    const readded = await agent.client.put<Handoff>(`/v1/handoffs/${draft.id}`, {
      items: [
        { kind: 'watch', id: slim.body.items[0]?.id, title: 'Go-live tonight at 23:00' },
        { kind: 'pending', ticketId: ticket.id, title: ticket.subject },
      ],
    });
    expect(readded.body.items.map((entry) => entry.kind)).toEqual(['watch', 'pending']);
    const duplicate = await agent.client.put(`/v1/handoffs/${draft.id}`, {
      items: [
        ...readded.body.items.map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          title: entry.title,
        })),
        { kind: 'pending', ticketId: ticket.id, title: 'again' },
      ],
    });
    expect(duplicate.status).toBe(409);

    // The person named as incoming must be staff and not the author.
    expect(
      (await agent.client.put(`/v1/handoffs/${draft.id}`, { toUserId: agent.userId, items: [] }))
        .status,
    ).toBe(400);
    const missing = '00000000-0000-4000-8000-000000000009';
    expect(
      (await agent.client.put(`/v1/handoffs/${draft.id}`, { toUserId: missing, items: [] })).status,
    ).toBe(400);
  });

  it('belongs to its author: nobody else can save, confirm or reopen it, and a confirmed one is locked', async () => {
    const agent = await agentNamed('Owner');
    const rival = await agentNamed('Rival');
    await clockIn(agent);
    await clockIn(rival);
    const draft = await prefill(agent);
    expect((await rival.client.put(`/v1/handoffs/${draft.id}`, { items: [] })).status).toBe(404);
    expect((await rival.client.post(`/v1/handoffs/${draft.id}/confirm`)).status).toBe(404);
    expect((await lead.client.post(`/v1/handoffs/${draft.id}/confirm`)).status).toBe(404);

    await confirmHandoff(agent);
    const locked = await agent.client.put<ApiErrorBody>(`/v1/handoffs/${draft.id}`, { items: [] });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('handoff_locked');
    expect((await agent.client.post<ApiErrorBody>(`/v1/handoffs/${draft.id}/reopen`)).status).toBe(
      200,
    );
    expect((await rival.client.post(`/v1/handoffs/${draft.id}/reopen`)).status).toBe(404);
    // Prefill needs an open session.
    const idle = await agentNamed('Idle Two');
    expect((await idle.client.post('/v1/handoffs/prefill')).status).toBe(409);
  });

  it('turns the message for the next shift into a note, and takes it back on reopen', async () => {
    const agent = await agentNamed('Messenger');
    const reader = await agentNamed('Reader');
    await clockIn(agent);
    const handoff = await confirmHandoff(agent, { message: 'The vendor calls at 21:00' });
    const inbox = await reader.client.get<ShiftNotePage>('/v1/shift-notes');
    expect(
      inbox.body.items.find((note) => note.body === 'The vendor calls at 21:00'),
    ).toMatchObject({
      audience: 'next_shift',
      author: { id: agent.userId },
    });
    await agent.client.post(`/v1/handoffs/${handoff.id}/reopen`);
    const after = await reader.client.get<ShiftNotePage>('/v1/shift-notes');
    expect(
      after.body.items.find((note) => note.body === 'The vendor calls at 21:00'),
    ).toBeUndefined();
  });
});

// --- acknowledgment (R-7.6) ---

describe('the incoming person acknowledges each item', () => {
  async function outgoingWithTicket(name: string, toUserId?: string, priority: 'P1' | 'P3' = 'P1') {
    const outgoing = await agentNamed(name);
    await clockIn(outgoing);
    const ticket = await assigned(priority, outgoing);
    const handoff = await confirmHandoff(outgoing, {
      nextAction: 'Wait for the log file',
      ...(toUserId === undefined ? {} : { toUserId }),
    });
    const item = handoff.items.find((entry) => entry.ticket?.id === ticket.id) as HandoffItem;
    expect((await outgoing.client.post('/v1/shifts/clock-out', {})).status).toBe(200);
    return { outgoing, ticket, handoff, item };
  }

  it('accept hands the ticket over, and the lead sees the unacknowledged count fall to zero', async () => {
    const { outgoing, ticket, handoff, item } = await outgoingWithTicket('Out One');
    const incoming = await agentNamed('In One');
    await clockIn(incoming);

    const before = await lead.client.get<ShiftOverview>('/v1/shifts/overview');
    const mine = before.body.unacknowledged.items.filter((entry) => entry.handoffId === handoff.id);
    expect(mine).toEqual([
      expect.objectContaining({ itemId: item.id, ticketKey: ticket.key, overdue: false }),
    ]);

    // The brief shows the handoff first; nothing in it needs an AI.
    const brief = await incoming.client.get<ShiftBrief>('/v1/shifts/brief');
    expect(brief.body.aiSummary).toBeNull();
    // (Other handoffs of this database are addressed to the same people, so look at this one.)
    expect(brief.body.handoff.total).toBeGreaterThanOrEqual(1);
    expect(brief.body.handoff.leadAlertAt).not.toBeNull();
    expect(brief.body.handoff.handoffs.find((entry) => entry.id === handoff.id)).toMatchObject({
      from: { id: outgoing.userId },
      items: [
        expect.objectContaining({
          id: item.id,
          nextAction: 'Wait for the log file',
          ackStatus: 'pending',
        }),
      ],
    });
    const status = await incoming.client.get<ShiftStatus>('/v1/shifts/status');
    expect(status.body.pendingAcks).toBeGreaterThanOrEqual(1);

    const accepted = await incoming.client.post<HandoffItem>(`/v1/handoffs/items/${item.id}/ack`, {
      decision: 'accept',
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ ackStatus: 'accepted', ackBy: { id: incoming.userId } });
    expect(accepted.body.ackAt).not.toBeNull();

    const moved = await incoming.client.get<TicketDetail>(`/v1/tickets/${ticket.id}`);
    expect(moved.body.assignee?.id).toBe(incoming.userId);

    const after = await lead.client.get<ShiftOverview>('/v1/shifts/overview');
    expect(
      after.body.unacknowledged.items.filter((entry) => entry.handoffId === handoff.id),
    ).toEqual([]);
    const again = await incoming.client.get<IncomingHandoffs>('/v1/handoffs/incoming');
    const answered = again.body.handoffs.find((entry) => entry.id === handoff.id);
    expect(answered?.items.map((entry) => entry.ackStatus)).toEqual(['accepted']);
    expect(again.body.acknowledged).toBeGreaterThanOrEqual(1);

    // The ack is on the audit log, once, and the ticket history has the change of hands.
    const rows = await auditRows('handoff.item_ack', incoming.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({ decision: 'accept', ticketId: ticket.id });
    expect((await auditRows('ticket.assign', incoming.userId)).length).toBe(1);

    // An accepted item cannot be answered again.
    const twice = await incoming.client.post<ApiErrorBody>(`/v1/handoffs/items/${item.id}/ack`, {
      decision: 'accept',
    });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('handoff_locked');
    // And the outgoing person can no longer reopen the handoff.
    expect((await outgoing.client.post(`/v1/handoffs/${handoff.id}/reopen`)).status).toBe(409);
  });

  it('reassign hands the ticket to the person named; a question writes to the outgoing person and keeps the item open', async () => {
    const reassign = await outgoingWithTicket('Out Two');
    const incoming = await agentNamed('In Two');
    const third = await agentNamed('Third');
    await clockIn(incoming);
    await clockIn(third); // a P1 can only go to someone who is on shift
    expect(
      (
        await incoming.client.post(`/v1/handoffs/items/${reassign.item.id}/ack`, {
          decision: 'reassign',
        })
      ).status,
    ).toBe(400);
    const done = await incoming.client.post<HandoffItem>(
      `/v1/handoffs/items/${reassign.item.id}/ack`,
      {
        decision: 'reassign',
        assigneeId: third.userId,
      },
    );
    expect(done.body.ackStatus).toBe('reassigned');
    expect(
      (await incoming.client.get<TicketDetail>(`/v1/tickets/${reassign.ticket.id}`)).body.assignee
        ?.id,
    ).toBe(third.userId);

    const ask = await outgoingWithTicket('Out Three');
    const question = await incoming.client.post<HandoffItem>(
      `/v1/handoffs/items/${ask.item.id}/ack`,
      {
        decision: 'question',
        note: 'Which log file are we waiting for?',
      },
    );
    expect(question.body).toMatchObject({
      ackStatus: 'question',
      ackNote: 'Which log file are we waiting for?',
    });
    // The ticket stays with the outgoing person until the question is settled.
    expect(
      (await incoming.client.get<TicketDetail>(`/v1/tickets/${ask.ticket.id}`)).body.assignee?.id,
    ).toBe(ask.outgoing.userId);
    const notes = await ask.outgoing.client.get<ShiftNotePage>('/v1/shift-notes');
    const note = notes.body.items.find((entry) => entry.body.includes('Which log file'));
    expect(note).toMatchObject({ audience: 'person', author: { id: incoming.userId } });
    expect(note?.body).toContain(ask.ticket.key);

    const overview = await lead.client.get<ShiftOverview>('/v1/shifts/overview');
    expect(overview.body.openQuestions).toBeGreaterThanOrEqual(1);
    // Once the answer is in, the question can be settled by accepting.
    const accepted = await incoming.client.post<HandoffItem>(
      `/v1/handoffs/items/${ask.item.id}/ack`,
      {
        decision: 'accept',
      },
    );
    expect(accepted.body.ackStatus).toBe('accepted');
  });

  it('does not take a ticket that someone else already took', async () => {
    const { ticket, item } = await outgoingWithTicket('Out Four');
    const taker = await agentNamed('Taker');
    const incoming = await agentNamed('In Four');
    await clockIn(incoming);
    await lead.client.post(`/v1/tickets/${ticket.id}/assign`, { assigneeId: taker.userId });
    const accepted = await incoming.client.post<HandoffItem>(`/v1/handoffs/items/${item.id}/ack`, {
      decision: 'accept',
    });
    expect(accepted.body.ackStatus).toBe('accepted');
    expect(
      (await incoming.client.get<TicketDetail>(`/v1/tickets/${ticket.id}`)).body.assignee?.id,
    ).toBe(taker.userId);
  });

  it('only the addressed person can answer: a named recipient, or anyone clocked in when it names nobody', async () => {
    const named = await agentNamed('Named');
    const bystander = await agentNamed('Bystander');
    await clockIn(bystander);
    const toNamed = await outgoingWithTicket('Out Five', named.userId);
    // The bystander is clocked in but the handoff names someone else.
    expect(
      (
        await bystander.client.post(`/v1/handoffs/items/${toNamed.item.id}/ack`, {
          decision: 'accept',
        })
      ).status,
    ).toBe(404);
    expect(
      (await bystander.client.get<IncomingHandoffs>('/v1/handoffs/incoming')).body.handoffs.map(
        (x) => x.id,
      ),
    ).not.toContain(toNamed.handoff.id);
    // The named person sees it without being clocked in; answering works.
    expect(
      (await named.client.get<IncomingHandoffs>('/v1/handoffs/incoming')).body.handoffs.map(
        (x) => x.id,
      ),
    ).toContain(toNamed.handoff.id);
    expect(
      (await named.client.post(`/v1/handoffs/items/${toNamed.item.id}/ack`, { decision: 'accept' }))
        .status,
    ).toBe(200);

    // A handoff that names nobody is for whoever is on shift: not for someone who is off, nor the author.
    const open = await outgoingWithTicket('Out Six');
    const offShift = await agentNamed('Off Shift');
    expect(
      (await offShift.client.get<IncomingHandoffs>('/v1/handoffs/incoming')).body.handoffs,
    ).toEqual([]);
    expect(
      (await offShift.client.post(`/v1/handoffs/items/${open.item.id}/ack`, { decision: 'accept' }))
        .status,
    ).toBe(404);
    expect(
      (
        await open.outgoing.client.post(`/v1/handoffs/items/${open.item.id}/ack`, {
          decision: 'accept',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await bystander.client.post(`/v1/handoffs/items/${open.item.id}/ack`, {
          decision: 'accept',
        })
      ).status,
    ).toBe(200);
    // A draft handoff is nobody's to acknowledge.
    const drafter = await agentNamed('Drafter');
    await clockIn(drafter);
    await assigned('P1', drafter);
    const draft = await prefill(drafter);
    expect(
      (
        await bystander.client.post(`/v1/handoffs/items/${draft.items[0]?.id ?? ''}/ack`, {
          decision: 'accept',
        })
      ).status,
    ).toBe(404);
  });

  it('flags an unacknowledged item to the lead 30 minutes after the handoff was confirmed', async () => {
    const outgoing = await agentNamed('Out Alert');
    fakeNow = new Date('2026-11-10T14:00:00Z');
    await clockIn(outgoing);
    await assigned('P1', outgoing);
    const handoff = await confirmHandoff(outgoing);
    fakeNow = new Date('2026-11-10T14:20:00Z');
    const early = await lead.client.get<ShiftOverview>('/v1/shifts/overview');
    expect(
      early.body.unacknowledged.items.find((entry) => entry.handoffId === handoff.id)?.overdue,
    ).toBe(false);
    fakeNow = new Date('2026-11-10T14:31:00Z');
    const late = await lead.client.get<ShiftOverview>('/v1/shifts/overview');
    expect(
      late.body.unacknowledged.items.find((entry) => entry.handoffId === handoff.id)?.overdue,
    ).toBe(true);
    expect(late.body.unacknowledged.overdue).toBeGreaterThanOrEqual(1);
  });

  it('stops offering a handoff after 36 hours', async () => {
    const outgoing = await agentNamed('Out Old');
    fakeNow = new Date('2026-11-12T00:00:00Z');
    await clockIn(outgoing);
    const handoff = await confirmHandoff(outgoing);
    const reader = await agentNamed('Reader Old');
    fakeNow = new Date('2026-11-13T10:00:00Z');
    await clockIn(reader); // (a clock in older than 16 hours would not count as on shift)
    fakeNow = new Date('2026-11-13T11:00:00Z'); // 35 hours later
    expect(
      (await reader.client.get<IncomingHandoffs>('/v1/handoffs/incoming')).body.handoffs.map(
        (x) => x.id,
      ),
    ).toContain(handoff.id);
    fakeNow = new Date('2026-11-13T13:00:00Z'); // 37 hours later
    expect(
      (await reader.client.get<IncomingHandoffs>('/v1/handoffs/incoming')).body.handoffs.map(
        (x) => x.id,
      ),
    ).not.toContain(handoff.id);
  });

  it('refuses a reassign back to the person who handed it over, even when they are clocked in again (T-125a)', async () => {
    const { outgoing, ticket, item } = await outgoingWithTicket('Out Back');
    const incoming = await agentNamed('In Back');
    await clockIn(incoming);
    await clockIn(outgoing); // a new session: "on shift" would let the reassign through
    const refused = await incoming.client.post<ApiErrorBody>(`/v1/handoffs/items/${item.id}/ack`, {
      decision: 'reassign',
      assigneeId: outgoing.userId,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain(ticket.key);
    const unchanged = await incoming.client.get<TicketDetail>(`/v1/tickets/${ticket.id}`);
    expect(unchanged.body.assignee?.id).toBe(outgoing.userId);
  });

  it('refuses a reassign of a P1 to someone off shift, and warns when a P3 goes to one', async () => {
    const urgent = await outgoingWithTicket('Out Off1');
    const incoming = await agentNamed('In Off1');
    await clockIn(incoming);
    const offShift = await agentNamed('Off Shift Target');
    const onShift = await agentNamed('On Shift Target');
    await clockIn(onShift);
    const ack = (item: HandoffItem, assigneeId: string) =>
      incoming.client.post<AckResult & ApiErrorBody>(`/v1/handoffs/items/${item.id}/ack`, {
        decision: 'reassign',
        assigneeId,
      });

    const refused = await ack(urgent.item, offShift.userId);
    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain(urgent.ticket.key);
    // Nothing happened: the item is still open and the ticket still sits with the outgoing person.
    const again = await incoming.client.get<IncomingHandoffs>('/v1/handoffs/incoming');
    const open = again.body.handoffs.find((entry) => entry.id === urgent.handoff.id);
    expect(open?.items[0]?.ackStatus).toBe('pending');
    expect(
      (await incoming.client.get<TicketDetail>(`/v1/tickets/${urgent.ticket.id}`)).body.assignee
        ?.id,
    ).toBe(urgent.outgoing.userId);

    const fine = await ack(urgent.item, onShift.userId);
    expect(fine.status).toBe(200);
    expect(fine.body.warnings).toEqual([]);

    const calm = await outgoingWithTicket('Out Off3', undefined, 'P3');
    const warned = await ack(calm.item, offShift.userId);
    expect(warned.status).toBe(200);
    expect(warned.body).toMatchObject({
      ackStatus: 'reassigned',
      warnings: ['assignee_off_shift'],
    });
    expect(
      (await incoming.client.get<TicketDetail>(`/v1/tickets/${calm.ticket.id}`)).body.assignee?.id,
    ).toBe(offShift.userId);
  });

  it('offers a handoff for 36 hours only, also when answering', async () => {
    fakeNow = new Date('2026-12-01T00:00:00Z');
    const old = await outgoingWithTicket('Out 36');
    const incoming = await agentNamed('In 36');
    fakeNow = new Date('2026-12-02T10:00:00Z');
    await clockIn(incoming);
    fakeNow = new Date('2026-12-02T13:00:00Z'); // 37 hours after the handoff was confirmed
    const late = await incoming.client.post(`/v1/handoffs/items/${old.item.id}/ack`, {
      decision: 'accept',
    });
    expect(late.status).toBe(404);
    // A handoff inside the window can still be answered by the same person.
    const inside = await outgoingWithTicket('Out 36 b');
    const answered = await incoming.client.post(`/v1/handoffs/items/${inside.item.id}/ack`, {
      decision: 'accept',
    });
    expect(answered.status).toBe(200);
  });

  it('does not count a clock in older than 16 hours as being on shift', async () => {
    fakeNow = new Date('2026-12-05T00:00:00Z');
    const forgotten = await agentNamed('Forgot To Clock Out');
    await clockIn(forgotten);
    fakeNow = new Date('2026-12-05T16:30:00Z'); // 16 and a half hours later
    const open = await outgoingWithTicket('Out Stale'); // names nobody
    expect(
      (await forgotten.client.get<IncomingHandoffs>('/v1/handoffs/incoming')).body.handoffs,
    ).toEqual([]);
    const stale = await forgotten.client.post(`/v1/handoffs/items/${open.item.id}/ack`, {
      decision: 'accept',
    });
    expect(stale.status).toBe(404);
    // The same person after clocking out and in again is on shift.
    await confirmHandoff(forgotten);
    expect((await forgotten.client.post('/v1/shifts/clock-out', {})).status).toBe(200);
    await clockIn(forgotten);
    const fresh = await forgotten.client.post(`/v1/handoffs/items/${open.item.id}/ack`, {
      decision: 'accept',
    });
    expect(fresh.status).toBe(200);
  });

  it('shows a question about a P1 or P2 as overdue after 30 minutes, with or without a named recipient', async () => {
    const overdueOf = async (itemId: string) => {
      const overview = await lead.client.get<ShiftOverview>('/v1/shifts/overview');
      return {
        overview: overview.body,
        entry: overview.body.questions.items.find((entry) => entry.itemId === itemId),
      };
    };
    for (const [day, named] of [
      ['2026-12-10', false],
      ['2026-12-11', true],
    ] as const) {
      fakeNow = new Date(`${day}T03:00:00Z`);
      const incoming = await agentNamed(`Asker ${day}`);
      const asked = await outgoingWithTicket(`Out Q ${day}`, named ? incoming.userId : undefined);
      if (!named) await clockIn(incoming);
      fakeNow = new Date(`${day}T03:02:00Z`);
      const question = await incoming.client.post<AckResult>(
        `/v1/handoffs/items/${asked.item.id}/ack`,
        {
          decision: 'question',
          note: 'Which log file?',
        },
      );
      expect(question.body.ackStatus).toBe('question');

      fakeNow = new Date(`${day}T03:10:00Z`);
      const soon = await overdueOf(asked.item.id);
      expect(soon.entry).toMatchObject({
        ticketKey: asked.ticket.key,
        priority: 'P1',
        overdue: false,
        askedBy: { id: incoming.userId },
        from: { id: asked.outgoing.userId },
      });
      // A question is an acknowledgment: it is not in the unacknowledged list.
      expect(soon.overview.unacknowledged.items.map((entry) => entry.itemId)).not.toContain(
        asked.item.id,
      );

      fakeNow = new Date(`${day}T03:33:00Z`);
      const late = await overdueOf(asked.item.id);
      expect(late.entry?.overdue).toBe(true);
      expect(late.overview.questions.overdue).toBeGreaterThanOrEqual(1);

      // Answering it takes it off the list.
      expect(
        (
          await incoming.client.post(`/v1/handoffs/items/${asked.item.id}/ack`, {
            decision: 'accept',
          })
        ).status,
      ).toBe(200);
      expect((await overdueOf(asked.item.id)).entry).toBeUndefined();
    }
  });

  it('counts a question about a P3 as open but does not put it on the overdue list', async () => {
    fakeNow = new Date('2026-12-12T03:00:00Z');
    const incoming = await agentNamed('Asker P3');
    await clockIn(incoming);
    const calm = await outgoingWithTicket('Out Q P3', undefined, 'P3');
    await incoming.client.post(`/v1/handoffs/items/${calm.item.id}/ack`, {
      decision: 'question',
      note: 'Why?',
    });
    fakeNow = new Date('2026-12-12T05:00:00Z');
    const overview = (await lead.client.get<ShiftOverview>('/v1/shifts/overview')).body;
    expect(overview.openQuestions).toBeGreaterThanOrEqual(1);
    expect(overview.questions.items.map((entry) => entry.itemId)).not.toContain(calm.item.id);
  });
});

// --- AC-7: shaking a ticket off ---

describe('AC-7: a P1 ticket cannot be shaken off to get past the gate', () => {
  const unassign = (who: Persona, ticketId: string) =>
    who.client.post(`/v1/tickets/${ticketId}/assign`, { assigneeId: null });

  it('unassigning a P1 keeps it on the gate: confirm and clock out need it listed with a next action', async () => {
    const agent = await agentNamed('Shaker');
    await clockIn(agent);
    const p1 = await assigned('P1', agent);
    expect((await unassign(agent, p1.id)).status).toBe(200);

    const draft = await prefill(agent);
    expect(draft.items).toHaveLength(0); // it is no longer assigned to the agent
    const status = await agent.client.get<ShiftStatus>('/v1/shifts/status');
    expect(status.body.clockOutBlocked?.blockers).toEqual([
      { ticketId: p1.id, key: p1.key, priority: 'P1', reason: 'not_listed', cause: 'moved_away' },
    ]);
    const refused = await agent.client.post<GateBody>(`/v1/handoffs/${draft.id}/confirm`);
    expect(refused.status).toBe(409);
    expect(refused.body.blockers).toEqual([
      { ticketId: p1.id, key: p1.key, priority: 'P1', reason: 'not_listed', cause: 'moved_away' },
    ]);
    expect((await agent.client.post('/v1/shifts/clock-out', {})).status).toBe(409);

    // Listing it, then giving the next action, is what opens the gate.
    const listed = await agent.client.put<Handoff>(`/v1/handoffs/${draft.id}`, {
      items: [{ kind: 'pending', ticketId: p1.id, title: p1.subject }],
    });
    expect(listed.status).toBe(200);
    const noAction = await agent.client.post<GateBody>(`/v1/handoffs/${draft.id}/confirm`);
    expect(noAction.body.blockers[0]).toMatchObject({
      reason: 'missing_next_action',
      cause: 'moved_away',
    });
    await agent.client.put(`/v1/handoffs/${draft.id}`, {
      items: [
        {
          id: listed.body.items[0]?.id,
          kind: 'pending',
          title: p1.subject,
          nextAction: 'Back with the lead',
        },
      ],
    });
    expect((await agent.client.post(`/v1/handoffs/${draft.id}/confirm`)).status).toBe(200);
    expect((await agent.client.post('/v1/shifts/clock-out', {})).status).toBe(200);
  });

  it('lowering a P1 to P3 keeps it on the gate at P1', async () => {
    const agent = await agentNamed('Downgrader');
    await clockIn(agent);
    const p1 = await assigned('P1', agent);
    const lowered = await agent.client.patch(`/v1/tickets/${p1.id}`, { priority: 'P3' });
    expect(lowered.status).toBe(200);
    const draft = await prefill(agent); // a P3 is still assigned to the agent, so it is listed
    expect(draft.items.map((item) => item.ticket?.id)).toEqual([p1.id]);
    const refused = await agent.client.post<GateBody>(`/v1/handoffs/${draft.id}/confirm`);
    expect(refused.status).toBe(409);
    expect(refused.body.blockers).toEqual([
      {
        ticketId: p1.id,
        key: p1.key,
        priority: 'P1',
        reason: 'missing_next_action',
        cause: 'downgraded',
      },
    ]);
    await agent.client.put(`/v1/handoffs/${draft.id}`, {
      items: [
        { id: draft.items[0]?.id, kind: 'pending', title: p1.subject, nextAction: 'Watch the log' },
      ],
    });
    expect((await agent.client.post(`/v1/handoffs/${draft.id}/confirm`)).status).toBe(200);
    expect((await agent.client.post('/v1/shifts/clock-out', {})).status).toBe(200);
  });

  it('handing a P1 to someone off shift keeps it on the gate; handing it to someone on shift does not', async () => {
    const agent = await agentNamed('Hander');
    const onShift = await agentNamed('Takes It');
    const offShift = await agentNamed('Is Away');
    await clockIn(agent);
    await clockIn(onShift);
    const toAway = await assigned('P1', agent);
    const toHere = await assigned('P1', agent);
    const handOver = (ticketId: string, to: Persona) =>
      agent.client.post(`/v1/tickets/${ticketId}/assign`, { assigneeId: to.userId });
    expect((await handOver(toAway.id, offShift)).status).toBe(200);
    expect((await handOver(toHere.id, onShift)).status).toBe(200);

    const draft = await prefill(agent);
    const refused = await agent.client.post<GateBody>(`/v1/handoffs/${draft.id}/confirm`);
    expect(refused.body.blockers.map((blocker) => [blocker.ticketId, blocker.cause])).toEqual([
      [toAway.id, 'moved_away'],
    ]);
  });

  it('merging a P1 into a resolved P3 does not make it vanish: the target becomes an open P1 and stays on the gate (T-125a)', async () => {
    const agent = await agentNamed('Merger');
    await clockIn(agent);
    const p1 = await assigned('P1', agent);
    const target = await fileTicket(lead, orgId, { priority: 'P3' });
    expect(
      (await lead.client.post(`/v1/tickets/${target.id}/status`, { status: 'resolved' })).status,
    ).toBe(200);
    const merged = await agent.client.post(`/v1/tickets/${p1.id}/merge`, {
      intoTicketId: target.id,
    });
    expect(merged.status).toBe(200);

    const now = await lead.client.get<TicketDetail>(`/v1/tickets/${target.id}`);
    expect(now.body).toMatchObject({ priority: 'P1', status: 'open' });
    const status = await agent.client.get<ShiftStatus>('/v1/shifts/status');
    expect(status.body.clockOutBlocked?.blockers).toEqual([
      expect.objectContaining({ ticketId: target.id, priority: 'P1', cause: 'moved_away' }),
    ]);
    expect((await agent.client.post('/v1/shifts/clock-out', {})).status).toBe(409);
  });

  it('merging a P3 into an unassigned P1 does not put that P1 on the person', async () => {
    const agent = await agentNamed('Merger P3');
    await clockIn(agent);
    const p3 = await assigned('P3', agent);
    const target = await fileTicket(lead, orgId, { priority: 'P1' });
    expect(
      (await agent.client.post(`/v1/tickets/${p3.id}/merge`, { intoTicketId: target.id })).status,
    ).toBe(200);
    const status = await agent.client.get<ShiftStatus>('/v1/shifts/status');
    expect(status.body.clockOutBlocked?.blockers ?? []).toEqual([]);
  });

  it('is checked again at clock out, and a lead override still works and is audited with the cause', async () => {
    const agent = await agentNamed('Late Shaker');
    await clockIn(agent);
    await confirmHandoff(agent); // an empty handoff, confirmed first
    const p1 = await assigned('P1', agent);
    expect((await unassign(agent, p1.id)).status).toBe(200);
    const refused = await agent.client.post<GateBody>('/v1/shifts/clock-out', {});
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      noConfirmedHandoff: false,
      blockers: [{ ticketId: p1.id, reason: 'not_listed', cause: 'moved_away' }],
    });

    const out = await lead.client.post<ClockOutResult>('/v1/shifts/clock-out', {
      userId: agent.userId,
      override: { reason: 'The lead took the ticket over and confirms it' },
    });
    expect(out.status).toBe(200);
    expect(out.body.overridden).toBe(true);
    const rows = await auditRows('shift.clock_out_override', lead.userId);
    expect(rows.at(-1)?.metadata).toMatchObject({
      userId: agent.userId,
      blockers: [{ ticketId: p1.id, cause: 'moved_away' }],
    });
  });

  it("someone else's change does not count against the person", async () => {
    const agent = await agentNamed('Innocent');
    await clockIn(agent);
    const p1 = await assigned('P1', agent);
    const downgraded = await assigned('P1', agent);
    expect((await unassign(lead, p1.id)).status).toBe(200); // the lead took it away
    expect(
      (await lead.client.patch(`/v1/tickets/${downgraded.id}`, { priority: 'P3' })).status,
    ).toBe(200);
    const draft = await prefill(agent);
    const items = draft.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      nextAction: 'Carry on',
    }));
    await agent.client.put(`/v1/handoffs/${draft.id}`, { items });
    expect((await agent.client.post(`/v1/handoffs/${draft.id}/confirm`)).status).toBe(200);
    expect((await agent.client.post('/v1/shifts/clock-out', {})).status).toBe(200);
  });
});

// --- reading is audited (PRD section 8.2) ---

describe('personal data reads are on the audit log', () => {
  it('writes pii.read for the handoff, the brief, the notes and the lead overview', async () => {
    const person = await agentNamed('Reader Audit');
    await clockIn(person);
    expect((await person.client.get('/v1/handoffs/current')).status).toBe(200);
    expect((await person.client.get('/v1/handoffs/incoming')).status).toBe(200);
    expect((await person.client.get('/v1/shifts/brief')).status).toBe(200);
    expect((await person.client.get('/v1/shift-notes')).status).toBe(200);
    expect((await lead.client.get('/v1/shifts/overview')).status).toBe(200);

    const targets = async (actorId: string) =>
      (
        await owner().query<{ target_type: string }>(
          `SELECT target_type FROM audit_log WHERE action = 'pii.read' AND actor_id::text = $1`,
          [actorId],
        )
      ).rows.map((row) => row.target_type);
    expect((await targets(person.userId)).sort()).toEqual([
      'handoff',
      'handoff',
      'shift_brief',
      'shift_note',
    ]);
    expect(await targets(lead.userId)).toContain('shift_overview');
  });
});

// --- notes (R-7.7) ---

describe('shift notes', () => {
  it('a note to the next shift reaches others, not the author, and must be marked read', async () => {
    const writer = await agentNamed('Writer');
    const reader = await agentNamed('Note Reader');
    const created = await writer.client.post<ShiftNote>('/v1/shift-notes', {
      audience: 'next_shift',
      body: 'Printer is down on floor 3',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      audience: 'next_shift',
      readAt: null,
      author: { id: writer.userId },
    });

    const mine = await writer.client.get<ShiftNotePage>('/v1/shift-notes');
    expect(mine.body.items.find((note) => note.id === created.body.id)).toBeUndefined();
    const sent = await writer.client.get<ShiftNotePage>('/v1/shift-notes?box=sent');
    expect(sent.body.items.map((note) => note.id)).toContain(created.body.id);

    const inbox = await reader.client.get<ShiftNotePage>('/v1/shift-notes?unread=true');
    expect(inbox.body.items.map((note) => note.id)).toContain(created.body.id);
    const chip = await reader.client.get<ShiftStatus>('/v1/shifts/status');
    expect(chip.body.unreadNotes).toBe(inbox.body.unreadCount);
    const before = inbox.body.unreadCount;

    const read = await reader.client.post<ShiftNote>(`/v1/shift-notes/${created.body.id}/read`);
    expect(read.status).toBe(200);
    expect(read.body.readAt).not.toBeNull();
    expect((await reader.client.post(`/v1/shift-notes/${created.body.id}/read`)).status).toBe(200); // repeat is fine
    const after = await reader.client.get<ShiftNotePage>('/v1/shift-notes?unread=true');
    expect(after.body.items.map((note) => note.id)).not.toContain(created.body.id);
    expect(after.body.unreadCount).toBe(before - 1);
    // Reading is per person: another reader still has it unread.
    const other = await agentNamed('Other Reader');
    expect(
      (await other.client.get<ShiftNotePage>('/v1/shift-notes?unread=true')).body.items.map(
        (n) => n.id,
      ),
    ).toContain(created.body.id);
    // The author cannot mark their own note read: it is not in their inbox.
    expect((await writer.client.post(`/v1/shift-notes/${created.body.id}/read`)).status).toBe(404);
    expect((await auditRows('shift.note_create', writer.userId)).length).toBe(1);
    expect((await auditRows('shift.note_read', reader.userId)).length).toBe(2);
  });

  it('a note to a person reaches only that person, and one for a date and time shows from then on', async () => {
    const writer = await agentNamed('Writer Two');
    const target = await agentNamed('Target');
    const bystander = await agentNamed('Bystander Two');
    expect(
      (await writer.client.post('/v1/shift-notes', { audience: 'person', body: 'Hi' })).status,
    ).toBe(400);
    expect(
      (
        await writer.client.post('/v1/shift-notes', {
          audience: 'person',
          toUserId: '00000000-0000-4000-8000-000000000009',
          body: 'Hi',
        })
      ).status,
    ).toBe(400);
    const direct = await writer.client.post<ShiftNote>('/v1/shift-notes', {
      audience: 'person',
      toUserId: target.userId,
      body: 'Call the vendor back',
    });
    expect(direct.body.toUser).toMatchObject({ id: target.userId });
    expect(
      (await target.client.get<ShiftNotePage>('/v1/shift-notes')).body.items.map((n) => n.id),
    ).toContain(direct.body.id);
    expect(
      (await bystander.client.get<ShiftNotePage>('/v1/shift-notes')).body.items.map((n) => n.id),
    ).not.toContain(direct.body.id);
    expect((await bystander.client.post(`/v1/shift-notes/${direct.body.id}/read`)).status).toBe(
      404,
    );

    fakeNow = new Date('2026-11-20T00:00:00Z');
    const scheduled = await writer.client.post<ShiftNote>('/v1/shift-notes', {
      audience: 'datetime',
      deliverAt: '2026-11-20T06:00:00Z',
      body: 'Maintenance window starts',
    });
    expect(scheduled.body.deliverAt).toBe('2026-11-20T06:00:00.000Z');
    const ids = async (who: Persona) =>
      (await who.client.get<ShiftNotePage>('/v1/shift-notes')).body.items.map((n) => n.id);
    expect(await ids(target)).not.toContain(scheduled.body.id);
    fakeNow = new Date('2026-11-20T06:01:00Z');
    expect(await ids(target)).toContain(scheduled.body.id);
    expect(await ids(writer)).not.toContain(scheduled.body.id);
  });

  it('a note to the next shift expires from the inbox after 48 hours', async () => {
    const writer = await agentNamed('Writer Three');
    const reader = await agentNamed('Reader Three');
    fakeNow = new Date('2026-11-25T00:00:00Z');
    const note = await writer.client.post<ShiftNote>('/v1/shift-notes', {
      audience: 'next_shift',
      body: 'Short lived',
    });
    const ids = async () =>
      (await reader.client.get<ShiftNotePage>('/v1/shift-notes')).body.items.map((n) => n.id);
    fakeNow = new Date('2026-11-26T23:00:00Z');
    expect(await ids()).toContain(note.body.id);
    fakeNow = new Date('2026-11-27T01:00:00Z');
    expect(await ids()).not.toContain(note.body.id);
  });

  it('pages the inbox with a cursor', async () => {
    const writer = await agentNamed('Writer Four');
    const reader = await agentNamed('Reader Four');
    // Distinct moments, so the order is the order they were written in.
    for (const [index, word] of ['one', 'two', 'three'].entries()) {
      fakeNow = new Date(Date.UTC(2026, 10, 28, 0, 0, index));
      await writer.client.post('/v1/shift-notes', {
        audience: 'person',
        toUserId: reader.userId,
        body: word,
      });
    }
    const first = await reader.client.get<ShiftNotePage>('/v1/shift-notes?limit=2');
    expect(first.body.items.map((n) => n.body)).toEqual(['three', 'two']);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await reader.client.get<ShiftNotePage>(
      `/v1/shift-notes?limit=2&cursor=${first.body.nextCursor ?? ''}`,
    );
    // (A note for a date and time that has come, written earlier by another test, is also in the inbox.)
    expect(second.body.items[0]?.body).toBe('one');
    expect(second.body.nextCursor).toBeNull();
  });
});

// --- the brief (R-7.4) ---

describe('the daily brief', () => {
  it('lists my tickets by SLA risk, the ones that crossed a shift, the previous shift items by kind, and my unread notes', async () => {
    const outgoing = await agentNamed('Brief Out');
    await clockIn(outgoing);
    const carried = await assigned('P2', outgoing);
    const draft = await prefill(outgoing);
    const saved = await outgoing.client.put<Handoff>(`/v1/handoffs/${draft.id}`, {
      messageForNext: 'Mind the carried ticket',
      items: [
        ...draft.items.map((item) => ({
          id: item.id,
          kind: item.kind,
          title: item.title,
          nextAction: 'Chase the vendor',
        })),
        {
          kind: 'incident',
          title: 'SEV2 error rate',
          nextAction: 'Watch the dashboard',
          severity: 'SEV2',
        },
        { kind: 'deploy', title: 'api 1.4.2 to staging' },
        { kind: 'alert', title: 'Disk alert snoozed until 06:00' },
        { kind: 'watch', title: 'Go-live tonight' },
      ],
    });
    expect(saved.status).toBe(200);
    expect((await outgoing.client.post(`/v1/handoffs/${draft.id}/confirm`)).status).toBe(200);
    await outgoing.client.post('/v1/shifts/clock-out', {});

    const me = await agentNamed('Brief Me');
    await clockIn(me);
    // The carried ticket and two fresh ones are mine now: one overdue (first response due in the past).
    await lead.client.post(`/v1/tickets/${carried.id}/assign`, { assigneeId: me.userId });
    const urgent = await assigned('P1', me);
    const calm = await assigned('P3', me);
    await owner().query(
      `UPDATE ticket SET first_response_due_at = now() - interval '5 minutes' WHERE id = $1`,
      [urgent.id],
    );
    const noted = await outgoing.client.post<ShiftNote>('/v1/shift-notes', {
      audience: 'person',
      toUserId: me.userId,
      body: 'Welcome to the shift',
    });

    const brief = await me.client.get<ShiftBrief>('/v1/shifts/brief');
    expect(brief.status).toBe(200);
    const body = brief.body;
    expect(body.timezone).toBe('Asia/Bangkok');
    expect(body.session?.userId).toBe(me.userId);
    expect(body.aiSummary).toBeNull();

    const fromOutgoing = body.handoff.handoffs.find((entry) => entry.from.id === outgoing.userId);
    expect(fromOutgoing?.messageForNext).toBe('Mind the carried ticket');
    expect(body.incidents.map((item) => item.title)).toContain('SEV2 error rate');
    expect(body.deploys.map((item) => item.title)).toContain('api 1.4.2 to staging');
    expect(body.snoozedAlerts.map((item) => item.title)).toContain(
      'Disk alert snoozed until 06:00',
    );
    expect(body.watchItems.map((item) => item.title)).toContain('Go-live tonight');

    const keys = body.myTickets.map((ticket) => ticket.key);
    expect(keys[0]).toBe(urgent.key); // breached first
    expect(body.myTickets[0]?.slaState).toBe('breached');
    expect(keys).toEqual(expect.arrayContaining([carried.key, calm.key]));
    expect(body.carriedOver.map((ticket) => [ticket.key, ticket.crossedShifts])).toEqual([
      [carried.key, 1],
    ]);
    expect(body.notes.map((note) => note.id)).toContain(noted.body.id);

    // Marking the brief read stamps the session; it is idempotent.
    const stamped = await me.client.post<ShiftSession>('/v1/shifts/brief/read');
    expect(stamped.body.briefReadAt).not.toBeNull();
    expect((await me.client.post<ShiftSession>('/v1/shifts/brief/read')).body.briefReadAt).toBe(
      stamped.body.briefReadAt,
    );
    // The first call wrote its own row inside the transaction; the repeat is a plain audited request.
    expect((await auditRows('shift.brief_read', me.userId)).length).toBeGreaterThanOrEqual(1);
    const idle = await agentNamed('Brief Idle');
    expect((await idle.client.post('/v1/shifts/brief/read')).status).toBe(409);
    expect((await idle.client.get<ShiftBrief>('/v1/shifts/brief')).body.session).toBeNull();
  });
});

// --- assignment (R-1.7) and the assignee list ---

describe('assignment by shift', () => {
  it('lists staff for an agent who may not list users, with who is on shift and how loaded they are', async () => {
    const agent = await agentNamed('Lister');
    expect((await agent.client.get('/v1/users')).status).toBe(403); // the reason this endpoint exists
    const busy = await agentNamed('Busy');
    const idle = await agentNamed('Idle Staff');
    await clockIn(busy);
    await assigned('P3', busy);
    await assigned('P3', busy);
    const queue = await apiQueue(lead, {
      name: `Assignee queue ${uniqueEmail('q')}`,
      memberIds: [busy.userId],
    });

    const list = await agent.client.get<AssigneeList>(`/v1/assignees?queueId=${queue.id}`);
    expect(list.status).toBe(200);
    expect(list.body.scope).toBe('queue');
    const byId = new Map(list.body.assignees.map((person) => [person.id, person]));
    expect(byId.get(busy.userId)).toMatchObject({
      onShift: true,
      openTickets: 2,
      inQueue: true,
      role: 'agent',
    });
    expect(byId.get(idle.userId)).toMatchObject({ onShift: false, openTickets: 0, inQueue: false });
    // Name and role only: no email, no status.
    expect(Object.keys(byId.get(busy.userId) ?? {}).sort()).toEqual([
      'id',
      'inQueue',
      'name',
      'onShift',
      'openTickets',
      'role',
    ]);
    // Disabled people and clients are not offered.
    const gone = await agentNamed('Left Company');
    await head.client.patch(`/v1/users/${gone.userId}`, { status: 'disabled' });
    expect(
      (await agent.client.get<AssigneeList>('/v1/assignees')).body.assignees.map((p) => p.id),
    ).not.toContain(gone.userId);
  });

  it('offers every active staff member when there is no queue to narrow it, and says so (QA-12)', async () => {
    const asker = await agentNamed('Scope Asker');
    const other = await agentNamed('Scope Other');
    await clockIn(other);
    const expectAllStaff = (body: AssigneeList) => {
      expect(body.scope).toBe('all_staff');
      const ids = body.assignees.map((person) => person.id);
      expect(ids).toEqual(expect.arrayContaining([asker.userId, other.userId, lead.userId]));
      expect(body.assignees.every((person) => !person.inQueue)).toBe(true);
      expect(body.assignees.find((person) => person.id === other.userId)?.onShift).toBe(true);
    };
    // No queue asked for, an unknown queue, and a queue nobody belongs to.
    expectAllStaff((await asker.client.get<AssigneeList>('/v1/assignees')).body);
    expectAllStaff(
      (
        await asker.client.get<AssigneeList>(
          '/v1/assignees?queueId=00000000-0000-4000-8000-000000000000',
        )
      ).body,
    );
    const empty = await apiQueue(lead, { name: `Empty ${uniqueEmail('q')}`, memberIds: [] });
    expectAllStaff(
      (await asker.client.get<AssigneeList>(`/v1/assignees?queueId=${empty.id}`)).body,
    );
    // An agent may still assign a ticket to a non-member (a manual assignment needs no queue).
    const ticket = await fileTicket(lead, orgId, { priority: 'P3' });
    const handed = await asker.client.post<TicketDetail>(`/v1/tickets/${ticket.id}/assign`, {
      assigneeId: other.userId,
    });
    expect(handed.status).toBe(200);
    expect(handed.body.assignee?.id).toBe(other.userId);
  });

  it('round robin takes turns among the people who are clocked in, and nobody off shift', async () => {
    const [a, b] = [await agentNamed('RR A'), await agentNamed('RR B')];
    const off = await agentNamed('RR Off');
    await clockIn(a);
    await clockIn(b);
    const queue = await apiQueue(lead, {
      name: `Shift round robin ${uniqueEmail('q')}`,
      assignmentMode: 'round_robin',
      memberIds: [a.userId, b.userId, off.userId],
    });
    const owners: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      owners.push((await fileTicket(lead, orgId, { queueId: queue.id })).assignee?.id ?? 'nobody');
    }
    expect(new Set(owners)).toEqual(new Set([a.userId, b.userId]));
    expect(owners[0]).toBe(owners[2]);
    expect(owners[1]).toBe(owners[3]);

    // Once they clock out (with a confirmed handoff) they get nothing more.
    for (const who of [a, b]) {
      await confirmHandoff(who);
      expect((await who.client.post('/v1/shifts/clock-out', {})).status).toBe(200);
    }
    const unassigned = await fileTicket(lead, orgId, { queueId: queue.id });
    expect(unassigned.assignee).toBeNull();
  });

  it('load balanced gives the ticket to the least loaded person on shift', async () => {
    const [busy, free] = [await agentNamed('LB Busy'), await agentNamed('LB Free')];
    await clockIn(busy);
    await clockIn(free);
    await assigned('P3', busy);
    await assigned('P3', busy);
    const queue = await apiQueue(lead, {
      name: `Load balanced ${uniqueEmail('q')}`,
      assignmentMode: 'load_balanced',
      memberIds: [busy.userId, free.userId],
    });
    expect((await fileTicket(lead, orgId, { queueId: queue.id })).assignee?.id).toBe(free.userId);
    expect((await fileTicket(lead, orgId, { queueId: queue.id })).assignee?.id).toBe(free.userId);
    // free now holds two as well: the next one is a tie, and ties take turns.
    const third = (await fileTicket(lead, orgId, { queueId: queue.id })).assignee?.id;
    expect([busy.userId, free.userId]).toContain(third);
    expect(queue.assignmentMode).toBe('load_balanced');
  });

  it('stay with the last handler returns a requester to the same person', async () => {
    const [a, b] = [await agentNamed('Stay A'), await agentNamed('Stay B')];
    await clockIn(a);
    await clockIn(b);
    const queue = await apiQueue(lead, {
      name: `Stay ${uniqueEmail('q')}`,
      assignmentMode: 'stay_with_last_handler',
      memberIds: [a.userId, b.userId],
    });
    const requester = { email: uniqueEmail('regular'), name: 'Regular' };
    const first = await fileTicket(lead, orgId, { queueId: queue.id, requester });
    const handler = first.assignee?.id ?? '';
    expect(handler).not.toBe('');
    for (let i = 0; i < 3; i += 1) {
      await fileTicket(lead, orgId, { queueId: queue.id, assigneeId: handler });
    }
    const again = await fileTicket(lead, orgId, { queueId: queue.id, requester });
    expect(again.assignee?.id).toBe(handler);
    const stored = await lead.client.get<{ queues: TeamQueue[] }>('/v1/queues');
    expect(stored.body.queues.find((entry) => entry.id === queue.id)?.assignmentMode).toBe(
      'stay_with_last_handler',
    );
  });
});

// --- SLA time left (business time, served by the server) ---

describe('SLA time left', () => {
  it('serves the running target and the minutes left with each ticket', async () => {
    const ticket = await fileTicket(lead, orgId, { priority: 'P1' });
    // 15 minutes to answer a P1: within the last 30 minutes, so the state is "at risk".
    expect(ticket.sla).toMatchObject({
      target: 'first_response',
      state: 'at_risk',
      calendar: '24x7',
    });
    expect(ticket.sla?.minutesLeft).toBeGreaterThanOrEqual(14);
    expect(ticket.sla?.minutesLeft).toBeLessThanOrEqual(15);
    const list = await lead.client.get<{ items: TicketDetail[] }>(`/v1/tickets?limit=5`);
    const listed = list.body.items.find((item) => item.id === ticket.id)?.sla;
    expect(listed).toMatchObject({
      target: 'first_response',
      dueAt: ticket.sla?.dueAt,
      state: 'at_risk',
    });

    const business = await fileTicket(lead, orgId, { priority: 'P3' });
    expect(business.sla).toMatchObject({ target: 'first_response', calendar: 'business' });
  });

  it('counts business time: a due date on Monday morning is minutes away on Saturday, not days', async () => {
    const sla = h.app.get(SlaRemaining, { strict: false });
    const [policy] = (
      await owner().query<{ id: string }>(`SELECT id FROM sla_policy WHERE tier = 'gold'`)
    ).rows;
    const base = {
      status: 'open',
      priority: 'P3',
      createdAt: new Date('2026-10-30T02:00:00Z'),
      slaPolicyId: policy?.id ?? null,
      slaPausedAt: null,
      firstResponseDueAt: new Date('2026-11-02T04:00:00Z'), // Monday 11:00 in Bangkok
      resolutionDueAt: new Date('2026-11-05T03:00:00Z'),
      firstRespondedAt: null,
      resolvedAt: null,
    };
    // Saturday 12:00 in Bangkok: only Monday 09:00 to 11:00 is left, two hours of business time.
    const saturday = await sla.view(base, new Date('2026-10-31T05:00:00Z'));
    expect(saturday).toMatchObject({
      target: 'first_response',
      calendar: 'business',
      minutesLeft: 120,
      state: 'ok',
    });
    // Monday 10:45: 15 minutes of business time left is at risk.
    const monday = await sla.view(base, new Date('2026-11-02T03:45:00Z'));
    expect(monday).toMatchObject({ minutesLeft: 15, state: 'at_risk' });
    // After the due time it is breached, with nothing left; paused has no time left at all.
    expect(await sla.view(base, new Date('2026-11-02T05:00:00Z'))).toMatchObject({
      state: 'breached',
      minutesLeft: 0,
    });
    expect(
      await sla.view(
        { ...base, slaPausedAt: new Date('2026-10-31T05:00:00Z') },
        new Date('2026-10-31T06:00:00Z'),
      ),
    ).toMatchObject({
      state: 'paused',
      minutesLeft: null,
    });
    // After the first response the resolution target runs; a finished ticket has none.
    expect(
      await sla.view(
        { ...base, firstRespondedAt: new Date('2026-10-31T03:00:00Z') },
        new Date('2026-10-31T05:00:00Z'),
      ),
    ).toMatchObject({
      target: 'resolution',
    });
    expect(
      await sla.view({ ...base, status: 'resolved' }, new Date('2026-10-31T05:00:00Z')),
    ).toBeNull();
  });
});

// --- the zone comes from the business calendar ---

describe('the time zone is the business calendar zone', () => {
  it('moves every shift window when the default calendar changes zone', async () => {
    const zoned = await apiCalendar(head, {
      name: 'Tokyo office hours',
      timezone: 'Asia/Tokyo',
      isDefault: true,
    });
    expect(zoned.timezone).toBe('Asia/Tokyo');
    const day = (
      await lead.client.post<ShiftDefinition>('/v1/shifts/definitions', {
        name: `Zone day ${uniqueEmail('d')}`,
        startsAt: '08:00',
        endsAt: '17:00',
      })
    ).body;
    const a = await agentNamed('Zone Agent');
    const entry = await lead.client.post<RosterEntry>('/v1/roster', {
      shiftId: day.id,
      userId: a.userId,
      workDate: '2026-12-10',
    });
    // 08:00 in Tokyo is 23:00 UTC the day before; in Bangkok it was 01:00 UTC.
    expect(entry.body.startsAt).toBe('2026-12-09T23:00:00.000Z');
    expect(entry.body.startsAt).toBe(
      shiftWindow(day, '2026-12-10', 'Asia/Tokyo').start.toISOString(),
    );
    const list = await a.client.get<ShiftDefinitionList>('/v1/shifts/definitions');
    expect(list.body.timezone).toBe('Asia/Tokyo');
  });
});

// --- deny by default: a permission taken from a role closes the route ---

describe('RBAC: each permission is checked on its own', () => {
  async function without(permission: Permission, run: () => Promise<void>): Promise<void> {
    const keep = DEFAULT_ROLE_PERMISSIONS.agent;
    const set = (permissions: readonly Permission[]) =>
      head.client.put(`/v1/rbac/roles/agent/permissions`, { permissions: [...permissions] });
    expect((await set(keep.filter((key) => key !== permission))).status).toBe(200);
    try {
      await run();
    } finally {
      expect((await set(keep)).status).toBe(200);
    }
  }

  it('clock in and out need shift.clock, the handoff needs handoff.write, notes need shift.note.write', async () => {
    const agent = await agentNamed('Stripped');
    const draftOwner = await agentNamed('Stripped Owner');
    await clockIn(draftOwner);
    await without('shift.clock', async () => {
      expect((await agent.client.post('/v1/shifts/clock-in', {})).status).toBe(403);
      expect((await agent.client.post('/v1/shifts/clock-out', {})).status).toBe(403);
      expect((await agent.client.get('/v1/shifts/status')).status).toBe(403);
      expect((await agent.client.get('/v1/shifts/brief')).status).toBe(403);
    });
    await without('handoff.write', async () => {
      expect((await draftOwner.client.post('/v1/handoffs/prefill')).status).toBe(403);
      expect((await draftOwner.client.get('/v1/handoffs/current')).status).toBe(403);
    });
    await without('shift.note.write', async () => {
      expect(
        (await agent.client.post('/v1/shift-notes', { audience: 'next_shift', body: 'x' })).status,
      ).toBe(403);
      expect((await agent.client.get('/v1/shift-notes')).status).toBe(403);
    });
    // Back to normal afterwards.
    expect((await agent.client.post('/v1/shifts/clock-in', {})).status).toBe(200);
  });

  it('acknowledging needs both handoff.ack and ticket.handle, because accepting moves a ticket', async () => {
    const outgoing = await agentNamed('Out Stripped');
    await clockIn(outgoing);
    const ticket = await assigned('P1', outgoing);
    const handoff = await confirmHandoff(outgoing);
    const item = handoff.items.find((entry) => entry.ticket?.id === ticket.id) as HandoffItem;
    await outgoing.client.post('/v1/shifts/clock-out', {});
    const incoming = await agentNamed('In Stripped');
    await clockIn(incoming);
    const ack = () =>
      incoming.client.post(`/v1/handoffs/items/${item.id}/ack`, { decision: 'accept' });
    await without('handoff.ack', async () => {
      expect((await ack()).status).toBe(403);
      expect((await incoming.client.get('/v1/handoffs/incoming')).status).toBe(403);
    });
    await without('ticket.handle', async () => {
      expect((await ack()).status).toBe(403);
    });
    expect((await ack()).status).toBe(200);
  });

  it('saving a handoff does not return the subject of a ticket the caller may not read', async () => {
    const agent = await agentNamed('No Ticket Access');
    await clockIn(agent);
    const draft = await prefill(agent);
    const someone = await agentNamed('Other Holder');
    const secret = await assigned('P3', someone);
    const save = () =>
      agent.client.put<Handoff & ApiErrorBody>(`/v1/handoffs/${draft.id}`, {
        items: [{ kind: 'pending', ticketId: secret.id, title: 'Look at this' }],
      });
    await without('ticket.read', async () => {
      const refused = await save();
      expect(refused.status).toBe(403);
      expect(JSON.stringify(refused.body)).not.toContain(secret.subject);
    });
    const allowed = await save();
    expect(allowed.status).toBe(200);
    expect(allowed.body.items[0]?.ticket?.subject).toBe(secret.subject);
  });

  it('managing the roster needs roster.manage even for a lead-like role on other routes', async () => {
    const agent = await agentNamed('Roster Peek');
    expect((await agent.client.get('/v1/shifts/overview')).status).toBe(403);
    const leadRole = DEFAULT_ROLE_PERMISSIONS.lead.filter((key) => key !== 'roster.manage');
    const set = (permissions: readonly Permission[]) =>
      head.client.put(`/v1/rbac/roles/lead/permissions`, { permissions: [...permissions] });
    expect((await set(leadRole)).status).toBe(200);
    try {
      expect(
        (
          await lead.client.post('/v1/roster', {
            shiftId: ID0,
            userId: ID0,
            workDate: '2026-12-02',
          })
        ).status,
      ).toBe(403);
      // performance.read.all still opens the overview.
      expect((await lead.client.get('/v1/shifts/overview')).status).toBe(200);
      expect(
        (
          await lead.client.post('/v1/shifts/clock-out', {
            override: { reason: 'Not allowed any more' },
          })
        ).status,
      ).toBe(403);
    } finally {
      expect((await set(DEFAULT_ROLE_PERMISSIONS.lead)).status).toBe(200);
    }
  });
});

const ID0 = '00000000-0000-4000-8000-000000000001';

// --- OpenAPI ---

describe('OpenAPI', () => {
  interface Operation {
    'x-required-permissions'?: string[];
    responses: Record<string, unknown>;
    summary?: string;
  }

  it('documents every shift route with the permission it needs and a success response', async () => {
    const response = await fetch(`${h.base}/docs-json`);
    const document = (await response.json()) as {
      paths: Record<string, Record<string, Operation>>;
    };
    const prefixes = [
      '/v1/shifts',
      '/v1/roster',
      '/v1/handoffs',
      '/v1/shift-notes',
      '/v1/assignees',
    ];
    const operations = Object.entries(document.paths)
      .filter(([path]) => prefixes.some((prefix) => path.startsWith(prefix)))
      .flatMap(([path, methods]) =>
        Object.entries(methods).map(([method, operation]) => ({ path, method, operation })),
      );
    expect(operations.length).toBeGreaterThanOrEqual(23);
    for (const { path, method, operation } of operations) {
      const label = `${method.toUpperCase()} ${path}`;
      expect(operation['x-required-permissions']?.length, label).toBeGreaterThan(0);
      expect(operation.summary, label).toBeTruthy();
      expect(
        ['200', '201', '204'].some((status) => status in operation.responses),
        label,
      ).toBe(true);
    }
    const permissions = (method: string, path: string) =>
      document.paths[path]?.[method]?.['x-required-permissions'];
    expect(permissions('post', '/v1/handoffs/items/{itemId}/ack')).toEqual([
      'handoff.ack',
      'ticket.handle',
    ]);
    expect(permissions('get', '/v1/shifts/overview')).toEqual([
      'roster.manage',
      'performance.read.all',
    ]);
    expect(permissions('post', '/v1/shifts/clock-out')).toEqual(['shift.clock']);
    expect(document.paths['/v1/shifts/clock-out']?.post?.responses).toHaveProperty('409');
  });
});
