import { schema, withReadOnlyConnections, type Database } from '@watchtower/db';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

/** `[ASSUMED]` (ADR-029 section 2): a tool query that takes longer than this is cancelled by Postgres. */
export const TOOL_STATEMENT_TIMEOUT_MS = 3000;

/** A Drizzle handle bound to one read-only transaction. A write through it fails with SQLSTATE 25006. */
export type ReadOnlyDb = NodePgDatabase<typeof schema>;

/** What a tool handler gets to run its own queries (N2). */
export type ReadOnlyRunner = <T>(work: (db: ReadOnlyDb) => Promise<T>) => Promise<T>;

/**
 * Runs `work` inside `BEGIN READ ONLY` with `statement_timeout` of 3 s (ADR-029 section 2, N2): the database, not
 * the code, refuses an INSERT/UPDATE/DELETE/DDL a tool handler might one day contain, and a slow query cannot hold a
 * connection. The transaction is on a connection of its own, always rolled back (nothing to commit in a read) and
 * returned to the pool; when the rollback itself fails the connection is destroyed instead of reused.
 *
 * Readers and services that bring their own connection (`TicketReader`, `KbService`, ...) are inside the first layer;
 * a reader that takes a `db` argument can also be given the transaction handle.
 */
export async function runReadOnly<T>(
  database: Pick<Database, 'pool'>,
  work: (db: ReadOnlyDb) => Promise<T>,
  options: { readonly timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = Math.trunc(options.timeoutMs ?? TOOL_STATEMENT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('timeoutMs must be positive');
  // Two layers. (1) Every query made while `work` runs, through ANY handle of this process (`database.db`, the
  // pool, a reader or a service holding them), goes to the read-only pool: its connections refuse writes at the
  // session level. (2) The handle `work` receives is also inside `BEGIN READ ONLY` with its own timeout.
  return withReadOnlyConnections(async () => {
    const client = await database.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN READ ONLY');
      // SET does not take bind parameters; the value is an integer made above.
      await client.query(`SET LOCAL statement_timeout = ${String(timeoutMs)}`);
      return await work(drizzle(client, { schema }));
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      client.release(broken);
    }
  });
}

/**
 * Runs a whole tool handler inside the read-only scope without taking a transaction of its own: for handlers that
 * call readers and services (which use `this.database.db`), so a write anywhere under them fails (T-400 C-2).
 */
export function inReadOnlyScope<T>(work: () => Promise<T>): Promise<T> {
  return withReadOnlyConnections(work);
}
