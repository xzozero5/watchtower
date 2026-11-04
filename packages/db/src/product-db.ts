import type { Socket } from 'node:net';

import { Pool, type PoolClient, type QueryConfig } from 'pg';

/**
 * The database side of the data tool (T-203c, R-5.2, N2): runs one statement of a saved template or
 * of a lead's own against the *product* database, which is not the Watchtower database.
 *
 * The statement is text a person wrote, so nothing here trusts it to be harmless. What keeps it
 * read-only does not depend on reading it:
 *
 *  1. **One statement, always.** Every query goes by the extended protocol (`queryMode: 'extended'`),
 *     which the server refuses to parse as more than one command. `ROLLBACK; BEGIN READ WRITE; ...`
 *     is a syntax error, not a way out of the transaction.
 *  2. **A cursor, not a wrapper.** The statement is `DECLARE ... CURSOR FOR <statement>`, so only a
 *     `SELECT` is accepted (the server rejects a data-modifying `WITH` in a cursor), a trailing `--`
 *     comment cannot swallow anything we append, and `FETCH` reads at most `maxRows + 1` rows: the
 *     cap is enforced while reading, not after the server has built the whole result.
 *  3. **A `READ ONLY` transaction** with `statement_timeout` and `lock_timeout` set by us for that
 *     transaction, and, at connection start, read-only and time limits as session defaults.
 *  4. **A role that can do nothing else.** The login role is `NOINHERIT`, owns nothing and has no
 *     rights of its own; inside the transaction we `SET LOCAL ROLE` to a group role that holds the
 *     column-level `SELECT` grants and nothing more (no temporary tables, nothing created, no
 *     `set_config`, no `pg_sleep`: `examples/metrics/product-mock.grants.sql`). A role can always
 *     change its own defaults, so the one that runs the statement is not the one that can.
 *
 * Which statements are worth asking at all, and the column allow-list, belong to
 * `@watchtower/connectors` (`withDataGuardrails`), which sits in front of this and does not know pg.
 */

export type ProductValue = string | number | boolean | null;

export interface ProductQueryInput {
  /** One statement with `$1..$n` bind parameters. */
  readonly sql: string;
  readonly params: readonly ProductValue[];
  readonly maxRows: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

export interface ProductQueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly ProductValue[])[];
  readonly truncated: boolean;
}

export interface ProductDbExecutor {
  execute(input: ProductQueryInput): Promise<ProductQueryResult>;
  /** True when the database is the invented `product_mock` one (results are labelled mock). */
  readonly sandbox: boolean;
  /**
   * What the reader role can do that it must not (advisory locks, WAL messages, set_config, sleeps,
   * sequences, temporary tables, creating objects, being a superuser). Empty when the database was
   * hardened with `examples/metrics/product-mock.grants.sql`. Ad-hoc statements are refused while it is not.
   */
  hardeningProblems(): Promise<string[]>;
  close(): Promise<void>;
}

export interface ProductDbOptions {
  readonly url: string;
  /**
   * The role the statement runs as (`SET LOCAL ROLE`). Default: the login's name plus `_reader`, the
   * convention of `product-mock.grants.sql`. It must exist and the login must be a member of it.
   */
  readonly readerRole?: string;
  /** Connections kept for the tool. Default 2: it is a human or a single AI step at a time. */
  readonly max?: number;
  readonly applicationName?: string;
}

/** A database named `product_mock` (or `wt_pm_*` in tests) holds invented data. `[ASSUMED]` naming convention. */
export function isSandboxDatabase(url: string): boolean {
  try {
    const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
    return name === 'product_mock' || name.startsWith('wt_pm_');
  } catch {
    return false;
  }
}

function plain(value: unknown): ProductValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return JSON.stringify(value);
}

const ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const quoteRole = (name: string): string => `"${name}"`;

/**
 * Bytes a result may carry. Past the soft cap the executor stops reading and says `truncated`; past the
 * hard cap it drops the connection, because one row can be as large as the server can build (a
 * `repeat('x', 700000000)` is one row) and nothing else would stop it from filling our memory.
 */
export const PRODUCT_RESULT_SOFT_BYTES = 1_000_000;
export const PRODUCT_RESULT_HARD_BYTES = 16_000_000;
/** Rows asked of the cursor at a time, so the soft cap is checked often. */
const FETCH_BATCH = 25;

