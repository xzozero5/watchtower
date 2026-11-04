import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0091 (T-155, ADR-022): object_scan, the malware scan state of uploaded files.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const CHECK_VIOLATION = '23514';
const UNDEFINED_TABLE = '42P01';
const UNIQUE_VIOLATION = '23505';

let testDb: TestDatabase;
const owner = () => testDb.owner.pool;
const code = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
});
afterAll(async () => {
  await testDb.cleanup();
});

describe('0091 object_scan', () => {
  it('defaults a new file to pending and refuses unknown states and sources', async () => {
    const app = new Pool({ connectionString: testDb.appUrl, max: 1 });
    try {
      await app.query(`INSERT INTO object_scan (object_key, source) VALUES ('k/1', 'message')`);
      const row = await app.query<{ scan_status: string; attempts: number }>(
        `SELECT scan_status, attempts FROM object_scan WHERE object_key = 'k/1'`,
      );
      expect(row.rows[0]).toEqual({ scan_status: 'pending', attempts: 0 });
      expect(
        await code(
          app.query(`UPDATE object_scan SET scan_status = 'maybe' WHERE object_key = 'k/1'`),
        ),
      ).toBe(CHECK_VIOLATION);
      expect(
        await code(app.query(`INSERT INTO object_scan (object_key, source) VALUES ('k/2', 'web')`)),
      ).toBe(CHECK_VIOLATION);
      expect(
        await code(
          app.query(`INSERT INTO object_scan (object_key, source) VALUES ('k/1', 'message')`),
        ),
      ).toBe(UNIQUE_VIOLATION);
      // The application role moves a file through its states.
      await app.query(
        `UPDATE object_scan SET scan_status = 'clean', scanned_at = now() WHERE object_key = 'k/1'`,
      );
    } finally {
      await app.end();
    }
  });
});

describe('0091 goes down and up again', () => {
  it('drops the table and brings it back', async () => {
    const later = await migrationsAfter('0091_object_scan');
    const reverted = await migrateDown(owner(), { steps: later.length + 1 });
    expect(reverted[reverted.length - 1]).toBe('0091_object_scan');
    expect(await code(owner().query(`SELECT 1 FROM object_scan`))).toBe(UNDEFINED_TABLE);

    expect(await migrateUp(owner())).toEqual(['0091_object_scan', ...later]);
    expect((await owner().query(`SELECT 1 FROM object_scan`)).rowCount).toBe(0);
  });
});
