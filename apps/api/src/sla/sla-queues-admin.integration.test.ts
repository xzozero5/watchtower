import {
  DEFAULT_WEEKLY_HOURS,
  addSlaMinutes,
  type BusinessCalendarRecord,
  type Organization,
  type SlaPolicy,
  type TeamQueue,
  type TicketDetail,
  type WeeklyHours,
} from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

// The happy paths of the SLA and queue administration on the real application. Who may call them
// is in tickets-access.integration.test.ts; here the point is that they work and what they change.

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;

const pool = () => h.db.owner.pool;
const ms = (iso: string | null): number => Date.parse(iso ?? '');
const unique = (prefix: string): string => `${prefix} ${uniqueEmail('n')}`;

/** Every day 09:00 to 18:00, so a due date is never pushed to a weekend by chance. */
const EVERY_DAY: WeeklyHours = {
  mon: [{ start: '09:00', end: '18:00' }],
  tue: [{ start: '09:00', end: '18:00' }],
  wed: [{ start: '09:00', end: '18:00' }],
  thu: [{ start: '09:00', end: '18:00' }],
  fri: [{ start: '09:00', end: '18:00' }],
  sat: [{ start: '09:00', end: '18:00' }],
  sun: [{ start: '09:00', end: '18:00' }],
};

const localDate = (iso: string | null, timezone: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso ?? ''));

beforeAll(async () => {
  h = await startHarness();
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
});

afterAll(async () => {
  await h.close();
});

