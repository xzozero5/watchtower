import type { Database } from '@watchtower/db';
import { sql } from 'drizzle-orm';

import type { DomainContext } from './types.js';

/**
 * The clock that decides time windows shared between processes (review O-7, ADR-010 section 4).
 *
 * The undo window is stamped by the api when a reply is scheduled, ended by the worker's claim and
 * checked by the api's cancel; a lease is stamped by one worker and judged by the sweeper of another.
 * With each process reading its own clock, a worker that runs 5 seconds fast ends the window 5
 * seconds early (to nothing, with the default hold) and a sweeper that runs 120 seconds fast fails a
 * live Gmail send as `outcome_unknown`. The database is the one clock they all share (the outbox
 * relay already reads it), so a context built without an injected clock asks the database.
 *
 * A context with an injected `now` (tests, simulations) keeps that clock: the caller decided what
 * time it is. `databaseClock: true` together with a custom `now` is how a test models "a process
 * whose own clock is wrong": `now` is then used for everything except these windows.
 */
export async function authorityNow(
  db: Pick<Database['db'], 'execute'>,
  ctx: Pick<DomainContext, 'now' | 'databaseClock'>,
): Promise<Date> {
  if (ctx.databaseClock !== true) return ctx.now();
  const result = await db.execute<{ ms: number }>(
    sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms`,
  );
  const ms = result.rows[0]?.ms;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new Error('the database did not answer with its clock');
  }
  return new Date(Math.floor(ms));
}
