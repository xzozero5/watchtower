import type { ClientSource } from '../common/errors.js';

/**
 * Read-only access to the product's data (R-5.2): BigQuery or a Postgres replica. One method, and it
 * reads. The guardrails are two layers: `./guard.ts` (what may be asked, which columns may be shown)
 * and the executor behind the client (read-only transaction, `statement_timeout`, row cap, and a
 * database login that can read nothing but the columns meant to be read). `EXTERNAL_QUERY` is off
 * (po decision 2): `assertReadOnlySql` refuses it.
 */

export type SqlValue = string | number | boolean | null;

export interface DataQuery {
  /** The template's name, or `adhoc`. For the audit row and for the fake; never part of the query. */
  readonly label: string;
  /** One statement with `$1..$n` bind parameters. Values are never spliced into the text. */
  readonly sql: string;
  readonly params: readonly SqlValue[];
  /** At most this many rows come back; one more is read to know whether there were more. */
  readonly maxRows: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

export interface DataResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly SqlValue[])[];
  /** More rows existed than `maxRows`. */
  readonly truncated: boolean;
  /** Columns whose values were hidden because they are not on the allow-list (the cells hold null). */
  readonly masked: readonly string[];
}

export interface DataQueryClient {
  readonly source: ClientSource;
  query(query: DataQuery): Promise<DataResult>;
}

/** What the database side of a client gives back, before the allow-list is applied. */
export interface RawDataResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly SqlValue[])[];
  readonly truncated: boolean;
}

/**
 * The database behind a `DataQueryClient`. `packages/db` implements it over a read-only
 * transaction; `connectors` does not know pg.
 */
export interface SqlExecutor {
  execute(input: {
    readonly sql: string;
    readonly params: readonly SqlValue[];
    readonly maxRows: number;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
  }): Promise<RawDataResult>;
}

export const DATA_HARD_MAX_ROWS = 500;
/** The most a guard may be told to allow (the scheduler of the usage metrics reads thousands of points); a person never gets this. */
export const DATA_SYSTEM_MAX_ROWS = 10_000;
export const DATA_DEFAULT_MAX_ROWS = 100;
export const DATA_HARD_TIMEOUT_MS = 15_000;
export const DATA_DEFAULT_TIMEOUT_MS = 5_000;
export const DATA_MAX_SQL_CHARS = 8_000;