describe('business calendars', () => {
  it('creates, lists, reads, edits and deletes a calendar, and audits each change', async () => {
    const name = unique('Calendar');
    const created = await head.client.post<BusinessCalendarRecord>('/v1/business-calendars', {
      name,
      timezone: 'Asia/Bangkok',
      holidays: [{ date: '2027-01-01', name: 'New Year' }],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name,
      timezone: 'Asia/Bangkok',
      isDefault: false,
      hours: DEFAULT_WEEKLY_HOURS,
      holidays: [{ date: '2027-01-01', name: 'New Year' }],
    });
    const id = created.body.id;

    const list = await agent.client.get<{ calendars: BusinessCalendarRecord[] }>(
      '/v1/business-calendars',
    );
    expect(list.status).toBe(200);
    expect(list.body.calendars.map((calendar) => calendar.id)).toContain(id);
    expect(
      (await agent.client.get<BusinessCalendarRecord>(`/v1/business-calendars/${id}`)).body,
    ).toMatchObject({ id, name });

    const edited = await head.client.patch<BusinessCalendarRecord>(`/v1/business-calendars/${id}`, {
      name: `${name} renamed`,
      timezone: 'Asia/Tokyo',
      holidays: [],
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ name: `${name} renamed`, timezone: 'Asia/Tokyo' });
    expect(edited.body.holidays).toEqual([]);
    expect(edited.body.updatedAt >= created.body.updatedAt).toBe(true);

    const removed = await head.client.delete(`/v1/business-calendars/${id}`);
    expect(removed.status).toBe(204);
    expect((await head.client.get(`/v1/business-calendars/${id}`)).status).toBe(404);
    expect((await head.client.delete(`/v1/business-calendars/${id}`)).status).toBe(404);

    const audit = await pool().query<{ action: string }>(
      `SELECT action FROM audit_log WHERE target_id = $1 AND target_type = 'business_calendar' AND outcome = 'success' ORDER BY created_at`,
      [id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      'business_calendar.create',
      'business_calendar.update',
      'business_calendar.delete',
    ]);
  });

  it('keeps at most one default calendar, and refuses duplicates and bad input', async () => {
    const first = await apiCalendar(head, { name: unique('Default A'), isDefault: true });
    const second = await apiCalendar(head, { name: unique('Default B') });
    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);

    const promoted = await head.client.patch<BusinessCalendarRecord>(
      `/v1/business-calendars/${second.id}`,
      { isDefault: true },
    );
    expect(promoted.body.isDefault).toBe(true);
    const list = await head.client.get<{ calendars: BusinessCalendarRecord[] }>(
      '/v1/business-calendars',
    );
    expect(
      list.body.calendars.filter((calendar) => calendar.isDefault).map((calendar) => calendar.id),
    ).toEqual([second.id]);

    const duplicate = await head.client.post<ApiErrorBody>('/v1/business-calendars', {
      name: first.name,
    });
    expect(duplicate.status).toBe(409);
    for (const body of [
      { name: unique('Bad zone'), timezone: 'Mars/Olympus' },
      { name: unique('Bad date'), holidays: [{ date: '2027-02-30', name: 'Nope' }] },
      {
        name: unique('Same day twice'),
        holidays: [
          { date: '2027-01-01', name: 'A' },
          { date: '2027-01-01', name: 'B' },
        ],
      },
      {
        name: unique('Never open'),
        hours: { ...DEFAULT_WEEKLY_HOURS, mon: [], tue: [], wed: [], thu: [], fri: [] },
      },
    ]) {
      expect(
        (await head.client.post('/v1/business-calendars', body)).status,
        JSON.stringify(body),
      ).toBe(400);
    }
    expect((await head.client.patch(`/v1/business-calendars/${first.id}`, {})).status).toBe(400);
  });

  it('adding a holiday moves the due date of a ticket created afterwards', async () => {
    const timezone = 'Asia/Bangkok';
    const calendar = await apiCalendar(head, {
      name: unique('Every day'),
      timezone,
      hours: EVERY_DAY,
    });
    const policy = await apiPolicy(head, {
      name: unique('Holiday policy'),
      businessCalendarId: calendar.id,
      targets: { P3: { first_response_min: 60, resolution_min: 480, calendar: 'business' } },
    });
    const orgResponse = await lead.client.post<Organization>('/v1/orgs', {
      name: unique('Holiday org'),
      slaPolicyId: policy.id,
    });
    expect(orgResponse.status).toBe(201);
    const orgId = orgResponse.body.id;

    const before = await fileTicket(agent, orgId, { priority: 'P3' });
    expect(before.slaPolicyId).toBe(policy.id);
    // 480 minutes is exactly one working day of 9 hours less an hour: it lands on one local day.
    const busyDay = localDate(before.resolutionDueAt, timezone);

    const edited = await head.client.patch<BusinessCalendarRecord>(
      `/v1/business-calendars/${calendar.id}`,
      { holidays: [{ date: busyDay, name: 'Company day off' }] },
    );
    expect(edited.status).toBe(200);
    expect(edited.body.holidays).toEqual([{ date: busyDay, name: 'Company day off' }]);

    const after = await fileTicket(agent, orgId, { priority: 'P3' });
    const expectedAfter = addSlaMinutes(new Date(after.createdAt), 480, 'business', {
      timezone,
      hours: EVERY_DAY,
      holidays: [busyDay],
    });
    expect(ms(after.resolutionDueAt)).toBe(expectedAfter.getTime());
    expect(localDate(after.resolutionDueAt, timezone)).not.toBe(busyDay);
    expect(ms(after.resolutionDueAt)).toBeGreaterThan(ms(before.resolutionDueAt));
    expect(ms(after.firstResponseDueAt)).toBe(
      addSlaMinutes(new Date(after.createdAt), 60, 'business', {
        timezone,
        hours: EVERY_DAY,
        holidays: [busyDay],
      }).getTime(),
    );

    // The ticket created before the change keeps the dates it was promised.
    const reread = await agent.client.get<TicketDetail>(`/v1/tickets/${before.id}`);
    expect(reread.body.resolutionDueAt).toBe(before.resolutionDueAt);
  });

  it('refuses to delete a calendar that a policy uses', async () => {
    const calendar = await apiCalendar(head, { name: unique('In use') });
    const policy = await apiPolicy(head, {
      name: unique('Uses a calendar'),
      businessCalendarId: calendar.id,
      targets: { P3: { first_response_min: 60, resolution_min: 120, calendar: 'business' } },
    });
    expect((await head.client.delete(`/v1/business-calendars/${calendar.id}`)).status).toBe(409);
    expect((await head.client.delete(`/v1/sla-policies/${policy.id}`)).status).toBe(204);
    expect((await head.client.delete(`/v1/business-calendars/${calendar.id}`)).status).toBe(204);
  });
});

