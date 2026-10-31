import type { Database } from '@watchtower/db';
import { MAINTENANCE_JOBS } from '@watchtower/shared';
import { UnrecoverableError, type Job } from 'bullmq';

/** How many months ahead of the current one partitions are kept ready. */
export const PARTITION_MONTHS_AHEAD = 3;

/**
 * Processor for the `maintenance` queue. `ensure-partitions` calls the SQL function from
 * migration 0001, which creates next months' partitions of the append-only audit log (it is
 * SECURITY DEFINER, so the worker needs no ownership of the table). Idempotent; ADR-001 puts
 * schedulers in the worker, not in cron. ticket_event joins in T-005.
 */
export function createMaintenanceProcessor(database: Database) {
  return async (job: Job): Promise<{ created: number }> => {
    if (job.name !== MAINTENANCE_JOBS.ensurePartitions) {
      throw new UnrecoverableError(`unknown maintenance job "${job.name}"`);
    }
    const result = await database.pool.query<{ created: number }>(
      `SELECT ensure_monthly_partitions('audit_log', $1::int, true) AS created`,
      [PARTITION_MONTHS_AHEAD],
    );
    return { created: result.rows[0]?.created ?? 0 };
  };
}
