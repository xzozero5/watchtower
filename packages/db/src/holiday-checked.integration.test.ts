import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0009 (T-127): every holiday of a business calendar gets a check state, unchecked.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let testDb: TestDatabase;
const owner = () => testDb.owner.pool;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
});
afterAll(async () => {
  await testDb.cleanup();
});

const HOURS = JSON.stringify({ mon: [{ start: '09:00', end: '18:00' }] });

async function holidaysOf(name: string): Promise<unknown> {
  const { rows } = await owner().query<{ holidays: unknown }>(
    `SELECT holidays FROM business_calendar WHERE name = $1`,
    [name],
  );
  return rows[0]?.holidays;
}

describe('0009_holiday_checked', () => {
  it('writes an unchecked state into holidays that exist, keeps their order, and goes back', async () => {
    const later = await migrationsAfter('0009_holiday_checked');
    expect(await migrateDown(owner(), { steps: 1 + later.length })).toEqual([
      ...later.toReversed(),
      '0009_holiday_checked',
    ]);

    await owner().query(
      `INSERT INTO business_calendar (name, hours, holidays) VALUES
         ('with holidays', $1::jsonb,
          '[{"date":"2026-12-31","name":"New Year Eve"},{"date":"2026-01-01","name":"New Year"}]'::jsonb),
         ('empty', $1::jsonb, '[]'::jsonb)`,
      [HOURS],
    );

    expect(await migrateUp(owner())).toEqual(['0009_holiday_checked', ...later]);
    expect(await holidaysOf('with holidays')).toEqual([
      {
        date: '2026-12-31',
        name: 'New Year Eve',
        checked: false,
        checkedAt: null,
        checkedBy: null,
      },
      { date: '2026-01-01', name: 'New Year', checked: false, checkedAt: null, checkedBy: null },
    ]);
    expect(await holidaysOf('empty')).toEqual([]);

    // Someone checks a date, then the migration is reverted: the state is dropped, the data stays.
    await owner().query(
      `UPDATE business_calendar
          SET holidays = jsonb_set(holidays, '{0,checked}', 'true'::jsonb)
        WHERE name = 'with holidays'`,
    );
    await migrateDown(owner(), { steps: 1 + later.length });
    expect(await holidaysOf('with holidays')).toEqual([
      { date: '2026-12-31', name: 'New Year Eve' },
      { date: '2026-01-01', name: 'New Year' },
    ]);
    expect(await holidaysOf('empty')).toEqual([]);
    expect(await migrateUp(owner())).toEqual(['0009_holiday_checked', ...later]);
  });
});
