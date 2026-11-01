import type { BusinessCalendarRecord } from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import { apiCalendar, signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';

// T-127 (H4): a check state per holiday. Holidays are [VERIFY] until a person compares each date
// with the official announcement; only the head's endpoint marks one, with who and when.

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let calendar: BusinessCalendarRecord;

const HOLIDAYS = [
  { date: '2026-12-31', name: 'New Year Eve' },
  { date: '2027-01-01', name: 'New Year' },
];

beforeAll(async () => {
  h = await startHarness();
  head = await signIn(h, 'head', undefined, 'Mana K.');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  calendar = await apiCalendar(head, {
    name: 'Holiday check calendar',
    timezone: 'Asia/Bangkok',
    holidays: HOLIDAYS,
  });
});
afterAll(async () => {
  await h.close();
});

const mark = (who: Persona, date: string, checked: boolean, id = calendar.id) =>
  who.client.patch<BusinessCalendarRecord & ApiErrorBody>(
    `/v1/business-calendars/${id}/holidays/${date}`,
    { checked },
  );

const stateOf = (record: BusinessCalendarRecord, date: string) =>
  record.holidays.find((holiday) => holiday.date === date);

describe('holiday check state', () => {
  it('starts unchecked for every holiday of a new calendar, and the list shows it', async () => {
    expect(calendar.holidays).toEqual([
      { ...HOLIDAYS[0], checked: false, checkedAt: null, checkedBy: null },
      { ...HOLIDAYS[1], checked: false, checkedAt: null, checkedBy: null },
    ]);
    const list = await lead.client.get<{ calendars: BusinessCalendarRecord[] }>(
      '/v1/business-calendars',
    );
    expect(list.body.calendars.find((row) => row.id === calendar.id)?.holidays[0]?.checked).toBe(
      false,
    );
  });

  it('is marked by the head with who and when, and audited', async () => {
    const before = Date.now();
    const response = await mark(head, '2026-12-31', true);
    expect(response.status).toBe(200);
    const done = stateOf(response.body, '2026-12-31');
    expect(done).toMatchObject({ checked: true, checkedBy: head.userId });
    expect(Date.parse(done?.checkedAt ?? '')).toBeGreaterThanOrEqual(before - 1000);
    expect(stateOf(response.body, '2027-01-01')?.checked).toBe(false);

    const audit = await h.db.owner.pool.query<{
      actor_id: string;
      target_id: string;
      outcome: string;
      metadata: { date: string; checked: boolean };
    }>(
      `SELECT actor_id, target_id, outcome, metadata FROM audit_log
        WHERE action = 'business_calendar.holiday_checked' AND target_id = $1`,
      [calendar.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_id: head.userId,
      outcome: 'success',
      metadata: { date: '2026-12-31', checked: true },
    });
  });

  it('can take the mark back', async () => {
    const response = await mark(head, '2026-12-31', false);
    expect(response.status).toBe(200);
    expect(stateOf(response.body, '2026-12-31')).toMatchObject({
      checked: false,
      checkedAt: null,
      checkedBy: null,
    });
  });

  it('is head only: a lead and an agent are refused and nothing changes', async () => {
    for (const who of [lead, agent]) {
      expect((await mark(who, '2026-12-31', true)).status).toBe(403);
    }
    const now = await head.client.get<BusinessCalendarRecord>(
      `/v1/business-calendars/${calendar.id}`,
    );
    expect(stateOf(now.body, '2026-12-31')?.checked).toBe(false);
    expect(
      (
        await h.client().patch(`/v1/business-calendars/${calendar.id}/holidays/2026-12-31`, {
          checked: true,
        })
      ).status,
    ).toBe(401);
  });

  it('answers 404 for an unknown calendar or date, and 400 for a bad date or body', async () => {
    expect((await mark(head, '2030-02-02', true)).status).toBe(404);
    expect(
      (await mark(head, '2026-12-31', true, '00000000-0000-4000-8000-000000000000')).status,
    ).toBe(404);
    expect((await mark(head, '31-12-2026', true)).status).toBe(400);
    expect(
      (
        await head.client.patch(`/v1/business-calendars/${calendar.id}/holidays/2026-12-31`, {
          checked: 'yes',
        })
      ).status,
    ).toBe(400);
  });

  it('keeps the mark of an unchanged holiday when the calendar is edited, resets a changed one', async () => {
    await mark(head, '2026-12-31', true);
    await mark(head, '2027-01-01', true);
    const edited = await head.client.patch<BusinessCalendarRecord>(
      `/v1/business-calendars/${calendar.id}`,
      {
        holidays: [
          // unchanged: stays checked
          { date: '2026-12-31', name: 'New Year Eve' },
          // renamed: someone has to look again
          { date: '2027-01-01', name: 'New Year Day' },
          // new, and the caller tries to claim it is checked
          { date: '2027-04-13', name: 'Songkran', checked: true, checkedBy: head.userId },
        ],
      },
    );
    expect(edited.status).toBe(200);
    expect(stateOf(edited.body, '2026-12-31')).toMatchObject({
      checked: true,
      checkedBy: head.userId,
    });
    expect(stateOf(edited.body, '2027-01-01')).toMatchObject({ checked: false, checkedBy: null });
    expect(stateOf(edited.body, '2027-04-13')).toMatchObject({
      checked: false,
      checkedAt: null,
      checkedBy: null,
    });
  });

  it('cannot be set by creating a calendar with checked holidays', async () => {
    const created = await apiCalendar(head, {
      name: 'Claims to be checked',
      holidays: [{ date: '2027-05-01', name: 'Labour Day', checked: true }],
    });
    expect(created.holidays[0]).toMatchObject({ checked: false, checkedBy: null });
  });

  it('reads rows written before the migration (no state keys) as unchecked', async () => {
    const old = await apiCalendar(head, { name: 'Old format calendar' });
    await h.db.owner.pool.query(
      `UPDATE business_calendar SET holidays = '[{"date":"2027-06-03","name":"Queen Birthday"}]'::jsonb WHERE id = $1`,
      [old.id],
    );
    const response = await head.client.get<BusinessCalendarRecord>(
      `/v1/business-calendars/${old.id}`,
    );
    expect(response.body.holidays).toEqual([
      {
        date: '2027-06-03',
        name: 'Queen Birthday',
        checked: false,
        checkedAt: null,
        checkedBy: null,
      },
    ]);
    const marked = await mark(head, '2027-06-03', true, old.id);
    expect(stateOf(marked.body, '2027-06-03')?.checked).toBe(true);
  });
});