describe('SLA policies', () => {
  const targets = {
    P1: { first_response_min: 15, resolution_min: 240, calendar: '24x7' },
    P3: { first_response_min: 240, resolution_min: 2400, calendar: 'business' },
  };

  it('creates, lists, reads, edits and deletes a policy, and audits each change', async () => {
    const name = unique('Policy');
    const created = await head.client.post<SlaPolicy>('/v1/sla-policies', { name, targets });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name, tier: null, businessCalendarId: null, targets });
    const id = created.body.id;

    const list = await agent.client.get<{ policies: SlaPolicy[] }>('/v1/sla-policies');
    expect(list.status).toBe(200);
    expect(list.body.policies.map((policy) => policy.id)).toContain(id);
    expect((await agent.client.get<SlaPolicy>(`/v1/sla-policies/${id}`)).body).toMatchObject({
      id,
      name,
    });

    const edited = await head.client.patch<SlaPolicy>(`/v1/sla-policies/${id}`, {
      name: `${name} v2`,
      targets: { P2: { first_response_min: 30, resolution_min: 600, calendar: 'business' } },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.name).toBe(`${name} v2`);
    expect(Object.keys(edited.body.targets)).toEqual(['P2']);

    expect((await head.client.delete(`/v1/sla-policies/${id}`)).status).toBe(204);
    expect((await head.client.get(`/v1/sla-policies/${id}`)).status).toBe(404);
    expect((await head.client.delete(`/v1/sla-policies/${id}`)).status).toBe(404);

    const audit = await pool().query<{ action: string }>(
      `SELECT action FROM audit_log WHERE target_id = $1 AND target_type = 'sla_policy' AND outcome = 'success' ORDER BY created_at`,
      [id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      'sla_policy.create',
      'sla_policy.update',
      'sla_policy.delete',
    ]);
  });

  it('gives a new ticket the due dates of the policy edit it was created after', async () => {
    const orgResponse = await lead.client.post<Organization>('/v1/orgs', {
      name: unique('Edit org'),
    });
    const policy = await apiPolicy(head, { name: unique('Editable'), targets });
    expect(
      (await lead.client.patch(`/v1/orgs/${orgResponse.body.id}`, { slaPolicyId: policy.id }))
        .status,
    ).toBe(200);

    const first = await fileTicket(agent, orgResponse.body.id, { priority: 'P1' });
    expect(ms(first.resolutionDueAt) - ms(first.createdAt)).toBe(240 * 60_000);
    await head.client.patch(`/v1/sla-policies/${policy.id}`, {
      targets: { P1: { first_response_min: 5, resolution_min: 30, calendar: '24x7' } },
    });
    const second = await fileTicket(agent, orgResponse.body.id, { priority: 'P1' });
    expect(ms(second.resolutionDueAt) - ms(second.createdAt)).toBe(30 * 60_000);
    expect(ms(second.firstResponseDueAt) - ms(second.createdAt)).toBe(5 * 60_000);
  });

  it('is the default of one tier only, and cannot be deleted while an organization uses it', async () => {
    const tiered = await head.client.post<SlaPolicy>('/v1/sla-policies', {
      name: unique('Silver'),
      tier: 'silver',
      targets,
    });
    expect(tiered.status).toBe(201);
    expect(tiered.body.tier).toBe('silver');
    const second = await head.client.post<ApiErrorBody>('/v1/sla-policies', {
      name: unique('Another silver'),
      tier: 'silver',
      targets,
    });
    expect(second.status).toBe(409);
    expect(
      (await head.client.post('/v1/sla-policies', { name: unique('Empty'), targets: {} })).status,
    ).toBe(201);
    expect(
      (
        await head.client.post('/v1/sla-policies', {
          name: unique('Backwards'),
          targets: { P1: { first_response_min: 100, resolution_min: 10, calendar: '24x7' } },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await head.client.post('/v1/sla-policies', {
          name: unique('Unknown calendar'),
          targets,
          businessCalendarId: '00000000-0000-4000-8000-000000000001',
        })
      ).status,
    ).toBe(400);

    const used = await apiPolicy(head, { name: unique('Used'), targets });
    const org = await lead.client.post<Organization>('/v1/orgs', {
      name: unique('Uses it'),
      slaPolicyId: used.id,
    });
    expect(org.status).toBe(201);
    expect((await head.client.delete(`/v1/sla-policies/${used.id}`)).status).toBe(409);
  });
});

describe('team queues', () => {
  it('creates, lists, reads, edits, replaces members and deletes a queue, and audits each change', async () => {
    const members = await Promise.all([signIn(h, 'agent'), signIn(h, 'agent'), signIn(h, 'agent')]);
    const [one, two, three] = members;
    const name = unique('Queue');
    const created = await lead.client.post<TeamQueue>('/v1/queues', {
      name,
      assignmentMode: 'round_robin',
      memberIds: [one.userId, two.userId],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name, assignmentMode: 'round_robin', isDefault: false });
    expect(created.body.members.map((member) => member.userId).sort()).toEqual(
      [one.userId, two.userId].sort(),
    );
    expect(created.body.members.every((member) => member.status === 'active')).toBe(true);
    const id = created.body.id;

    const list = await agent.client.get<{ queues: TeamQueue[] }>('/v1/queues');
    expect(list.status).toBe(200);
    expect(list.body.queues.map((queue) => queue.id)).toContain(id);
    expect((await agent.client.get<TeamQueue>(`/v1/queues/${id}`)).body.name).toBe(name);

    const renamed = await lead.client.patch<TeamQueue>(`/v1/queues/${id}`, {
      name: `${name} renamed`,
      assignmentMode: 'manual',
    });
    expect(renamed.body).toMatchObject({ name: `${name} renamed`, assignmentMode: 'manual' });
    // Not touching memberIds leaves the members as they were.
    expect(renamed.body.members).toHaveLength(2);

    const replaced = await lead.client.patch<TeamQueue>(`/v1/queues/${id}`, {
      memberIds: [three.userId],
    });
    expect(replaced.body.members.map((member) => member.userId)).toEqual([three.userId]);
    const cleared = await lead.client.patch<TeamQueue>(`/v1/queues/${id}`, { memberIds: [] });
    expect(cleared.body.members).toEqual([]);

    expect((await lead.client.delete(`/v1/queues/${id}`)).status).toBe(204);
    expect((await lead.client.get(`/v1/queues/${id}`)).status).toBe(404);
    expect((await lead.client.delete(`/v1/queues/${id}`)).status).toBe(404);

    const audit = await pool().query<{ action: string }>(
      `SELECT action FROM audit_log WHERE target_id = $1 AND target_type = 'team_queue' AND outcome = 'success' ORDER BY created_at`,
      [id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      'queue.create',
      'queue.update',
      'queue.update',
      'queue.update',
      'queue.delete',
    ]);
  });

  it('refuses a duplicate name, a client or unknown user as member, and an empty edit', async () => {
    const name = unique('Unique queue');
    const queue = await apiQueue(lead, { name });
    expect((await lead.client.post('/v1/queues', { name })).status).toBe(409);

    const client = await signIn(h, 'client', (await apiOrg(lead)).id);
    for (const memberId of [client.userId, '00000000-0000-4000-8000-000000000001']) {
      expect(
        (
          await lead.client.post('/v1/queues', {
            name: unique('Bad member'),
            memberIds: [memberId],
          })
        ).status,
      ).toBe(400);
    }
    expect((await lead.client.patch(`/v1/queues/${queue.id}`, {})).status).toBe(400);
    expect((await lead.client.post('/v1/queues', { name: '   ' })).status).toBe(400);
  });

  it('sends the tickets of a deleted queue on without a queue', async () => {
    const queue = await apiQueue(lead, { name: unique('Short lived') });
    const orgId = (await apiOrg(lead)).id;
    const ticket = await fileTicket(agent, orgId, { queueId: queue.id });
    expect(ticket.queue?.id).toBe(queue.id);
    expect((await lead.client.delete(`/v1/queues/${queue.id}`)).status).toBe(204);
    const reread = await agent.client.get<TicketDetail>(`/v1/tickets/${ticket.id}`);
    expect(reread.body.queue).toBeNull();
  });
});
