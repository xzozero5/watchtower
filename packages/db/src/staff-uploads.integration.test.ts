import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0083: staff_upload and the attachments columns of shift_note and handoff.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const MIGRATION = '0083_staff_uploads';

let testDb: TestDatabase;
const owner = (): Pool => testDb.owner.pool;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
});

afterAll(async () => {
  await testDb.cleanup();
});

describe('0083 staff uploads', () => {
  it('stores a file once, refuses an empty one, and the app role cannot rewrite it', async () => {
    const user = await owner().query<{ id: string }>(
      `INSERT INTO users (email, name, role) VALUES ('up@example.com', 'Up', 'agent') RETURNING id`,
    );
    const userId = user.rows[0]?.id;
    await owner().query(
      `INSERT INTO staff_upload (uploader_id, object_key, filename, content_type, size, sha256)
       VALUES ($1, 'attachments/staff/k1', 'a.png', 'image/png', 3, 'abc')`,
      [userId],
    );
    await expect(
      owner().query(
        `INSERT INTO staff_upload (uploader_id, object_key, filename, content_type, size, sha256)
         VALUES ($1, 'attachments/staff/k2', 'b.png', 'image/png', 0, 'abc')`,
        [userId],
      ),
    ).rejects.toThrow(/staff_upload_size_check/);
    const app = new Pool({ connectionString: testDb.appUrl });
    try {
      await expect(app.query(`UPDATE staff_upload SET filename = 'x.png'`)).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await app.end();
    }
  });

  it('gives notes and handoffs an empty attachments array that must stay an array', async () => {
    const column = await owner().query<{ column_default: string }>(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'shift_note' AND column_name = 'attachments'`,
    );
    expect(column.rows[0]?.column_default).toContain("'[]'");
    const checks = await owner().query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conname IN ('shift_note_attachments_check', 'handoff_attachments_check')`,
    );
    expect(checks.rowCount).toBe(2);
  });

  it('goes down and comes up again', async () => {
    const later = await migrationsAfter(MIGRATION);
    if (later.length > 0) await migrateDown(owner(), { steps: later.length });
    expect(await migrateDown(owner())).toEqual([MIGRATION]);
    const gone = await owner().query(
      `SELECT 1 FROM information_schema.columns
        WHERE column_name = 'attachments' AND table_name IN ('shift_note', 'handoff')`,
    );
    expect(gone.rowCount).toBe(0);
    const table = await owner().query<{ t: string | null }>(
      `SELECT to_regclass('staff_upload')::text AS t`,
    );
    expect(table.rows[0]?.t).toBeNull();
    expect(await migrateUp(owner())).toEqual([MIGRATION, ...later]);
  });
});
