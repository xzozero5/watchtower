import { AsyncLocalStorage } from 'node:async_hooks';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema/index.js';

export interface CreateDatabaseOptions {
  /** Postgres connection string. The caller reads it from validated config. */
  readonly url: string;
  readonly max?: number;
  readonly applicationName?: string;
  /** Where the read-only pool connects (a read replica). Default: `url`. */
  readonly readOnlyUrl?: string;
  /** Called for errors on idle pooled connections, which would otherwise crash the process. */
  readonly onError?: (error: Error) => void;
}

const readOnlyScope = new AsyncLocalStorage<true>();

/**
 * Runs `work` with every query of the `Database` objects of this process (`db`, `pool`, and everything built on
 * them: the readers and services of the api) sent to a second pool whose connections are read-only at the
 * session level (`default_transaction_read_only = on`) with a 3 s `statement_timeout`. A write inside `work`, by
 * whatever code, fails with SQLSTATE 25006 (T-400 C-2, ADR-029 section 2, N2). The scope follows `await`s
 * (AsyncLocalStorage); work started inside and left running after `work` returns stays in the scope.
 */
export function withReadOnlyConnections<T>(work: () => Promise<T>): Promise<T> {
  return readOnlyScope.run(true, work);
}

export interface Database {
  readonly db: NodePgDatabase<typeof schema>;
  readonly pool: Pool;
  /** Rejects when Postgres does not answer `select 1` within `timeoutMs`. */
  ping(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_POOL_SIZE = 10;
const READ_ONLY_POOL_SIZE = 4;
export const READ_ONLY_STATEMENT_TIMEOUT_MS = 3000;
const DEFAULT_PING_TIMEOUT_MS = 2000;

export function createDatabase(options: CreateDatabaseOptions): Database {
  const writable = new Pool({
    connectionString: options.url,
    max: options.max ?? DEFAULT_POOL_SIZE,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    ...(options.applicationName === undefined ? {} : { application_name: options.applicationName }),
  });
  writable.on('error', (error) => {
    options.onError?.(error);
  });

  // Made on first use: most processes never run a read-only scope.
  let readOnly: Pool | undefined;
  const readOnlyPool = (): Pool => {
    if (readOnly === undefined) {
      readOnly = new Pool({
        connectionString: options.readOnlyUrl ?? options.url,
        max: READ_ONLY_POOL_SIZE,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30_000,
        options: `-c default_transaction_read_only=on -c statement_timeout=${String(READ_ONLY_STATEMENT_TIMEOUT_MS)}`,
        ...(options.applicationName === undefined
          ? {}
          : { application_name: `${options.applicationName}-ro` }),
      });
      readOnly.on('error', (error) => {
        options.onError?.(error);
      });
    }
    return readOnly;
  };
  // What `db` and every service use. Outside a read-only scope it is the writable pool itself.
  const pool = new Proxy(writable, {
    get(target, property) {
      const real = readOnlyScope.getStore() === true ? readOnlyPool() : target;
      const value: unknown = Reflect.get(real, property, real);
      return typeof value === 'function'
        ? (...args: unknown[]): unknown => Reflect.apply(value, real, args)
        : value;
    },
  });

  return {
    db: drizzle(pool, { schema }),
    pool,
    async ping(timeoutMs = DEFAULT_PING_TIMEOUT_MS) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`database did not answer within ${String(timeoutMs)} ms`));
        }, timeoutMs);
      });
      try {
        await Promise.race([pool.query('select 1'), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      await Promise.all([writable.end(), readOnly?.end()]);
    },
  };
}
