import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0010 (T-106d, ADR-008): ai_run (partitioned, append-only), ai_ticket_insight, ai_budget_event.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const INSUFFICIENT_PRIVILEGE = '42501';
const RESTRICT_VIOLATION = '23001';

let testDb: TestDatabase;
let app: Pool;
const owner = () => testDb.owner.pool;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 2 });
});
afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

const code = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const INSERT_RUN = `INSERT INTO ai_run
  (started_at, agent, provider, model, tier, prompt_id, prompt_version, prompt_hash, input_hmac, redaction, status)
  VALUES (now(), 'classifier', 'mock', 'mock-light', 'light', 'classifier', 1, repeat('a', 64), repeat('b', 64), '{"total":0,"byKind":{}}', 'ok')
  RETURNING id`;

describe('0010_ai_runs', () => {
  it('creates monthly partitions for the current month and a year ahead, plus a default', async () => {
    const { rows } = await owner().query<{ child: string }>(
      `SELECT c.relname AS child FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'ai_run' ORDER BY c.relname`,
    );
    const names = rows.map((row) => row.child);
    expect(names).toContain('ai_run_default');
    expect(names.filter((name) => /^ai_run_p\d{6}$/.test(name)).length).toBeGreaterThanOrEqual(13);
  });

  it('gives the application role INSERT and SELECT on ai_run and every partition, never UPDATE/DELETE/TRUNCATE', async () => {
    const { rows } = await owner().query<{ child: string; privilege_type: string }>(
      `SELECT g.table_name AS child, g.privilege_type
         FROM information_schema.role_table_grants g
        WHERE g.table_name LIKE 'ai_run%' AND g.grantee LIKE 'watchtower_app%'`,
    );
    for (const row of rows) {
      expect(['INSERT', 'SELECT'], `${row.child} ${row.privilege_type}`).toContain(
        row.privilege_type,
      );
    }
    const probe = await app.query(INSERT_RUN);
    const id = (probe.rows[0] as { id: string }).id;
    expect(await code(app.query(`UPDATE ai_run SET status = 'error' WHERE id = $1`, [id]))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await code(app.query(`DELETE FROM ai_run WHERE id = $1`, [id]))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await code(app.query(`TRUNCATE ai_run`))).toBe(INSUFFICIENT_PRIVILEGE);
    // A single month partition is protected too: the privileges and the trigger are per partition.
    const part = await owner().query<{ part: string }>(
      `SELECT tableoid::regclass::text AS part FROM ai_run WHERE id = $1`,
      [id],
    );
    const partition = part.rows[0]?.part ?? '';
    expect(partition).toMatch(/^ai_run_p\d{6}$/);
    expect(await code(app.query(`TRUNCATE ${partition}`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await code(owner().query(`TRUNCATE ${partition}`))).toBe(RESTRICT_VIOLATION);
  });

  it('lets a row far in the future fall into the default partition instead of failing', async () => {
    const result = await owner().query<{ part: string }>(
      `INSERT INTO ai_run (created_at, started_at, agent, provider, model, tier, prompt_id, prompt_version,
                           prompt_hash, input_hmac, redaction, status)
       VALUES ('2099-01-01', now(), 'classifier', 'mock', 'm', 'light', 'classifier', 1, repeat('a', 64),
               repeat('b', 64), '{}', 'ok')
       RETURNING tableoid::regclass::text AS part`,
    );
    expect(result.rows[0]?.part).toBe('ai_run_default');
  });

  it('lets the application role upsert ai_ticket_insight but not rewrite ai_budget_event', async () => {
    expect(await code(app.query(`UPDATE ai_ticket_insight SET state = 'none'`))).toBeUndefined();
    await owner().query(
      `INSERT INTO ai_budget_event (day, level, dimension, spent, cap) VALUES ('2026-11-01', 'alert', 'cost', 8, 10)`,
    );
    expect(await code(app.query(`UPDATE ai_budget_event SET spent = 0`))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await code(owner().query(`DELETE FROM ai_budget_event`))).toBe(RESTRICT_VIOLATION);
  });

  it('reverts and applies again', async () => {
    const later = await migrationsAfter('0010_ai_runs');
    expect(await migrateDown(owner(), { steps: 1 + later.length })).toEqual([
      ...later.toReversed(),
      '0010_ai_runs',
    ]);
    const gone = await owner().query(
      `SELECT to_regclass('ai_run') AS a, to_regclass('ai_ticket_insight') AS b, to_regclass('ai_budget_event') AS c`,
    );
    expect(gone.rows[0]).toEqual({ a: null, b: null, c: null });
    expect(await migrateUp(owner())).toEqual(['0010_ai_runs', ...later]);
    const back = await owner().query(`SELECT to_regclass('ai_run') AS a`);
    expect(back.rows[0]).toEqual({ a: 'ai_run' });
  });
});
