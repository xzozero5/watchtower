import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0099 (T-305b): data points of the pluggable CEO tiles. One row per (metric, instant); the CHECKs keep
// the key, the label, the unit and the source meaningful.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
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

const point = (over: Record<string, unknown> = {}) => {
  const row = {
    key: 'uptime',
    label: 'Platform uptime',
    unit: '%',
    source: 'api',
    value: 99.9,
    observed: '2026-11-01T00:00:00Z',
    ...over,
  };
  return app.query(
    `INSERT INTO ceo_external_point (metric_key, label, unit, source, value, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [row.key, row.label, row.unit, row.source, row.value, row.observed],
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

describe('ceo_external_point', () => {
  it('lets the application role record and read a point', async () => {
    await point();
    const rows = await app.query(
      `SELECT metric_key, value, higher_is_better FROM ceo_external_point`,
    );
    expect(rows.rows).toEqual([{ metric_key: 'uptime', value: 99.9, higher_is_better: true }]);
  });

  it('keeps one point per metric and instant', async () => {
    expect(await code(point())).toBe(UNIQUE_VIOLATION);
    expect(await code(point({ observed: '2026-11-02T00:00:00Z' }))).toBeUndefined();
  });

  it('rejects a bad key, an empty or long label, a long unit, an unknown source and an absurd value', async () => {
    const at = (n: number) => `2026-12-0${String(n)}T00:00:00Z`;
    expect(await code(point({ key: 'Bad Key', observed: at(1) }))).toBe(CHECK_VIOLATION);
    expect(await code(point({ label: '', observed: at(2) }))).toBe(CHECK_VIOLATION);
    expect(await code(point({ label: 'x'.repeat(81), observed: at(3) }))).toBe(CHECK_VIOLATION);
    expect(await code(point({ unit: 'x'.repeat(17), observed: at(4) }))).toBe(CHECK_VIOLATION);
    expect(await code(point({ source: 'manual', observed: at(5) }))).toBe(CHECK_VIOLATION);
    expect(await code(point({ value: 1e301, observed: at(6) }))).toBe(CHECK_VIOLATION);
  });
});

describe('0099 goes down and up again', () => {
  it('drops the table and brings it back', async () => {
    const later = await migrationsAfter('0099_ceo_external_point');
    const reverted = await migrateDown(owner(), { steps: later.length + 1 });
    expect(reverted[reverted.length - 1]).toBe('0099_ceo_external_point');
    expect(await code(owner().query(`SELECT 1 FROM ceo_external_point`))).toBe(UNDEFINED_TABLE);

    expect(await migrateUp(owner())).toEqual(['0099_ceo_external_point', ...later]);
    expect((await owner().query(`SELECT 1 FROM ceo_external_point`)).rowCount).toBe(0);
  });
});
