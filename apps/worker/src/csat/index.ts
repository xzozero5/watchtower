import { CSAT_JOBS } from '@watchtower/shared';
import { UnrecoverableError, type Job } from 'bullmq';

import type { ProcessorContext } from '../processors/index.js';

/**
 * Wires the `csat` consumer (T-110). The only job is the `sweep` the scheduler repeats every
 * minute: it sends the surveys that are due, the one reminder that is due, and closes links that
 * ran out. All of it is decided by the rows in `csat_survey`, so a late, repeated or lost job
 * sends nothing twice and forgets nothing. The sweep only writes to the transactional outbox; the
 * `email` consumer sends (and renders TH or EN).
 */
export function createCsatRegistration(context: ProcessorContext) {
  const { domain, database, logger } = context;
  return async (job: Job): Promise<unknown> => {
    if (job.name !== CSAT_JOBS.sweep) throw new UnrecoverableError('unknown csat job');
    const result = await domain.csat.sweep(
      database.db,
      domain.context({ actor: { type: 'system', id: null } }),
    );
    if (result.sent + result.reminded + result.skipped + result.voided + result.expired > 0) {
      logger.info({ ...result }, 'csat sweep');
    }
    return result;
  };
}
