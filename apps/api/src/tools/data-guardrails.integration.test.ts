import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  assertReadOnlySql,
  bindSqlTemplate,
  ConnectorQueryRejectedError,
  ConnectorTimeoutError,
  createGuardedSqlClient,
  DATA_HARD_MAX_ROWS,
  type DataQueryClient,
} from '@watchtower/connectors';
import {
  createProductDbExecutor,
  PRODUCT_RESULT_HARD_BYTES,
  PRODUCT_RESULT_SOFT_BYTES,
  ProductDbError,
  type ProductDbExecutor,
} from '@watchtower/db';
import { createProductMockDatabase, type ProductMockDatabase } from '@watchtower/db/testing';
import { DATA_COLUMN_ALLOW_LIST } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// T-203c on a real, invented product database (`product_mock`, a database of its own on the compose
// Postgres): read-only transaction, statement_timeout, row cap, and the PII allow-list in two layers
// (the login's column grants, then the allow-list in code). Nothing but localhost is reached.
const net = disableNetConnect();
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const METRICS = fileURLToPath(new URL('../../../../examples/metrics/', import.meta.url));

let mock: ProductMockDatabase;
let executor: ProductDbExecutor;
let ownerExecutor: ProductDbExecutor;
let client: DataQueryClient;

const ask = (sql: string, params: (string | number)[] = [], maxRows = 100, timeoutMs = 5000) =>
  client.query({ label: 'test', sql, params, maxRows, timeoutMs });

