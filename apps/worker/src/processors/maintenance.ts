import type { Database } from '@watchtower/db';
import { MAINTENANCE_JOBS } from '@watchtower/shared';
import { UnrecoverableError, type Job } from 'bullmq';

/** How many months ahead of the current one partitions are kept ready. */
export const PARTITION_MONTHS_AHEAD = 3;

/** Append-only tables partitioned by month (migrations 0001, 0002, 0010, 0044 and 0050). */
export const PARTITIONED_TABLES = [
  'audit_log',
  'ticket_event',
  'ai_run',
  'incident_timeline',
  'tool_execution',
] as const;

/**
 * Columns the application may still UPDATE on the partitions of a table (the rest is append-only).
 * `tool_execution` is closed after it is written: status, error code, finish time, latency, count.
 */
export const PARTITION_UPDATABLE_COLUMNS: Readonly<
  Partial<Record<(typeof PARTITIONED_TABLES)[number], readonly string[]>>
> = {
  tool_execution: ['status', 'error_code', 'finished_at', 'latency_ms', 'result_count'],
};

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
      // The table and column names come from the constants above, never from a job payload.
      const updatable = PARTITION_UPDATABLE_COLUMNS[table];
      const result = await database.pool.query<{ created: number }>(
        updatable === undefined
          ? `SELECT ensure_monthly_partitions('${table}', $1::int, true) AS created`
          : `SELECT ensure_monthly_partitions('${table}', $1::int, true, ARRAY[${updatable
              .map((column) => `'${column}'`)
              .join(', ')}]) AS created`,
        [PARTITION_MONTHS_AHEAD],
      );
      created += result.rows[0]?.created ?? 0;
    }
    return { created };
  };
}
