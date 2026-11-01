import {
  purgeExpired,
  type CleanupOptions,
  type CleanupResult,
  type Database,
} from '@watchtower/db';
import { CLEANUP_JOBS } from '@watchtower/shared';
import { UnrecoverableError, type Job } from 'bullmq';

import type { WorkerLogger } from '../logger.js';

/**
 * Processor for the `cleanup` queue (T-117, ADR-005). `purge-expired` deletes, in batches, the
 * sessions, refresh tokens, magic-link tokens, portal tracking links and break-glass lockout
 * counters that are past their expiry plus the retention in `options`. Runs daily from
 * `schedules.ts`. The outbox is not touched: its relay already expires and purges its own rows
 * (ADR-006). Logs counts only.
 */
export function createCleanupProcessor(
  database: Pick<Database, 'pool'>,
  logger: Pick<WorkerLogger, 'info' | 'warn'>,
  options: CleanupOptions = {},
) {
  return async (job: Job): Promise<CleanupResult> => {
    if (job.name !== CLEANUP_JOBS.purgeExpired) {
      throw new UnrecoverableError(`unknown cleanup job "${job.name}"`);
    }
    const result = await purgeExpired(database, options);
    const { more, ...deleted } = result;
    const total = Object.values(deleted).reduce((sum, count) => sum + count, 0);
    if (total > 0) logger.info({ deleted }, 'expired rows deleted');
    if (more) logger.warn('expired rows remain after this run; the next run continues');
    return result;
  };
}
