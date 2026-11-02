import type { Database } from '@watchtower/db';
import { MAINTENANCE_JOBS } from '@watchtower/shared';
import { UnrecoverableError, type Job } from 'bullmq';

/** How many months ahead of the current one partitions are kept ready. */
export const PARTITION_MONTHS_AHEAD = 3;

/** Tables partitioned by month (migrations 0001, 0002, 0010, 0044 and 0061). */
export const PARTITIONED_TABLES = [
  'audit_log',
  'ticket_event',
  'ai_run',
  'incident_timeline',
  'usage_metric_point',
] as const;

/**
 * Partitioned tables the application updates: their new partitions are NOT made append-only. The metric
 * points are upserted (a run over the same window replaces the value, T-205b); every other table above is a
 * log and its partitions refuse UPDATE, DELETE and TRUNCATE.
 */
export const UPDATABLE_PARTITIONED_TABLES: ReadonlySet<string> = new Set(['usage_metric_point']);

/**
 * Processor for the `maintenance` queue. `ensure-partitions` calls the SQL function from
 * migration 0001, which creates next months' partitions of the append-only tables (it is
 * SECURITY DEFINER, so the worker needs no ownership of them). Idempotent; ADR-001 puts
 * schedulers in the worker, not in cron.
 */
export function createMaintenanceProcessor(database: Database) {
  return async (job: Job): Promise<{ created: number }> => {
    if (job.name !== MAINTENANCE_JOBS.ensurePartitions) {
      throw new UnrecoverableError(`unknown maintenance job "${job.name}"`);
    }
    let created = 0;
    for (const table of PARTITIONED_TABLES) {
      // The table name and the flag come from the constants above, never from a job payload.
      const result = await database.pool.query<{ created: number }>(
        `SELECT ensure_monthly_partitions('${table}', $1::int, ${UPDATABLE_PARTITIONED_TABLES.has(table) ? 'false' : 'true'}) AS created`,
        [PARTITION_MONTHS_AHEAD],
      );
      created += result.rows[0]?.created ?? 0;
    }
    return { created };
  };
}
