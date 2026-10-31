import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0005 (T-010 security fixes): dev-login provenance, outbox expiry, per-IP break-glass
// lockout. `app` is the restricted login role the api runs as.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let testDb: TestDatabase;
let app: Pool;
const owner = () => testDb.owner.pool;

async function scalar<T>(pool: Pool, text: string, values: unknown[] = []): Promise<T> {
  const result = await pool.query<{ value: T }>(text, values);
  const row = result.rows[0];
  if (row === undefined) throw new Error('query returned no row');
  return row.value;
}

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 4 });
});

afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

describe('users.dev_created', () => {
  it('defaults to false, so a pre-existing account is never a dev-login account', async () => {
    const flag = await scalar<boolean>(
      app,
      `INSERT INTO users (email, name, role) VALUES ('plain@example.com', 'P', 'agent') RETURNING dev_created AS value`,
    );
    expect(flag).toBe(false);
  });
});

describe('break_glass_attempt', () => {
  it('is keyed by (account, ip) and writable by the application role', async () => {
    const user = await scalar<string>(
      owner(),
      `INSERT INTO users (email, name, role, is_break_glass, password_hash)
       VALUES ('bg@example.com', 'B', 'head', true, 'not-a-real-hash') RETURNING id AS value`,
    );
    await app.query(
      `INSERT INTO break_glass_attempt (user_id, ip, failed_count) VALUES ($1, '203.0.113.1', 1), ($1, '203.0.113.2', 2)`,
      [user],
    );
    await expect(
      app.query(`INSERT INTO break_glass_attempt (user_id, ip) VALUES ($1, '203.0.113.1')`, [user]),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      app.query(`UPDATE break_glass_attempt SET failed_count = -1 WHERE user_id = $1`, [user]),
    ).rejects.toMatchObject({ code: '23514' });
    // Deleting the account removes its counters.
    await owner().query('DELETE FROM users WHERE id = $1', [user]);
    expect(
      await scalar<string>(app, 'SELECT count(*)::text AS value FROM break_glass_attempt'),
    ).toBe('0');
  });
});

describe('outbox.expires_at', () => {
  it('is nullable, indexed for pending rows, and settable by the application role', async () => {
    await app.query(
      `INSERT INTO outbox (queue, job_name, job_id, payload, expires_at)
       VALUES ('email', 'send', 'expiring', '{}'::jsonb, now() + interval '15 minutes'),
              ('email', 'send', 'forever', '{}'::jsonb, NULL)`,
    );
    expect(
      await scalar<string>(
        app,
        `SELECT count(*)::text AS value FROM outbox WHERE expires_at IS NOT NULL`,
      ),
    ).toBe('1');
    expect(
      await scalar<string>(owner(), `SELECT to_regclass('outbox_expiry_idx')::text AS value`),
    ).toBe('outbox_expiry_idx');
  });
});

describe('reversibility of 0005', () => {
  it('drops its additions going down and restores them going up', async () => {
    const later = await migrationsAfter('0005_security');
    expect(await migrateDown(owner(), { steps: 1 + later.length })).toEqual([
      ...later.toReversed(),
      '0005_security',
    ]);
    expect(
      await scalar<string | null>(
        owner(),
        `SELECT to_regclass('break_glass_attempt')::text AS value`,
      ),
    ).toBeNull();
    const columns = await owner().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE (table_name = 'users' AND column_name = 'dev_created')
          OR (table_name = 'outbox' AND column_name = 'expires_at')`,
    );
    expect(columns.rowCount).toBe(0);

    expect(await migrateUp(owner())).toEqual(['0005_security', ...later]);
    expect(
      await scalar<string>(app, 'SELECT count(*)::text AS value FROM break_glass_attempt'),
    ).toBe('0');
  });
});

describe('migration 0005 on a database that already has pending email rows', () => {
  it('dead-letters plaintext email rows and releases the old account-wide break-glass lock', async () => {
    const later = await migrationsAfter('0005_security');
    expect(await migrateDown(owner(), { steps: 1 + later.length })).toEqual([
      ...later.toReversed(),
      '0005_security',
    ]);
    await owner().query('TRUNCATE outbox');
    await owner().query(
      `INSERT INTO outbox (queue, job_name, job_id, payload)
       VALUES ('email', 'send', 'legacy-plain', '{"link":"http://x/#token=abc"}'::jsonb),
              ('system', 'ping', 'other-queue', '{}'::jsonb)`,
    );
    await owner().query(
      `INSERT INTO users (email, name, role, is_break_glass, password_hash, failed_login_count, locked_until)
       VALUES ('locked-bg@example.com', 'L', 'head', true, 'not-a-real-hash', 5, now() + interval '1 hour')`,
    );
    expect(await migrateUp(owner())).toEqual(['0005_security', ...later]);

    const legacy = await owner().query<{ status: string; payload: unknown }>(
      `SELECT status, payload FROM outbox WHERE job_id = 'legacy-plain'`,
    );
    expect(legacy.rows[0]).toEqual({ status: 'dead', payload: {} });
    expect(
      await scalar<string>(
        owner(),
        `SELECT status AS value FROM outbox WHERE job_id = 'other-queue'`,
      ),
    ).toBe('pending');
    const released = await owner().query<{ failed_login_count: number; locked_until: Date | null }>(
      `SELECT failed_login_count, locked_until FROM users WHERE email = 'locked-bg@example.com'`,
    );
    expect(released.rows[0]).toEqual({ failed_login_count: 0, locked_until: null });
  });
});