beforeAll(async () => {
  mock = await createProductMockDatabase(adminUrl);
  executor = createProductDbExecutor({ url: mock.readOnlyUrl });
  // The owner may be anyone: it "runs as" itself, which is what lets the read-only transaction be tested alone.
  ownerExecutor = createProductDbExecutor({
    url: mock.ownerUrl,
    readerRole: decodeURIComponent(new URL(mock.ownerUrl).username),
  });
  client = createGuardedSqlClient(executor, { allowColumns: new Set(DATA_COLUMN_ALLOW_LIST) });
});
afterAll(async () => {
  await executor.close();
  await ownerExecutor.close();
  await mock.cleanup();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

describe('the mock product database', () => {
  it('is labelled sandbox, so its results are never taken for real data (N5)', () => {
    expect(executor.sandbox).toBe(true);
    expect(client.source).toBe('sandbox');
  });

  it('has the seed of examples/metrics, with the anomaly of tenant t-003 on its last two days', async () => {
    const counts = await ask(
      `SELECT (SELECT count(*) FROM api_daily)::int AS total, (SELECT count(*) FROM jobs)::int AS n`,
    );
    expect(counts.rows).toEqual([[450, 200]]);
    const bound = bindSqlTemplate(readFileSync(`${METRICS}webhook-failure-rate.sql`, 'utf8'), {
      tenant_id: 't-003',
    });
    const result = await client.query({
      label: 'webhook-failure-rate',
      sql: bound.sql,
      params: bound.values,
      maxRows: 30,
      timeoutMs: 5000,
    });
    expect(result.columns).toEqual(['day', 'event_type', 'requests', 'failed', 'ratio']);
    const ratio = result.rows.map((row) => Number(row[4]));
    // Newest first: the last two days are about a third; the rest stay near one or two percent.
    expect(ratio.slice(0, 2).every((value) => value >= 0.3)).toBe(true);
    expect(ratio.slice(2).every((value) => value <= 0.03)).toBe(true);
    // The same template for a tenant without the anomaly stays flat.
    const other = await client.query({
      label: 'webhook-failure-rate',
      sql: bound.sql,
      params: ['t-001'],
      maxRows: 30,
      timeoutMs: 5000,
    });
    expect(other.rows.every((row) => Number(row[4]) <= 0.03)).toBe(true);
  });
});

describe('read-only, timeout, row cap', () => {
  it('runs in a read-only transaction even for a login that could write', async () => {
    // The owner may write, but the executor opens READ ONLY: a function that writes is refused (25006).
    await expect(
      ownerExecutor.execute({
        sql: `SELECT nextval('jobs_id_seq')`,
        params: [],
        maxRows: 1,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ code: '25006' });
    const seen = await ownerExecutor.execute({
      sql: `SELECT count(*)::int AS n FROM jobs`,
      params: [],
      maxRows: 1,
      timeoutMs: 1000,
    });
    expect(seen.rows).toEqual([[200]]);
  });

  it('gives the read-only login no way to write at all', async () => {
    const error = await executor
      .execute({ sql: `SELECT nextval('jobs_id_seq')`, params: [], maxRows: 1, timeoutMs: 1000 })
      .catch((caught: unknown) => caught);
    expect(['25006', '42501']).toContain((error as { code?: string }).code);
  });

  it('stops a statement at statement_timeout and says so', async () => {
    await expect(
      executor.execute({
        sql: `SELECT count(*) FROM api_daily a CROSS JOIN api_daily b CROSS JOIN api_daily c CROSS JOIN api_daily d`,
        params: [],
        maxRows: 1,
        timeoutMs: 200,
      }),
    ).rejects.toMatchObject({ code: '57014' });
    // Through the client the same limit is a typed error, and the heavy statement never runs past it.
    const started = Date.now();
    await expect(
      ask(
        `SELECT count(*) AS n FROM api_daily a CROSS JOIN api_daily b CROSS JOIN api_daily c CROSS JOIN api_daily d`,
        [],
        10,
        300,
      ),
    ).rejects.toBeInstanceOf(ConnectorTimeoutError);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('reads at most maxRows and says when there were more; the hard cap holds', async () => {
    const some = await ask(`SELECT day, requests FROM api_daily ORDER BY day, tenant_id`, [], 50);
    expect(some.rows).toHaveLength(50);
    expect(some.truncated).toBe(true);
    const all = await ask(
      `SELECT a.day, b.requests FROM api_daily a CROSS JOIN api_daily b`,
      [],
      100_000,
    );
    expect(all.rows).toHaveLength(DATA_HARD_MAX_ROWS);
    expect(all.truncated).toBe(true);
    const small = await ask(`SELECT id FROM tenants`, [], 100);
    expect(small.truncated).toBe(false);
  });

  it('uses bind parameters: a value that looks like SQL is only a value', async () => {
    const result = await ask(`SELECT day FROM api_daily WHERE tenant_id = $1`, [
      `t-001' OR '1'='1`,
    ]);
    expect(result.rows).toEqual([]);
    const mine = await ask(`SELECT day FROM api_daily WHERE tenant_id = $1`, ['t-001'], 500);
    expect(mine.rows).toHaveLength(90);
  });
});

describe('the PII allow-list', () => {
  it('cannot be read at all: the login has no grant on the personal columns, however they are named', async () => {
    for (const sql of [
      `SELECT contact_email FROM tenants`,
      `SELECT display_name AS day FROM tenants`,
      `SELECT submitted_by AS status FROM jobs`,
      `SELECT * FROM tenants`,
      `SELECT t.contact_email AS requests FROM tenants t`,
    ]) {
      await expect(ask(sql), sql).rejects.toBeInstanceOf(ConnectorQueryRejectedError);
    }
  });

  it('masks a readable column that is not on the allow-list, and says which', async () => {
    const result = await ask(`SELECT id, plan, region FROM tenants ORDER BY id`);
    expect(result.columns).toEqual(['id', 'plan', 'region']);
    expect(result.masked).toEqual(['id']);
    expect(result.rows[0]).toEqual([null, 'standard', 'ap-southeast']);
    expect(JSON.stringify(result.rows)).not.toContain('t-00');
  });

  it('a template may allow more columns for itself, and only itself', async () => {
    const wider = createGuardedSqlClient(executor, {
      allowColumns: new Set([...DATA_COLUMN_ALLOW_LIST, 'id']),
    });
    const result = await wider.query({
      label: 'x',
      sql: `SELECT id FROM tenants ORDER BY id`,
      params: [],
      maxRows: 10,
      timeoutMs: 1000,
    });
    expect(result.rows[0]).toEqual(['t-001']);
    expect(result.masked).toEqual([]);
    expect((await ask(`SELECT id FROM tenants`)).masked).toEqual(['id']);
  });
});

describe('statements that are not reads, and EXTERNAL_QUERY', () => {
  it.each([
    [
      'an insert',
      `INSERT INTO tenants (id, display_name, contact_email, plan, region) VALUES ('x','x','x','x','x')`,
    ],
    ['a delete', `DELETE FROM jobs`],
    ['a write inside a CTE', `WITH d AS (DELETE FROM jobs RETURNING id) SELECT id FROM d`],
    ['two statements', `SELECT 1; DELETE FROM jobs`],
    ['EXTERNAL_QUERY (off)', `SELECT * FROM EXTERNAL_QUERY('conn', 'SELECT 1')`],
    ['a function that sleeps', `SELECT pg_sleep(60)`],
    ['a setting change', `SELECT set_config('default_transaction_read_only', 'off', false)`],
  ])('refuses %s before the database sees it', async (_name, sql) => {
    await expect(ask(sql)).rejects.toBeInstanceOf(ConnectorQueryRejectedError);
  });

  it('left the data untouched (before the hostile ones below)', async () => {
    const counts = await ownerExecutor.execute({
      sql: `SELECT (SELECT count(*) FROM jobs)::int AS j, (SELECT count(*) FROM tenants)::int AS t`,
      params: [],
      maxRows: 1,
      timeoutMs: 1000,
    });
    expect(counts.rows).toEqual([[200, 5]]);
  });
});

// P1 of the T-203 security review. A lead's statement used to get past the text check with `--x\r`,
// `E'\''`, `"'"` or a nested comment, and, sent by the simple protocol, `ROLLBACK; BEGIN READ WRITE;
// INSERT` ran. Nothing below depends on the text check: every payload goes straight to the executor
// (no guard in front) on a real Postgres, and then the database is asked whether anything changed.
describe('hostile statements (P1)', () => {
  const login = (): string => decodeURIComponent(new URL(mock.readOnlyUrl).username);
  const INSERT = `INSERT INTO tenants (id, display_name, contact_email, plan, region) VALUES ('pwned','x','x','x','x')`;

  const PAYLOADS: readonly (readonly [string, string])[] = [
    ['ROLLBACK; BEGIN READ WRITE; INSERT', `SELECT 1; ROLLBACK; BEGIN READ WRITE; ${INSERT}`],
    [
      'a line comment ended by a carriage return',
      `SELECT 1 --x\r; ROLLBACK; BEGIN READ WRITE; ${INSERT}`,
    ],
    ['a line comment ended by a carriage return and no space', `SELECT 1 --\r;${INSERT}`],
    ['an escaped quote in an E string', `SELECT E'\\'' ; ${INSERT}`],
    ['a quote as a quoted identifier', `SELECT 1 AS "'"; ${INSERT}`],
    ['a nested comment', `SELECT 1 /* a /* b */ c */ ; ${INSERT}`],
    ['a nested comment that closes early for a naive reader', `SELECT 1 /* /* */ */ ; ${INSERT}`],
    [
      'ALTER ROLE on itself after a SELECT',
      `SELECT 1; ALTER ROLE LOGIN_ROLE SET default_transaction_read_only = off`,
    ],
    ['ALTER ROLE on itself, alone', `ALTER ROLE LOGIN_ROLE SET statement_timeout = 0`],
    ['a temporary table', `CREATE TEMP TABLE pwn AS SELECT 1 AS x`],
    ['a temporary table after a SELECT', `SELECT 1; CREATE TEMP TABLE pwn (x int)`],
    ['a table in public', `CREATE TABLE public.pwn (x int)`],
    ['a data-modifying WITH', `WITH d AS (DELETE FROM jobs RETURNING id) SELECT id FROM d`],
    ['an INSERT as a WITH', `WITH i AS (${INSERT} RETURNING id) SELECT id FROM i`],
    ['SET LOCAL after a SELECT', `SELECT 1; SET LOCAL statement_timeout = 0`],
    ['set_config of the statement timeout', `SELECT set_config('statement_timeout', '0', true)`],
    ['set_config of the role', `SELECT set_config('role', 'none', true)`],
    ['set_config of the read-only flag', `SELECT set_config('transaction_read_only', 'off', true)`],
    ['pg_sleep', `SELECT pg_sleep(30)`],
    ['nextval', `SELECT nextval('jobs_id_seq')`],
    ['DO', `DO $x$ BEGIN DELETE FROM jobs; END $x$`],
    ['COPY to a program', `COPY (SELECT 1) TO PROGRAM 'echo pwned'`],
    ['a second DECLARE', `SELECT 1; DECLARE other CURSOR FOR SELECT 2`],
  ];

  /** The payloads that name the login get its real name. */
  const payloads = (): readonly (readonly [string, string])[] =>
    PAYLOADS.map(([name, sql]) => [name, sql.replace('LOGIN_ROLE', login())] as const);

  async function nothingChanged(): Promise<void> {
    // The owner looks: no row added or removed, no table, no role setting kept off.
    const state = await ownerExecutor.execute({
      sql: `SELECT (SELECT count(*) FROM tenants WHERE id = 'pwned')::int AS pwned,
                   (SELECT count(*) FROM jobs)::int AS jobs,
                   (SELECT count(*) FROM tenants)::int AS tenants,
                   (SELECT count(*) FROM pg_class WHERE relname = 'pwn')::int AS tables,
                   (SELECT count(*) FROM pg_roles WHERE rolname = $1
                      AND rolconfig::text LIKE '%default_transaction_read_only=on%'
                      AND rolconfig::text LIKE '%statement_timeout=15s%')::int AS settings_kept`,
      params: [login()],
      maxRows: 1,
      timeoutMs: 2000,
    });
    expect(state.rows).toEqual([[0, 200, 5, 0, 1]]);
  }

  it('refuses every payload at the database, whatever the text check would say, and nothing changed', async () => {
    for (const [name, sql] of payloads()) {
      const error = await executor
        .execute({ sql, params: [], maxRows: 10, timeoutMs: 2000 })
        .catch((caught: unknown) => caught);
      expect(error, name).toBeInstanceOf(Error);
      expect((error as { code?: string }).code, name).toMatch(/^[0-9A-Z]{5}$/);
    }
    await nothingChanged();
  });

  it('does nothing through the guarded client either', async () => {
    for (const [name, sql] of payloads()) {
      await expect(ask(sql), name).rejects.toBeInstanceOf(Error);
    }
    await nothingChanged();
  });

  it('runs every statement as the reader, read-only, with the limits we set', async () => {
    const who = await executor.execute({
      sql: `SELECT current_user::text, current_setting('transaction_read_only'), current_setting('statement_timeout'),
                   has_database_privilege(current_user, current_database(), 'TEMPORARY'),
                   has_schema_privilege(current_user, 'public', 'CREATE')`,
      params: [],
      maxRows: 1,
      timeoutMs: 2300,
    });
    expect(who.rows).toEqual([[`${login()}_reader`, 'on', '2300ms', false, false]]);
    // The login itself is NOINHERIT and owns nothing, and the pool still serves after all of the above.
    const meta = await ownerExecutor.execute({
      sql: `SELECT rolinherit, rolsuper, rolcreaterole, rolcreatedb, rolreplication,
                   (SELECT count(*) FROM pg_class c WHERE c.relowner = r.oid)::int
            FROM pg_roles r WHERE rolname = $1`,
      params: [login()],
      maxRows: 1,
      timeoutMs: 2000,
    });
    expect(meta.rows).toEqual([[false, false, false, false, false, 0]]);
  });

  it('applies the row cap while reading: a comment cannot cut it, and the server does not build the rest', async () => {
    const before = process.memoryUsage().rss;
    const started = Date.now();
    const result = await executor.execute({
      sql: `SELECT a.day, repeat('y', 200) AS filler FROM api_daily a CROSS JOIN api_daily b CROSS JOIN api_daily c -- cuts any LIMIT appended after it`,
      params: [],
      maxRows: 20,
      timeoutMs: 10_000,
    });
    expect(result.rows).toHaveLength(20);
    expect(result.truncated).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(process.memoryUsage().rss - before).toBeLessThan(100 * 1024 * 1024);
    // A block comment left open is a syntax error, not a way to swallow the rest.
    await expect(
      executor.execute({ sql: `SELECT 1 /* open`, params: [], maxRows: 1, timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: '42601' });
  });

  it('the text guard reads the payloads the way Postgres does, as a courtesy in front', () => {
    for (const [name, sql] of payloads()) {
      expect(() => {
        assertReadOnlySql(sql);
      }, name).toThrow(ConnectorQueryRejectedError);
    }
    // And does not refuse a harmless statement that carries the same marks.
    for (const fine of [
      `SELECT 'it''s' AS a -- a comment\r`,
      `SELECT E'\\'' AS a`,
      `SELECT 1 AS "it's" /* a /* nested */ comment */`,
    ]) {
      expect(() => {
        assertReadOnlySql(fine);
      }, fine).not.toThrow();
    }
  });
});

// Second review of the same task. A denylist of function names kept losing: `pg_advisory_lock` took the
// whole cluster to 53200 and held it until the pool closed, `pg_logical_emit_message` wrote 196 MB of WAL
// in a READ ONLY transaction, one `repeat()` cost the process 737 MB. So the database side now revokes by
// kind (every volatile pg_catalog function but a few, and whole families whatever their volatility), the
// role carries work_mem and temp_file_limit, and the executor caps the bytes it reads. Two groups of
// payloads, each shot at the executor with no guard in front.
describe('hostile statements, second group (side effects and size)', () => {
  const login = (): string => decodeURIComponent(new URL(mock.readOnlyUrl).username);

  const SIDE_EFFECTS: readonly (readonly [string, string])[] = [
    [
      'advisory locks, a hundred thousand of them',
      `SELECT pg_advisory_lock(g) FROM generate_series(1, 100000) AS g`,
    ],
    ['one advisory lock', `SELECT pg_advisory_lock(1)`],
    ['a try advisory lock', `SELECT pg_try_advisory_lock(1)`],
    ['a transaction advisory lock', `SELECT pg_advisory_xact_lock(1)`],
    ['a shared advisory lock', `SELECT pg_advisory_lock_shared(1)`],
    [
      'a logical WAL message of 100 MB',
      `SELECT pg_logical_emit_message(true, 'x', repeat('y', 100000000))`,
    ],
    ['a transactional logical WAL message', `SELECT pg_logical_emit_message(false, 'x', 'y')`],
    ['pg_notify', `SELECT pg_notify('c', 'x')`],
    ['lo_import', `SELECT lo_import('/etc/passwd')`],
    ['lo_create', `SELECT lo_create(0)`],
    ['pg_read_file', `SELECT pg_read_file('/etc/passwd')`],
    ['pg_ls_dir', `SELECT pg_ls_dir('.')`],
    ['txid_current', `SELECT txid_current()`],
    ['pg_terminate_backend', `SELECT pg_terminate_backend(pg_backend_pid())`],
    ['pg_cancel_backend', `SELECT pg_cancel_backend(pg_backend_pid())`],
    ['setval', `SELECT setval('jobs_id_seq', 1)`],
    ['dblink', `SELECT dblink('host=localhost', 'SELECT 1')`],
    ['a quoted dblink', `SELECT "dblink"('host=localhost', 'SELECT 1')`],
  ];

  async function locksAndWal(): Promise<{ locks: number; lsn: bigint }> {
    const state = await ownerExecutor.execute({
      sql: `SELECT (SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database()))::int,
                   (pg_current_wal_lsn() - '0/0'::pg_lsn)::text`,
      params: [],
      maxRows: 1,
      timeoutMs: 2000,
    });
    const [locks, lsn] = state.rows[0] ?? [];
    return { locks: Number(locks), lsn: BigInt(String(lsn).split('.')[0] ?? '0') };
  }

  it('refuses every side-effect function at the database: no lock, no WAL, nothing held', async () => {
    const before = await locksAndWal();
    for (const [name, sql] of SIDE_EFFECTS) {
      const error = await executor
        .execute({ sql, params: [], maxRows: 5, timeoutMs: 3000 })
        .catch((caught: unknown) => caught);
      expect(error, name).toBeInstanceOf(Error);
      // 42501: not allowed to execute. 42883: does not exist here (dblink is not installed).
      expect(['42501', '42883'], name).toContain((error as { code?: string }).code);
    }
    const after = await locksAndWal();
    expect(after.locks).toBe(0);
    // Other things write a little WAL; a refused 100 MB message would show as far more than this.
    // Other work on a shared server writes WAL too; the attack itself would add 100 MB.
    expect(after.lsn - before.lsn).toBeLessThan(50n * 1024n * 1024n);
    // And the same payloads never reach the database through the guarded client.
    for (const [name, sql] of SIDE_EFFECTS) {
      await expect(ask(sql), name).rejects.toBeInstanceOf(ConnectorQueryRejectedError);
    }
  });

  it('says what the reader may not do, and finds nothing wrong with this database', async () => {
    expect(await executor.hardeningProblems()).toEqual([]);
    // A login that is not hardened (here the owner, standing in for a replica whose owner allowed no revokes) is named.
    const problems = await ownerExecutor.hardeningProblems();
    expect(problems.length).toBeGreaterThanOrEqual(5);
    expect(problems).toContain('the reader can use advisory locks');
    expect(problems).toContain('the reader can use being a superuser');
  });

  it('T-207a C-4: a function made later is not executable by the reader, and the probe names an extension, a server-file role and a function it can run', async () => {
    const own = await createProductMockDatabase(adminUrl);
    const pool = new Pool({ connectionString: own.ownerUrl, max: 1 });
    const reader = createProductDbExecutor({ url: own.readOnlyUrl });
    const login = decodeURIComponent(new URL(own.readOnlyUrl).username);
    try {
      expect(await reader.hardeningProblems()).toEqual([]);
      // Default privileges: a helper created after the grants does not run for PUBLIC.
      await pool.query(
        `CREATE FUNCTION public.later_helper() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
      );
      const later = await pool.query<{ ok: boolean }>(
        `SELECT has_function_privilege($1, 'public.later_helper()', 'EXECUTE') AS ok`,
        [`${login}_reader`],
      );
      expect(later.rows[0]?.ok).toBe(false);
      // The probe still catches a function that was granted by hand.
      await pool.query(`GRANT EXECUTE ON FUNCTION public.later_helper() TO PUBLIC`);
      expect((await reader.hardeningProblems()).join('|')).toContain(
        'executing a function of a schema other than the system ones',
      );
      await pool.query(`REVOKE EXECUTE ON FUNCTION public.later_helper() FROM PUBLIC`);
      expect(await reader.hardeningProblems()).toEqual([]);
      // An extension that reads files from the server turns the probe on.
      await pool.query('CREATE EXTENSION file_fdw');
      expect((await reader.hardeningProblems()).join('|')).toContain('installed extension');
      await pool.query('DROP EXTENSION file_fdw');
      expect(await reader.hardeningProblems()).toEqual([]);
      // So does a role that reads the server's files.
      await pool.query(`GRANT pg_read_server_files TO "${login}_reader"`);
      expect((await reader.hardeningProblems()).join('|')).toContain(
        'reads or writes server files',
      );
      await pool.query(`REVOKE pg_read_server_files FROM "${login}_reader"`);
      expect(await reader.hardeningProblems()).toEqual([]);
    } finally {
      await reader.close();
      await pool.end();
      await own.cleanup();
    }
  });

  it('stops reading at a byte cap, drops the connection of a result that is far too big, and serves again', async () => {
    const before = process.memoryUsage().rss;
    const started = Date.now();
    // 100 MB in one value: the temporary file limit of the role answers before a byte is sent.
    const huge = await executor
      .execute({
        sql: `SELECT repeat('x', 100000000) AS v`,
        params: [],
        maxRows: 10,
        timeoutMs: 10_000,
      })
      .catch((caught: unknown) => caught);
    expect((huge as { code?: string }).code).toMatch(/^(53400|WT002)$/);
    // 30 MB in one row: the server can build it, we must not hold it.
    const error = await executor
      .execute({
        sql: `SELECT repeat('x', 30000000) AS v`,
        params: [],
        maxRows: 10,
        timeoutMs: 10_000,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProductDbError);
    expect((error as ProductDbError).code).toBe('WT002');
    expect(Date.now() - started).toBeLessThan(8000);
    expect(process.memoryUsage().rss - before).toBeLessThan(100 * 1024 * 1024);
    // A message from the client layer too: the typed error of the connector, nothing about the statement.
    await expect(ask(`SELECT repeat('x', 30000000) AS v`, [], 10, 10_000)).rejects.toThrow(
      /larger than the limit/,
    );
    // The pool is whole.
    expect(
      (await executor.execute({ sql: 'SELECT 1 AS n', params: [], maxRows: 1, timeoutMs: 1000 }))
        .rows,
    ).toEqual([[1]]);
  });

  it('stops at the soft cap with what it has when many wide rows come', async () => {
    const result = await executor.execute({
      sql: `SELECT repeat('x', 200000) AS v FROM generate_series(1, 500)`,
      params: [],
      maxRows: 500,
      timeoutMs: 10_000,
    });
    expect(result.truncated).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.length).toBeLessThanOrEqual(50);
    expect(PRODUCT_RESULT_SOFT_BYTES).toBeLessThan(PRODUCT_RESULT_HARD_BYTES);
  });

  it('holds a sort to the temporary file limit of the role', async () => {
    const error = await executor
      .execute({
        sql: `SELECT x FROM generate_series(1, 60000000) AS g (x) ORDER BY md5(x::text)`,
        params: [],
        maxRows: 5,
        timeoutMs: 15_000,
      })
      .catch((caught: unknown) => caught);
    expect((error as { code?: string }).code).toMatch(/^(53400|57014)$/);
    const limits = await ownerExecutor.execute({
      sql: `SELECT rolconfig::text FROM pg_roles WHERE rolname = $1`,
      params: [login()],
      maxRows: 1,
      timeoutMs: 2000,
    });
    expect(String(limits.rows[0]?.[0])).toContain('temp_file_limit=64MB');
    expect(String(limits.rows[0]?.[0])).toContain('work_mem=16MB');
  });
});
