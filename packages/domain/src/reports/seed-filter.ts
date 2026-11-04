import type { Database } from '@watchtower/db';
import { sql, type SQL } from 'drizzle-orm';

/** How long "the column is not there yet" is trusted before the catalog is asked again. */
const RECHECK_MS = 60_000;
const ALIAS = /^[a-z_][a-z0-9_]*$/;

/**
 * The one place that decides whether a report leaves out the tickets of a seed batch (demo data loaded for a
 * trial; `ticket.seed_batch_id IS NOT NULL`, migration 0096). The column may not exist yet on an instance, so
 * the catalog is asked (a "not there yet" answer is trusted for a minute, a "there" answer for good), so a
 * report written today starts leaving seeded tickets out the day the migration runs, with no code change.
 * Every report query that reads tickets takes its condition from here, in the api (`SeedFilter` extends this)
 * and in the worker (the weekly brief, T-305c).
 */
export class SeedTicketFilter {
  private present = false;
  private checkedAt = 0;

  constructor(private readonly database: Pick<Database, 'db'>) {}

  /** The clock; a test replaces it. */
  now: () => number = () => Date.now();

  /** Forgets what was learned: after a rollback of the migration, or in a test that adds and drops the column. */
  forget(): void {
    this.present = false;
    this.checkedAt = 0;
  }

  /** True when the `ticket` table has the seed column. */
  async active(): Promise<boolean> {
    if (this.present) return true;
    const now = this.now();
    if (this.checkedAt !== 0 && now - this.checkedAt < RECHECK_MS) return false;
    const result = await this.database.db.execute(
      sql`SELECT 1 AS found FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'ticket' AND column_name = 'seed_batch_id'`,
    );
    this.checkedAt = now;
    this.present = result.rows.length > 0;
    return this.present;
  }

  /** `<alias>.seed_batch_id IS NULL`, or `true` while the column does not exist. `alias` is a code constant. */
  async exclude(alias: string): Promise<SQL> {
    if (!ALIAS.test(alias)) throw new Error('a ticket alias is an identifier');
    return (await this.active()) ? sql.raw(`${alias}.seed_batch_id IS NULL`) : sql`true`;
  }
}

/** What a report needs from the seed filter (the api and the worker each build one). */
export type SeedPort = Pick<SeedTicketFilter, 'active' | 'exclude'>;
