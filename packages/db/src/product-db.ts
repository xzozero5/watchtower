import { Pool } from 'pg';

/**
 * The database side of the data tool (T-203c, R-5.2, N2): runs one statement of a saved template or
 * of a lead's own against the *product* database, which is not the Watchtower database.
 *
 * Every call is its own `READ ONLY` transaction with `statement_timeout` and `lock_timeout` set for
 * that transaction, and the statement is wrapped so that at most `maxRows + 1` rows leave the
 * server. The login it connects with should be able to read only the columns meant to be read
 * (`examples/metrics/product-mock.grants.sql`); that, not this code, is the barrier to personal data.
 * Which statements are allowed at all, and the column allow-list, belong to `@watchtower/connectors`
 * (`withDataGuardrails`), which sits in front of this and does not know pg.
 */

export type ProductValue = string | number | boolean | null;

export interface ProductQueryInput {
  /** One statement with `$1..$n` bind parameters, already checked to be a read. */
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

export function createProductDbExecutor(options: ProductDbOptions): ProductDbExecutor {
  const pool = new Pool({
    connectionString: options.url,
    max: options.max ?? 2,
    application_name: options.applicationName ?? 'watchtower-product-readonly',
    // A hung network read must not hold a connection for ever.
    connectionTimeoutMillis: 5000,
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
      try {
        await client.query('BEGIN READ ONLY');
        // `set_config(..., true)` lasts until the end of this transaction.
        await client.query(
          `SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)`,
          [String(timeoutMs), String(Math.min(timeoutMs, 2000))],
        );
        const result = await client.query({
          // The cap is an integer written by this code, not text from the caller.
          text: `SELECT * FROM (${statement}) AS watchtower_q LIMIT ${String(maxRows + 1)}`,
          values: [...input.params],
          rowMode: 'array',
        });
        await client.query('ROLLBACK');
        const rows = (result.rows as unknown[][]).slice(0, maxRows).map((row) => row.map(plain));
        return {
          columns: result.fields.map((field) => field.name),
          rows,
          truncated: result.rows.length > maxRows,
        };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
