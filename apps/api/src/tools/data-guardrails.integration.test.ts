import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  bindSqlTemplate,
  ConnectorQueryRejectedError,
  ConnectorTimeoutError,
  createGuardedSqlClient,
  DATA_HARD_MAX_ROWS,
  type DataQueryClient,
} from '@watchtower/connectors';
import { createProductDbExecutor, type ProductDbExecutor } from '@watchtower/db';
import { createProductMockDatabase, type ProductMockDatabase } from '@watchtower/db/testing';
import { DATA_COLUMN_ALLOW_LIST } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
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
  ownerExecutor = createProductDbExecutor({ url: mock.ownerUrl });
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
    const bound = bindSqlTemplate(
      readFileSync(`${METRICS}webhook-failure-rate.sql`, 'utf8'),
      { tenant_id: 't-003' },
    );
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
      ownerExecutor.execute({ sql: `SELECT nextval('jobs_id_seq')`, params: [], maxRows: 1, timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: '25006' });
    const seen = await ownerExecutor.execute({ sql: `SELECT count(*)::int AS n FROM jobs`, params: [], maxRows: 1, timeoutMs: 1000 });
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
      executor.execute({ sql: `SELECT pg_sleep(3)`, params: [], maxRows: 1, timeoutMs: 200 }),
    ).rejects.toMatchObject({ code: '57014' });
    // Through the client the same limit is a typed error, and the heavy statement never runs past it.
    const started = Date.now();
    await expect(
      ask(`SELECT count(*) AS n FROM generate_series(1, 400000000) AS g (x) WHERE x % 7 = 0`, [], 10, 300),
    ).rejects.toBeInstanceOf(ConnectorTimeoutError);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('reads at most maxRows and says when there were more; the hard cap holds', async () => {
    const some = await ask(`SELECT day, requests FROM api_daily ORDER BY day, tenant_id`, [], 50);
    expect(some.rows).toHaveLength(50);
    expect(some.truncated).toBe(true);
    const all = await ask(`SELECT a.day, b.requests FROM api_daily a CROSS JOIN api_daily b`, [], 100_000);
    expect(all.rows).toHaveLength(DATA_HARD_MAX_ROWS);
    expect(all.truncated).toBe(true);
    const small = await ask(`SELECT id FROM tenants`, [], 100);
    expect(small.truncated).toBe(false);
  });

  it('uses bind parameters: a value that looks like SQL is only a value', async () => {
    const result = await ask(`SELECT day FROM api_daily WHERE tenant_id = $1`, [`t-001' OR '1'='1`]);
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
    const result = await wider.query({ label: 'x', sql: `SELECT id FROM tenants ORDER BY id`, params: [], maxRows: 10, timeoutMs: 1000 });
    expect(result.rows[0]).toEqual(['t-001']);
    expect(result.masked).toEqual([]);
    expect((await ask(`SELECT id FROM tenants`)).masked).toEqual(['id']);
  });
});

describe('statements that are not reads, and EXTERNAL_QUERY', () => {
  it.each([
    ['an insert', `INSERT INTO tenants (id, display_name, contact_email, plan, region) VALUES ('x','x','x','x','x')`],
    ['a delete', `DELETE FROM jobs`],
    ['a write inside a CTE', `WITH d AS (DELETE FROM jobs RETURNING id) SELECT id FROM d`],
    ['two statements', `SELECT 1; DELETE FROM jobs`],
    ['EXTERNAL_QUERY (off)', `SELECT * FROM EXTERNAL_QUERY('conn', 'SELECT 1')`],
    ['a function that sleeps', `SELECT pg_sleep(60)`],
    ['a setting change', `SELECT set_config('default_transaction_read_only', 'off', false)`],
  ])('refuses %s before the database sees it', async (_name, sql) => {
    await expect(ask(sql)).rejects.toBeInstanceOf(ConnectorQueryRejectedError);
  });

  it('left the data untouched', async () => {
    const counts = await ownerExecutor.execute({ sql: `SELECT (SELECT count(*) FROM jobs)::int AS j, (SELECT count(*) FROM tenants)::int AS t`, params: [], maxRows: 1, timeoutMs: 1000 });
    expect(counts.rows).toEqual([[200, 5]]);
  });
});
