import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0102 (T-305e): the roster planner's drafts.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const CHECK_VIOLATION = '23514';
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
    status: 'draft',
    solver: 'complete',
    entries: '[]',
    explanation: null,
    locale: null,
    appliedAt: null,
    ...over,
  };
  return app.query(
    `INSERT INTO roster_plan (week_start, status, inputs, entries, solver_status, explanation,
       explanation_locale, applied_at)
     VALUES ('2026-11-02', $1, '{}'::jsonb, $2::jsonb, $3, $4, $5, $6)`,
    [row.status, row.entries, row.solver, row.explanation, row.locale, row.appliedAt],
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

describe('roster_plan', () => {
  it('lets the application role keep and read a draft', async () => {
    await insert();
    const rows = await app.query(`SELECT status, solver_status, entries FROM roster_plan`);
    expect(rows.rows).toEqual([{ status: 'draft', solver_status: 'complete', entries: [] }]);
  });

  it('rejects an unknown status or solver status, entries that are not a list, a half explanation', async () => {
    expect(await code(insert({ status: 'published' }))).toBe(CHECK_VIOLATION);
    expect(await code(insert({ solver: 'maybe' }))).toBe(CHECK_VIOLATION);
    expect(await code(insert({ entries: '{}' }))).toBe(CHECK_VIOLATION);
    expect(await code(insert({ explanation: 'text' }))).toBe(CHECK_VIOLATION);
    expect(await code(insert({ explanation: 'text', locale: 'fr' }))).toBe(CHECK_VIOLATION);
    expect(await code(insert({ explanation: 'text', locale: 'th' }))).toBeUndefined();
  });

  it('is applied exactly when it has an applied time', async () => {
    expect(await code(insert({ status: 'applied' }))).toBe(CHECK_VIOLATION);
    expect(await code(insert({ appliedAt: '2026-11-01T00:00:00Z' }))).toBe(CHECK_VIOLATION);
    expect(
      await code(insert({ status: 'applied', appliedAt: '2026-11-01T00:00:00Z' })),
    ).toBeUndefined();
  });
});

describe('0102 goes down and up again', () => {
  it('drops the table and brings it back', async () => {
    const later = await migrationsAfter('0102_roster_plan');
    const reverted = await migrateDown(owner(), { steps: later.length + 1 });
    expect(reverted[reverted.length - 1]).toBe('0102_roster_plan');
    expect(await code(owner().query(`SELECT 1 FROM roster_plan`))).toBe(UNDEFINED_TABLE);

    expect(await migrateUp(owner())).toEqual(['0102_roster_plan', ...later]);
    expect((await owner().query(`SELECT 1 FROM roster_plan`)).rowCount).toBe(0);
  });
});
