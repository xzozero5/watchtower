import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PG, isPgError } from './errors.js';
import { loadMigrations, migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// The notifications migration (T-105): what the table guarantees whatever the application does.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const INSUFFICIENT_PRIVILEGE = '42501';

let testDb: TestDatabase;
let app: Pool;
let userId: string;
let otherUserId: string;

const owner = (): Pool => testDb.owner.pool;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 2 });
  const users = await owner().query<{ id: string }>(
    `INSERT INTO users (email, name, role) VALUES ('a@example.test', 'A', 'agent'), ('b@example.test', 'B', 'agent') RETURNING id`,
  );
  userId = users.rows[0]?.id ?? '';
  otherUserId = users.rows[1]?.id ?? '';
});

afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

async function rejects(work: Promise<unknown>, code: string): Promise<void> {
  try {
    await work;
  } catch (error) {
    expect(isPgError(error, code), String(error)).toBe(true);
    return;
  }
  throw new Error(`expected Postgres error ${code}`);
}

let counter = 0;
const insert = (
  pool: Pool,
  user: string,
  fields: { kind?: string; severity?: string; data?: string } = {},
) => {
  counter += 1;
  return pool.query<{ id: string }>(
    `INSERT INTO notification (user_id, kind, severity, dedupe_key, data)
     VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb)) RETURNING id`,
    [
      user,
      fields.kind ?? 'ticket.assigned',
      fields.severity ?? 'normal',
      `k${String(counter)}`,
      fields.data ?? null,
    ],
  );
};

describe('notification', () => {
  it('starts unread with empty data', async () => {
    const row = await app.query<{ read_at: Date | null; data: unknown }>(
      `INSERT INTO notification (user_id, kind, severity, dedupe_key)
       VALUES ($1, 'ticket.p1', 'critical', 'first') RETURNING read_at, data`,
      [userId],
    );
    expect(row.rows[0]).toEqual({ read_at: null, data: {} });
  });

  it('makes the same alert once per person, and lets another person have it', async () => {
    await app.query(
      `INSERT INTO notification (user_id, kind, severity, dedupe_key) VALUES ($1, 'ticket.p1', 'critical', 'same')`,
      [userId],
    );
    await rejects(
      app.query(
        `INSERT INTO notification (user_id, kind, severity, dedupe_key) VALUES ($1, 'ticket.p1', 'critical', 'same')`,
        [userId],
      ),
      PG.uniqueViolation,
    );
    await app.query(
      `INSERT INTO notification (user_id, kind, severity, dedupe_key) VALUES ($1, 'ticket.p1', 'critical', 'same')`,
      [otherUserId],
    );
  });

  it('refuses an unknown kind and severity, and a data value that is not an object', async () => {
    await rejects(insert(app, userId, { kind: 'ticket.nope' }), PG.checkViolation);
    await rejects(
      insert(app, userId, { kind: 'ticket.p1', severity: 'urgent' }),
      PG.checkViolation,
    );
    await rejects(insert(app, userId, { data: '[]' }), PG.checkViolation);
  });

  it('lets the application change read_at and nothing else, and delete', async () => {
    const made = await insert(app, userId);
    const id = made.rows[0]?.id ?? '';
    const read = await app.query(`UPDATE notification SET read_at = now() WHERE id = $1`, [id]);
    expect(read.rowCount).toBe(1);
    await rejects(
      app.query(`UPDATE notification SET kind = 'ticket.p1' WHERE id = $1`, [id]),
      INSUFFICIENT_PRIVILEGE,
    );
    await rejects(
      app.query(`UPDATE notification SET user_id = $2 WHERE id = $1`, [id, otherUserId]),
      INSUFFICIENT_PRIVILEGE,
    );
    const gone = await app.query(`DELETE FROM notification WHERE id = $1`, [id]);
    expect(gone.rowCount).toBe(1);
  });

  it('goes away with its user', async () => {
    const temp = await owner().query<{ id: string }>(
      `INSERT INTO users (email, name, role) VALUES ('c@example.test', 'C', 'agent') RETURNING id`,
    );
    const id = temp.rows[0]?.id ?? '';
    await insert(app, id);
    await owner().query(`DELETE FROM users WHERE id = $1`, [id]);
    const left = await owner().query(`SELECT 1 FROM notification WHERE user_id = $1`, [id]);
    expect(left.rowCount).toBe(0);
  });
});

describe('notification_preference', () => {
  it('keeps one choice per person and kind', async () => {
    await app.query(
      `INSERT INTO notification_preference (user_id, kind, in_app) VALUES ($1, 'ticket.assigned', false)`,
      [userId],
    );
    await rejects(
      app.query(
        `INSERT INTO notification_preference (user_id, kind, in_app) VALUES ($1, 'ticket.assigned', true)`,
        [userId],
      ),
      PG.uniqueViolation,
    );
  });

  it('cannot turn P1 off', async () => {
    await rejects(
      app.query(
        `INSERT INTO notification_preference (user_id, kind, in_app) VALUES ($1, 'ticket.p1', false)`,
        [userId],
      ),
      PG.checkViolation,
    );
    await app.query(
      `INSERT INTO notification_preference (user_id, kind, in_app) VALUES ($1, 'ticket.p1', true)`,
      [userId],
    );
  });

  it('refuses an unknown kind', async () => {
    await rejects(
      app.query(`INSERT INTO notification_preference (user_id, kind) VALUES ($1, 'x')`, [userId]),
      PG.checkViolation,
    );
  });
});

describe('the migration is reversible', () => {
  it('drops both tables on the way down and brings them back up', async () => {
    const migrations = await loadMigrations();
    const mine = migrations.find((migration) => migration.id.includes('notifications'));
    expect(mine).toBeDefined();
    const exists = async (): Promise<number> =>
      (
        await owner().query(
          `SELECT 1 FROM information_schema.tables WHERE table_name IN ('notification', 'notification_preference')`,
        )
      ).rowCount ?? 0;
    expect(await exists()).toBe(2);
    // Later migrations (whatever number the main thread gives these) are undone first.
    const later = await migrationsAfter(mine?.id ?? '');
    await migrateDown(owner(), { steps: 1 + later.length });
    expect(await exists()).toBe(0);
    await migrateUp(owner());
    expect(await exists()).toBe(2);
  });
});
