import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema/index.js';

export interface CreateDatabaseOptions {
  /** Postgres connection string. The caller reads it from validated config. */
  readonly url: string;
  readonly max?: number;
  readonly applicationName?: string;
  /** Called for errors on idle pooled connections, which would otherwise crash the process. */
  readonly onError?: (error: Error) => void;
}

export interface Database {
  readonly db: NodePgDatabase<typeof schema>;
  readonly pool: Pool;
  /** Rejects when Postgres does not answer `select 1` within `timeoutMs`. */
  ping(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_POOL_SIZE = 10;
const DEFAULT_PING_TIMEOUT_MS = 2000;

export function createDatabase(options: CreateDatabaseOptions): Database {
  const pool = new Pool({
    connectionString: options.url,
    max: options.max ?? DEFAULT_POOL_SIZE,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    ...(options.applicationName === undefined ? {} : { application_name: options.applicationName }),
  });
  pool.on('error', (error) => {
    options.onError?.(error);
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
      await pool.end();
    },
  };
}
