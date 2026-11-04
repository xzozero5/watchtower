import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0101 (T-305c): the weekly brief of the CEO view. One brief per slot, a draft that is edited, a published
// brief that is final, the model's text and the figures that never change, no delete for the application role.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const INSUFFICIENT_PRIVILEGE = '42501';
const UNDEFINED_TABLE = '42P01';

let testDb: TestDatabase;
let app: Pool;
const owner = () => testDb.owner.pool;

const code = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const insert = (over: Record<string, unknown> = {}) => {
  const row = {
    slot: '2026-11-09',
    status: 'draft',
    locale: 'en',
    source: 'ai',
    from: '2026-11-03T00:00:00Z',
    to: '2026-11-09T03:00:00Z',
    ...over,
  };
  return app.query(
    `INSERT INTO weekly_brief (slot_date, status, locale, source, period_from, period_to, figures, content, ai_content,
       published_at)
     VALUES ($1, $2, $3, $4, $5, $6, '{"a":1}', '{"summary":[]}', '{"summary":[]}', $7)`,
    [
      row.slot,
      row.status,
      row.locale,
      row.source,
      row.from,
      row.to,
      row.status === 'published' ? '2026-11-09T04:00:00Z' : null,
    ],
  );
};

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 3 });
});
afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

describe('weekly_brief', () => {
  it('lets the application role write a draft and read it', async () => {
    await insert();
    const rows = await app.query(`SELECT status, source, mock, recipients FROM weekly_brief`);
    expect(rows.rows).toEqual([{ status: 'draft', source: 'ai', mock: false, recipients: [] }]);
  });

  it('keeps one brief per slot', async () => {
    expect(await code(insert())).toBe(UNIQUE_VIOLATION);
    expect(await code(insert({ slot: '2026-11-16' }))).toBeUndefined();
  });

  it('rejects an unknown status, language or source, a backwards period, and a published row with no time', async () => {
    const day = (n: number) => `2026-12-0${String(n)}`;
    expect(await code(insert({ slot: day(1), status: 'sent' }))).toBe(CHECK_VIOLATION);
    expect(await code(insert({ slot: day(2), locale: 'fr' }))).toBe(CHECK_VIOLATION);
    expect(await code(insert({ slot: day(3), source: 'human' }))).toBe(CHECK_VIOLATION);
    expect(
      await code(
        insert({ slot: day(4), from: '2026-11-09T03:00:00Z', to: '2026-11-03T00:00:00Z' }),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await code(
        app.query(
          `INSERT INTO weekly_brief (slot_date, status, source, period_from, period_to, figures, content, ai_content)
           VALUES ('2026-12-05', 'published', 'ai', now() - interval '1 day', now(), '{}', '{}', '{}')`,
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('lets a draft be edited, but never the model text or the figures', async () => {
    expect(
      await code(
        app.query(
          `UPDATE weekly_brief SET content = '{"summary":[1]}' WHERE slot_date = '2026-11-16'`,
        ),
      ),
    ).toBeUndefined();
    expect(
      await code(
        app.query(`UPDATE weekly_brief SET ai_content = '{}' WHERE slot_date = '2026-11-16'`),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await code(
        app.query(`UPDATE weekly_brief SET figures = '{}' WHERE slot_date = '2026-11-16'`),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('makes a published brief final', async () => {
    await app.query(
      `UPDATE weekly_brief SET status = 'published', published_at = now() WHERE slot_date = '2026-11-16'`,
    );
    expect(
      await code(
        app.query(`UPDATE weekly_brief SET content = '{}' WHERE slot_date = '2026-11-16'`),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await code(
        app.query(
          `UPDATE weekly_brief SET status = 'draft', published_at = NULL WHERE slot_date = '2026-11-16'`,
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('never lets the application role delete', async () => {
    expect(await code(app.query(`DELETE FROM weekly_brief`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await code(app.query(`TRUNCATE weekly_brief`))).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe('0101 goes down and up again', () => {
  it('drops the table and the trigger and brings them back', async () => {
    const later = await migrationsAfter('0101_weekly_brief');
    const reverted = await migrateDown(owner(), { steps: later.length + 1 });
    expect(reverted[reverted.length - 1]).toBe('0101_weekly_brief');
    expect(await code(owner().query(`SELECT 1 FROM weekly_brief`))).toBe(UNDEFINED_TABLE);

    expect(await migrateUp(owner())).toEqual(['0101_weekly_brief', ...later]);
    expect((await owner().query(`SELECT 1 FROM weekly_brief`)).rowCount).toBe(0);
  });
});
