import { Pool, type QueryConfig } from 'pg';

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

/** The extended protocol only: one command per query, whatever the text holds. */
const extended = (config: { text: string; values?: unknown[]; rowMode?: 'array' }): QueryConfig =>
  ({ ...config, queryMode: 'extended' }) as QueryConfig;

export function createProductDbExecutor(options: ProductDbOptions): ProductDbExecutor {
  const login = decodeURIComponent(new URL(options.url).username);
  const readerRole = options.readerRole ?? `${login}_reader`;
  if (!ROLE_NAME.test(readerRole)) {
    throw new Error('The product database login has a name that cannot be turned into a reader role');
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

  return {
    sandbox: isSandboxDatabase(options.url),
    async execute(input) {
      if (input.signal?.aborted === true) throw new Error('aborted');
      const maxRows = Math.max(1, Math.min(Math.trunc(input.maxRows), 10_000));
      const timeoutMs = Math.max(100, Math.min(Math.trunc(input.timeoutMs), 60_000));
      const statement = input.sql.trim().replace(/;\s*$/, '');
      const client = await pool.connect();
      let broken = false;
      try {
        // Our own fixed strings, simple protocol: no caller text in any of them.
        await client.query('BEGIN READ ONLY');
        await client.query(`SET LOCAL statement_timeout = ${String(timeoutMs)}`);
        await client.query(`SET LOCAL lock_timeout = ${String(Math.min(timeoutMs, 2000))}`);
        await client.query(`SET LOCAL ROLE ${quoteRole(readerRole)}`);
        // The caller's text appears once, as the body of a cursor, in a query the server parses as one command.
        await client.query(
          extended({
            text: `DECLARE watchtower_cursor NO SCROLL CURSOR WITHOUT HOLD FOR ${statement}`,
            values: [...input.params],
          }),
        );
        const result = await client.query(
          extended({
            // The cap is an integer written by this code. One extra row says whether there was more.
            text: `FETCH FORWARD ${String(maxRows + 1)} FROM watchtower_cursor`,
            rowMode: 'array',
          }),
        );
        const fetched = result.rows as unknown[][];
        return {
          columns: result.fields.map((field) => field.name),
          rows: fetched.slice(0, maxRows).map((row) => row.map(plain)),
          truncated: fetched.length > maxRows,
        };
      } finally {
        // Back to the pool only if the transaction ended cleanly; otherwise the connection is dropped.
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true;
        }
        client.release(broken ? true : undefined);
      }
    },
    close: () => pool.end(),
  };
}