/** Errors of the executor itself (not the database's): `code` is stable for the layer above. */
export class ProductDbError extends Error {
  readonly code: 'WT002';
  constructor(code: 'WT002', message: string) {
    super(message);
    this.name = 'ProductDbError';
    this.code = code;
  }
}

/** The extended protocol only: one command per query, whatever the text holds. */
const extended = (config: { text: string; values?: unknown[]; rowMode?: 'array' }): QueryConfig =>
  ({ ...config, queryMode: 'extended' }) as QueryConfig;

/** The socket of a pg client, which the type does not show. */
function socketOf(client: PoolClient): Socket | undefined {
  return (client as unknown as { connection?: { stream?: Socket } }).connection?.stream;
}

/**
 * Extensions that reach the network, read or write files on the server or run code outside the database
 * (T-207a C-4). One of them installed in the product database is enough to turn ad-hoc statements off,
 * whatever the grants say: a later grant or a function we did not list would be a way out.
 */
export const DANGEROUS_EXTENSIONS: readonly string[] = [
  'http',
  'pgsql_http',
  'pg_net',
  'postgres_fdw',
  'file_fdw',
  'dblink',
  'oracle_fdw',
  'mysql_fdw',
  'mongo_fdw',
  'plpython3u',
  'plpython2u',
  'plpythonu',
  'plperlu',
  'pltclu',
  'plsh',
  'adminpack',
  'pg_cron',
  'aws_s3',
  'azure_storage',
];

/** Roles that read or write the server's files, run programs or read every table (T-207a C-4). */
export const DANGEROUS_ROLES: readonly string[] = [
  'pg_read_server_files',
  'pg_write_server_files',
  'pg_execute_server_program',
  'pg_read_all_data',
  'pg_write_all_data',
];

const sqlList = (values: readonly string[]): string =>
  values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', ');

/** What the reader must not be able to do. Each probe is one thing the reviews found a statement doing. */
const HARDENING_PROBES: readonly (readonly [string, string])[] = [
  ['advisory locks', `has_function_privilege(current_user, 'pg_advisory_lock(bigint)', 'EXECUTE')`],
  [
    'logical messages (WAL)',
    `has_function_privilege(current_user, 'pg_logical_emit_message(boolean,text,text)', 'EXECUTE')`,
  ],
  [
    'set_config',
    `has_function_privilege(current_user, 'set_config(text,text,boolean)', 'EXECUTE')`,
  ],
  ['pg_sleep', `has_function_privilege(current_user, 'pg_sleep(double precision)', 'EXECUTE')`],
  ['sequences', `has_function_privilege(current_user, 'nextval(regclass)', 'EXECUTE')`],
  [
    'backend control',
    `has_function_privilege(current_user, 'pg_terminate_backend(integer,bigint)', 'EXECUTE')`,
  ],
  ['temporary tables', `has_database_privilege(current_user, current_database(), 'TEMPORARY')`],
  ['creating objects in public', `has_schema_privilege(current_user, 'public', 'CREATE')`],
  ['being a superuser', `(SELECT rolsuper FROM pg_roles WHERE rolname = current_user)`],
  [
    'an installed extension that reaches the network, the server files or other code',
    `EXISTS (SELECT 1 FROM pg_extension WHERE extname IN (${sqlList(DANGEROUS_EXTENSIONS)}))`,
  ],
  [
    'a role that reads or writes server files, runs programs or reads every table',
    `EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN (${sqlList(DANGEROUS_ROLES)}) AND (pg_has_role(current_user, oid, 'MEMBER') OR pg_has_role(session_user, oid, 'MEMBER')))`,
  ],
  [
    'executing a function of a schema other than the system ones',
    `EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND has_function_privilege(current_user, p.oid, 'EXECUTE'))`,
  ],
];

