import { describe, expect, it } from 'vitest';

import { ConnectorQueryRejectedError } from '../common/errors.js';
import { FakeDataQueryClient } from './fake.js';
import {
  assertReadOnlySql,
  bindSqlTemplate,
  createSqlDataQueryClient,
  EXTERNAL_QUERY_ENABLED,
  withDataGuardrails,
} from './guard.js';
import { DATA_HARD_MAX_ROWS, type SqlExecutor } from './types.js';

describe('assertReadOnlySql', () => {
  it.each([
    'SELECT 1',
    'select day, count(*) AS n FROM jobs WHERE org_id = $1 GROUP BY day;',
    "WITH x AS (SELECT 1 AS a) SELECT a FROM x WHERE note <> 'drop table; delete'",
    '-- a comment\nSELECT 1 /* update */',
    'SELECT created_at, updated_at FROM jobs',
  ])('accepts %j', (sql) => {
    expect(() => {
      assertReadOnlySql(sql);
    }).not.toThrow();
  });

  it.each([
    ['a write', 'INSERT INTO jobs VALUES (1)'],
    ['an update inside a CTE', 'WITH x AS (UPDATE jobs SET a = 1 RETURNING a) SELECT a FROM x'],
    ['a second statement', 'SELECT 1; DROP TABLE jobs'],
    ['a SELECT INTO', 'SELECT * INTO copy FROM jobs'],
    ['a row lock', 'SELECT * FROM jobs FOR UPDATE'],
    ['EXTERNAL_QUERY (turned off)', "SELECT * FROM EXTERNAL_QUERY('conn', 'SELECT 1')"],
    ['pg_sleep', 'SELECT pg_sleep(100)'],
    ['set_config', "SELECT set_config('statement_timeout', '0', false)"],
    ['a dollar-quoted string', 'SELECT $$ x $$'],
    ['an unterminated string', "SELECT 'abc"],
    ['not a select', 'SHOW ALL'],
    ['an empty statement', ''],
    ['a statement that is too long', `SELECT ${'1,'.repeat(5000)}1`],
  ])('refuses %s', (_name, sql) => {
    expect(() => {
      assertReadOnlySql(sql);
    }).toThrow(ConnectorQueryRejectedError);
  });

  it('keeps EXTERNAL_QUERY off by a constant, not a setting', () => {
    expect(EXTERNAL_QUERY_ENABLED).toBe(false);
  });
});

describe('bindSqlTemplate', () => {
  it('turns placeholders into bind parameters and keeps the value out of the text', () => {
    const bound = bindSqlTemplate('SELECT * FROM t WHERE a = {{org_id}} AND b = {{org_id}} AND c = {{day}}', {
      org_id: 'org-1',
      day: '2026-01-01',
    });
    expect(bound.sql).toBe('SELECT * FROM t WHERE a = $1 AND b = $1 AND c = $2');
    expect(bound.values).toEqual(['org-1', '2026-01-01']);
  });

  it("refuses a value that is not plain text, as SQL injection would need", () => {
    expect(() => bindSqlTemplate('SELECT {{a}}', { a: "1'; DROP TABLE t; --" })).toThrow(ConnectorQueryRejectedError);
  });
});

describe('withDataGuardrails', () => {
  const answer = {
    columns: ['day', 'email', 'N'],
    rows: Array.from({ length: 5 }, (_v, i) => [`d${String(i)}`, `person${String(i)}@example.com`, i]),
  };
  const make = () => new FakeDataQueryClient({ q: answer });

  it('masks the columns that are not on the allow-list and says which', async () => {
    const client = withDataGuardrails(make(), { allowColumns: new Set(['day', 'n']) });
    const result = await client.query({ label: 'q', sql: 'SELECT 1', params: [], maxRows: 10, timeoutMs: 1000 });
    expect(result.masked).toEqual(['email']);
    expect(result.rows[0]).toEqual(['d0', null, 0]);
    expect(JSON.stringify(result.rows)).not.toContain('@example.com');
  });

  it('clamps the row cap to the hard maximum and cuts what an inner client returned past the cap', async () => {
    const inner = make();
    const client = withDataGuardrails(inner, { allowColumns: new Set(['day']), maxRows: 3 });
    const result = await client.query({ label: 'q', sql: 'SELECT 1', params: [], maxRows: 10_000, timeoutMs: 999_999 });
    expect(inner.queries[0]?.maxRows).toBe(3);
    expect(inner.queries[0]?.timeoutMs).toBeLessThanOrEqual(15_000);
    expect(result.rows).toHaveLength(3);
    expect(result.truncated).toBe(true);
    const wide = withDataGuardrails(make(), { allowColumns: new Set() });
    await wide.query({ label: 'q', sql: 'SELECT 1', params: [], maxRows: 10_000, timeoutMs: 1000 });
    expect(DATA_HARD_MAX_ROWS).toBe(500);
  });

  it('does not reach the client at all for a statement that is not a read, or for bind parameters that do not match', async () => {
    const inner = make();
    const client = withDataGuardrails(inner, { allowColumns: new Set(['day']) });
    await expect(
      client.query({ label: 'q', sql: 'DELETE FROM t', params: [], maxRows: 1, timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(ConnectorQueryRejectedError);
    await expect(
      client.query({ label: 'q', sql: 'SELECT $2', params: ['a'], maxRows: 1, timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(ConnectorQueryRejectedError);
    expect(inner.queries).toHaveLength(0);
  });
});

describe('createSqlDataQueryClient', () => {
  it('passes the statement, the binds and the limits to the executor and marks its source', async () => {
    const seen: unknown[] = [];
    const executor: SqlExecutor = {
      execute(input) {
        seen.push(input);
        return Promise.resolve({ columns: ['a'], rows: [[1]], truncated: false });
      },
    };
    const client = createSqlDataQueryClient(executor, 'sandbox');
    const result = await client.query({ label: 'x', sql: 'SELECT $1', params: ['v'], maxRows: 7, timeoutMs: 900 });
    expect(client.source).toBe('sandbox');
    expect(result).toEqual({ columns: ['a'], rows: [[1]], truncated: false, masked: [] });
    expect(seen).toEqual([{ sql: 'SELECT $1', params: ['v'], maxRows: 7, timeoutMs: 900, signal: undefined }]);
  });
});
