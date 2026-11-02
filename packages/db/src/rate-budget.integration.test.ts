import { randomBytes } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0064 (T-203b): the shared rate window, ensure_monthly_partitions with updatable columns,
// and tool_execution partitioned by month.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';
const UNDEFINED_TABLE = '42P01';

let testDb: TestDatabase;
let app: Pool;
const owner = () => testDb.owner.pool;
const hash = (): string => randomBytes(32).toString('hex');

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
  app = new Pool({ connectionString: testDb.appUrl, max: 2 });
});
afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

const insertCall = (status = 'running', tool = 'kb_search') =>
  app.query<{ id: string }>(
    `INSERT INTO tool_execution (run_key, agent, tool, input_hash, status${status === 'running' ? '' : ', finished_at'})
     VALUES ('run', 'investigator', $1, $2, '${status}'${status === 'running' ? '' : ', now()'}) RETURNING id`,
    [tool, hash()],
  );

describe('0064 tool_execution is partitioned by month', () => {
  it('is a partitioned table with a default partition and the next months ready', async () => {
    const kind = await owner().query<{ relkind: string }>(
      `SELECT relkind FROM pg_class WHERE oid = 'tool_execution'::regclass`,
    );
    expect(kind.rows[0]?.relkind).toBe('p');
    const parts = await owner().query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'tool_execution'::regclass ORDER BY c.relname`,
    );
    expect(parts.rows.map((row) => row.name)).toContain('tool_execution_default');
    expect(parts.rows.length).toBeGreaterThanOrEqual(13);
  });

  it('keeps the rights of 0034 on every partition: closing columns only, no delete, no truncate', async () => {
    const { rows } = await insertCall();
    const id = rows[0]?.id;
    await app.query(
      `UPDATE tool_execution SET status = 'ok', finished_at = now(), latency_ms = 3, result_count = 2 WHERE id = $1`,
      [id],
    );
    expect(await code(app.query(`UPDATE tool_execution SET tool = 'other' WHERE id = $1`, [id]))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await code(app.query(`DELETE FROM tool_execution WHERE id = $1`, [id]))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await code(app.query(`TRUNCATE tool_execution`))).toBe(INSUFFICIENT_PRIVILEGE);

    // The partition itself is no way round it.
    const month = await owner().query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'tool_execution'::regclass AND c.relname <> 'tool_execution_default'
        ORDER BY c.relname LIMIT 1`,
    );
    const partition = month.rows[0]?.name ?? '';
    expect(await code(app.query(`UPDATE ${partition} SET tool = 'other'`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await code(app.query(`DELETE FROM ${partition}`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await code(app.query(`TRUNCATE ${partition}`))).toBe(INSUFFICIENT_PRIVILEGE);
    const role = new URL(testDb.appUrl).username;
    const grants = await owner().query<{ column_name: string }>(
      `SELECT a.attname AS column_name FROM pg_attribute a
        WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
          AND has_column_privilege($2, $1::regclass, a.attname, 'UPDATE')
        ORDER BY a.attname`,
      [partition, role],
    );
    expect(grants.rows.map((row) => row.column_name)).toEqual([
      'error_code',
      'finished_at',
      'latency_ms',
      'result_count',
      'status',
    ]);
  });

  it('keeps its checks', async () => {
    expect(await code(insertCall('running', 'Bad Name'))).toBe(CHECK_VIOLATION);
    expect(
      await code(
        app.query(
          `INSERT INTO tool_execution (run_key, agent, tool, input_hash, status) VALUES ('r','a','kb_search','nope','running')`,
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('creates the next months through the definer function, still with the closing columns writable', async () => {
    const created = await app.query<{ n: number }>(
      `SELECT ensure_monthly_partitions('tool_execution', 14, true,
         ARRAY['status', 'error_code', 'finished_at', 'latency_ms', 'result_count']) AS n`,
    );
    expect(created.rows[0]?.n).toBe(2);
    const again = await app.query<{ n: number }>(
      `SELECT ensure_monthly_partitions('tool_execution', 14, true,
         ARRAY['status', 'error_code', 'finished_at', 'latency_ms', 'result_count']) AS n`,
    );
    expect(again.rows[0]?.n).toBe(0);
    // The three-argument call of the other tables still works (the fourth argument has a default).
    const old = await app.query<{ n: number }>(`SELECT ensure_monthly_partitions('audit_log', 1, true) AS n`);
    expect(old.rows[0]?.n).toBe(0);
    await expect(
      app.query(`SELECT ensure_monthly_partitions('tool_execution', 15, true, ARRAY['nope'])`),
    ).rejects.toThrow(/column "nope"/);
  });
});

describe('0064 rate_budget_window', () => {
  it('holds counts per resource and second, and refuses nonsense', async () => {
    await app.query(
      `INSERT INTO rate_budget_window (resource, slot, total, ai) VALUES ('logging:default', date_trunc('second', now()), 3, 2)`,
    );
    expect(
      await code(
        app.query(
          `INSERT INTO rate_budget_window (resource, slot, total, ai) VALUES ('logging:default', now() - interval '1 hour', 1, 2)`,
        ),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await code(
        app.query(
          `INSERT INTO rate_budget_window (resource, slot, total, ai) VALUES ('Not A Resource', now(), 1, 0)`,
        ),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await code(
        app.query(
          `INSERT INTO rate_budget_window (resource, slot, total, ai) VALUES ('logging:default', date_trunc('second', now()), 1, 0)`,
        ),
      ),
    ).toBe('23505');
  });
});

describe('0064 goes down and up again', () => {
  it('keeps the tool_execution rows both ways and drops the window', async () => {
    const before = await insertCall('ok', 'gcp_logs');
    const id = before.rows[0]?.id;
    const later = await migrationsAfter('0064_rate_budget');
    const reverted = await migrateDown(owner(), { steps: later.length + 1 });
    expect(reverted[reverted.length - 1]).toBe('0064_rate_budget');
    const plain = await owner().query<{ relkind: string }>(
      `SELECT relkind FROM pg_class WHERE oid = 'tool_execution'::regclass`,
    );
    expect(plain.rows[0]?.relkind).toBe('r');
    expect((await owner().query(`SELECT 1 FROM tool_execution WHERE id = $1`, [id])).rowCount).toBe(1);
    expect(await code(owner().query(`SELECT 1 FROM rate_budget_window`))).toBe(UNDEFINED_TABLE);
    // The three-argument helper is back, the four-argument one gone.
    const functions = await owner().query<{ args: string }>(
      `SELECT pg_get_function_identity_arguments(oid) AS args FROM pg_proc WHERE proname = 'ensure_monthly_partitions'`,
    );
    expect(functions.rows.map((row) => row.args)).toEqual(['parent regclass, months_ahead integer, append_only boolean']);

    expect(await migrateUp(owner())).toEqual(['0064_rate_budget', ...later]);
    const partitioned = await owner().query<{ relkind: string }>(
      `SELECT relkind FROM pg_class WHERE oid = 'tool_execution'::regclass`,
    );
    expect(partitioned.rows[0]?.relkind).toBe('p');
    expect((await owner().query(`SELECT 1 FROM tool_execution WHERE id = $1`, [id])).rowCount).toBe(1);
    expect((await owner().query(`SELECT 1 FROM rate_budget_window`)).rowCount).toBe(0);
  });
});