export function createProductDbExecutor(options: ProductDbOptions): ProductDbExecutor {
  const login = decodeURIComponent(new URL(options.url).username);
  const readerRole = options.readerRole ?? `${login}_reader`;
  if (!ROLE_NAME.test(readerRole)) {
    throw new Error(
      'The product database login has a name that cannot be turned into a reader role',
    );
  }
  const pool = new Pool({
    connectionString: options.url,
    max: options.max ?? 2,
    application_name: options.applicationName ?? 'watchtower-product-readonly',
    // A hung network read must not hold a connection for ever.
    connectionTimeoutMillis: 5000,
    // Session defaults from the first byte: read-only, and time limits a role setting cannot loosen.
    options:
      '-c default_transaction_read_only=on -c statement_timeout=15000 -c idle_in_transaction_session_timeout=30000',
  });
  // A pool error on an idle client (the server went away) must not crash the process.
  pool.on('error', () => undefined);

  /** Runs `work` in a READ ONLY transaction as the reader, with the limits, and always gives the connection back clean. */
  async function asReader<T>(
    timeoutMs: number,
    work: (client: PoolClient, bytes: () => number) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    const socket = socketOf(client);
    let received = 0;
    const state = { overflow: false, broken: false };
    const onData = (chunk: Buffer): void => {
      received += chunk.length;
      if (received > PRODUCT_RESULT_HARD_BYTES && !state.overflow) {
        state.overflow = true;
        // Stop reading at once: what the server still sends is never buffered here.
        socket?.destroy();
      }
    };
    socket?.on('data', onData);
    // A connection we drop on purpose (or the server drops) must not become an unhandled 'error' event.
    const onError = (): void => undefined;
    client.on('error', onError);
    try {
      // Our own fixed strings, simple protocol: no caller text in any of them.
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${String(timeoutMs)}`);
      await client.query(`SET LOCAL lock_timeout = ${String(Math.min(timeoutMs, 2000))}`);
      await client.query(`SET LOCAL ROLE ${quoteRole(readerRole)}`);
      return await work(client, () => received);
    } catch (error) {
      if (state.overflow) {
        throw new ProductDbError('WT002', 'The result is larger than the limit');
      }
      throw error;
    } finally {
      socket?.off('data', onData);
      // Back to the pool only if the session ended clean; otherwise the connection is dropped. DISCARD ALL
      // forgets any session state a statement might have left (locks, temporary objects, a changed role).
      try {
        await client.query('ROLLBACK');
        await client.query('DISCARD ALL');
      } catch {
        state.broken = true;
      }
      client.release(state.broken || state.overflow ? true : undefined);
      // A client that goes back to the pool is clean; one that is discarded may still say something as it dies.
      if (!state.broken && !state.overflow) client.off('error', onError);
    }
  }

  return {
    sandbox: isSandboxDatabase(options.url),
    async execute(input) {
      if (input.signal?.aborted === true) throw new Error('aborted');
      const maxRows = Math.max(1, Math.min(Math.trunc(input.maxRows), 10_000));
      const timeoutMs = Math.max(100, Math.min(Math.trunc(input.timeoutMs), 60_000));
      const statement = input.sql.trim().replace(/;\s*$/, '');
      return asReader(timeoutMs, async (client, bytes) => {
        // The caller's text appears once, as the body of a cursor, in a query the server parses as one command.
        await client.query(
          extended({
            text: `DECLARE watchtower_cursor NO SCROLL CURSOR WITHOUT HOLD FOR ${statement}`,
            values: [...input.params],
          }),
        );
        const columns: string[] = [];
        const rows: ProductValue[][] = [];
        let truncated = false;
        for (;;) {
          // Never more rows than are still wanted, plus one to learn whether there were more.
          const want = Math.min(FETCH_BATCH, maxRows + 1 - rows.length);
          const result = await client.query(
            extended({
              text: `FETCH FORWARD ${String(want)} FROM watchtower_cursor`,
              rowMode: 'array',
            }),
          );
          columns.splice(0, columns.length, ...result.fields.map((field) => field.name));
          for (const row of result.rows as unknown[][]) rows.push(row.map(plain));
          if (rows.length > maxRows) {
            truncated = true;
            break;
          }
          if (result.rows.length < want) break;
          if (bytes() > PRODUCT_RESULT_SOFT_BYTES) {
            truncated = true;
            break;
          }
        }
        return { columns, rows: rows.slice(0, maxRows), truncated };
      });
    },

    async hardeningProblems() {
      const select = HARDENING_PROBES.map(
        ([, probe], index) => `${probe} AS p${String(index)}`,
      ).join(', ');
      return asReader(5000, async (client) => {
        const result = await client.query(extended({ text: `SELECT ${select}`, rowMode: 'array' }));
        const row = (result.rows[0] ?? []) as unknown[];
        // A probe that is true is a power the reader should not have.
        return HARDENING_PROBES.filter((_probe, index) => row[index] !== false).map(
          ([name]) => `the reader can use ${name}`,
        );
      });
    },
    close: () => pool.end(),
  };
}
