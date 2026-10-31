import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLES } from '@watchtower/shared';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from './client.js';
import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, type TestDatabase } from './testing.js';

// Migration 0001 (users, RBAC, sessions, audit log) against the real Postgres from docker compose,
// in a throwaway database. `app` below is the restricted login role the api runs as.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let testDb: TestDatabase;
let app: Pool;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 2 });
});

afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

const owner = () => testDb.owner.pool;

async function expectSqlState(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

const PRIVILEGE_ERROR = '42501';
const RESTRICT_VIOLATION = '23001';
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

describe('seed', () => {
  it('seeds exactly the permissions and role matrix defined in @watchtower/shared', async () => {
    const permissions = await owner().query<{ key: string; description: string }>(
      'SELECT key, description FROM permissions ORDER BY key',
    );
    expect(Object.fromEntries(permissions.rows.map((row) => [row.key, row.description]))).toEqual(
      PERMISSIONS,
    );

    const rows = await owner().query<{ role: string; permission: string }>(
      'SELECT role, permission FROM role_permissions',
    );
    for (const role of ROLES) {
      const fromDb = rows.rows.filter((row) => row.role === role).map((row) => row.permission);
      expect(fromDb.toSorted(), role).toEqual([...DEFAULT_ROLE_PERMISSIONS[role]].toSorted());
    }
  });
});

describe('users constraints', () => {
  const insert = (columns: string, values: unknown[]) =>
    owner().query(
      `INSERT INTO users (${columns}) VALUES (${values.map((_value, index) => `$${String(index + 1)}`).join(', ')})`,
      values,
    );

  it('requires an organization for a client and forbids one for staff', async () => {
    await expectSqlState(
      insert('email, name, role', ['client@example.com', 'C', 'client']),
      CHECK_VIOLATION,
    );
    await expectSqlState(
      insert('email, name, role, org_id', [
        'agent@example.com',
        'A',
        'agent',
        '00000000-0000-4000-8000-000000000001',
      ]),
      CHECK_VIOLATION,
    );
    await insert('email, name, role, org_id', [
      'client@example.com',
      'C',
      'client',
      '00000000-0000-4000-8000-000000000001',
    ]);
  });

  it('keeps one account per mailbox and stores normalized emails only', async () => {
    await expectSqlState(
      insert('email, name, role, org_id', [
        'client@example.com',
        'Again',
        'client',
        '00000000-0000-4000-8000-000000000002',
      ]),
      UNIQUE_VIOLATION,
    );
    await expectSqlState(
      insert('email, name, role', ['Mixed.Case@example.com', 'M', 'agent']),
      CHECK_VIOLATION,
    );
    await expectSqlState(
      insert('email, name, role', ['x@example.com', 'X', 'boss']),
      CHECK_VIOLATION,
    );
  });

  it('allows a password hash only on a break-glass head', async () => {
    await expectSqlState(
      insert('email, name, role, password_hash', ['p@example.com', 'P', 'agent', '$argon2id$x']),
      CHECK_VIOLATION,
    );
    await expectSqlState(
      insert('email, name, role, password_hash, is_break_glass', [
        'bg-agent@example.com',
        'B',
        'agent',
        '$argon2id$x',
        true,
      ]),
      CHECK_VIOLATION,
    );
    await insert('email, name, role, password_hash, is_break_glass', [
      'bg@example.com',
      'Break glass',
      'head',
      '$argon2id$x',
      true,
    ]);
  });
});

describe('application role privileges', () => {
  it('connects with the SCRAM verifier written by provisionAppRole', async () => {
    const result = await app.query<{ who: string }>('SELECT current_user AS who');
    expect(result.rows[0]?.who).toMatch(/^wt_app_/);
  });

  it('can read and write ordinary tables', async () => {
    await app.query(
      `INSERT INTO users (email, name, role) VALUES ('lead@example.com', 'Lead', 'lead')`,
    );
    await app.query(`UPDATE users SET name = 'Lead 2' WHERE email = 'lead@example.com'`);
    await app.query(`DELETE FROM users WHERE email = 'lead@example.com'`);
  });

  it('cannot change the schema', async () => {
    await expectSqlState(app.query('CREATE TABLE evil (id int)'), PRIVILEGE_ERROR);
    await expectSqlState(app.query('DROP TABLE users'), PRIVILEGE_ERROR);
    await expectSqlState(app.query('TRUNCATE users'), PRIVILEGE_ERROR);
  });
});

describe('audit_log', () => {
  const insertAudit = (pool: Pool, createdAt?: string) =>
    pool.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, created_at)
       VALUES ('user', 'u1', 'test.action', COALESCE($1::timestamptz, now())) RETURNING id`,
      [createdAt ?? null],
    );

  it('is partitioned by month with a default partition and twelve months ahead', async () => {
    const parts = await owner().query<{ name: string; bound: string }>(
      `SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
         FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'audit_log'::regclass ORDER BY c.relname`,
    );
    const names = parts.rows.map((row) => row.name);
    expect(names).toContain('audit_log_default');
    expect(parts.rows.find((row) => row.name === 'audit_log_default')?.bound).toBe('DEFAULT');
    // current month .. +12 months, plus the default partition
    expect(names).toHaveLength(14);
    const now = new Date();
    const current = `audit_log_p${String(now.getUTCFullYear())}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(names).toContain(current);
  });

  it('routes rows to the partition of their month and keeps strays in the default partition', async () => {
    const inserted = await insertAudit(app);
    const id = (inserted.rows[0] as { id: string }).id;
    const where = await owner().query<{ part: string }>(
      `SELECT tableoid::regclass::text AS part FROM audit_log WHERE id = $1`,
      [id],
    );
    expect(where.rows[0]?.part).toMatch(/^audit_log_p\d{6}$/);

    const stray = await insertAudit(app, '2001-01-01T00:00:00Z');
    const strayId = (stray.rows[0] as { id: string }).id;
    const strayWhere = await owner().query<{ part: string }>(
      `SELECT tableoid::regclass::text AS part FROM audit_log WHERE id = $1`,
      [strayId],
    );
    expect(strayWhere.rows[0]?.part).toBe('audit_log_default');
  });

  it('lets the application role INSERT and SELECT, nothing else', async () => {
    await insertAudit(app);
    const read = await app.query('SELECT count(*)::int AS n FROM audit_log');
    expect((read.rows[0] as { n: number }).n).toBeGreaterThan(0);
    await expectSqlState(app.query(`UPDATE audit_log SET action = 'tampered'`), PRIVILEGE_ERROR);
    await expectSqlState(app.query('DELETE FROM audit_log'), PRIVILEGE_ERROR);
    await expectSqlState(app.query('TRUNCATE audit_log'), PRIVILEGE_ERROR);
  });

  it('rejects UPDATE, DELETE and TRUNCATE even for the owner (trigger)', async () => {
    await expectSqlState(
      owner().query(`UPDATE audit_log SET action = 'tampered'`),
      RESTRICT_VIOLATION,
    );
    await expectSqlState(owner().query('DELETE FROM audit_log'), RESTRICT_VIOLATION);
    await expectSqlState(owner().query('TRUNCATE audit_log'), RESTRICT_VIOLATION);
    // Straight at a partition, past the parent.
    await expectSqlState(owner().query('TRUNCATE audit_log_default'), RESTRICT_VIOLATION);
    await expectSqlState(
      owner().query(`UPDATE audit_log_default SET action = 'tampered'`),
      RESTRICT_VIOLATION,
    );
    const stillThere = await owner().query(`SELECT 1 FROM audit_log WHERE action = 'test.action'`);
    expect(stillThere.rowCount).toBeGreaterThan(0);
  });

  it('guards every partition, not only the first ones', async () => {
    const parts = await owner().query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'audit_log'::regclass`,
    );
    const role =
      (await app.query<{ who: string }>('SELECT current_user AS who')).rows[0]?.who ?? '';
    for (const { name } of parts.rows) {
      for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE']) {
        const has = await owner().query<{ has: boolean }>(
          `SELECT has_table_privilege($1, $2::regclass, $3) AS has`,
          [role, name, privilege],
        );
        expect(has.rows[0]?.has, `${name} ${privilege}`).toBe(false);
      }
      const triggers = await owner().query<{ tgname: string }>(
        `SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal`,
        [name],
      );
      const kinds = triggers.rows.map((row) => row.tgname);
      expect(
        kinds.some((tgname) => tgname.includes('reject_truncate')),
        `${name} truncate`,
      ).toBe(true);
      expect(
        kinds.some((tgname) => tgname.includes('reject_update_delete')),
        `${name} row`,
      ).toBe(true);
    }
  });

  it('creates missing partitions idempotently, append-only, through the definer function', async () => {
    const first = await app.query<{ n: number }>(
      `SELECT ensure_monthly_partitions('audit_log', 14, true) AS n`,
    );
    expect(first.rows[0]?.n).toBe(2);
    const second = await app.query<{ n: number }>(
      `SELECT ensure_monthly_partitions('audit_log', 14, true) AS n`,
    );
    expect(second.rows[0]?.n).toBe(0);
    const role =
      (await app.query<{ who: string }>('SELECT current_user AS who')).rows[0]?.who ?? '';
    const newest = await owner().query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'audit_log'::regclass AND c.relname <> 'audit_log_default'
        ORDER BY c.relname DESC LIMIT 1`,
    );
    const has = await owner().query<{ has: boolean }>(
      `SELECT has_table_privilege($1, $2::regclass, 'DELETE') AS has`,
      [role, newest.rows[0]?.name],
    );
    expect(has.rows[0]?.has).toBe(false);
  });

  it('refuses to create partitions of anything that is not a partitioned public table', async () => {
    await expect(app.query(`SELECT ensure_monthly_partitions('users', 1)`)).rejects.toThrow(
      /not a partitioned table/,
    );
    await expect(app.query(`SELECT ensure_monthly_partitions('audit_log', 99)`)).rejects.toThrow(
      /between 0 and 36/,
    );
  });
});

describe('reversibility of 0001', () => {
  it('goes down (dropping every table it made, keeping 0000) and up again', async () => {
    const reverted = await migrateDown(owner());
    expect(reverted).toEqual(['0001_auth_rbac_audit']);
    const gone = await owner().query<{ name: string | null }>(
      `SELECT to_regclass('users')::text AS name UNION ALL SELECT to_regclass('audit_log')::text`,
    );
    expect(gone.rows.map((row) => row.name)).toEqual([null, null]);
    const extensions = await owner().query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
    expect(extensions.rowCount).toBe(1);

    expect(await migrateUp(owner())).toEqual(['0001_auth_rbac_audit']);
    const seeded = await owner().query<{ n: number }>('SELECT count(*)::int AS n FROM permissions');
    expect(seeded.rows[0]?.n).toBe(Object.keys(PERMISSIONS).length);
  });

  it('can be applied twice in two databases at once (the shared role is created once)', async () => {
    const [a, b] = await Promise.all([createTestDatabase(adminUrl), createTestDatabase(adminUrl)]);
    try {
      const probe = createDatabase({ url: a.appUrl, max: 1 });
      await probe.ping();
      await probe.close();
    } finally {
      await Promise.all([a.cleanup(), b.cleanup()]);
    }
  });
});
