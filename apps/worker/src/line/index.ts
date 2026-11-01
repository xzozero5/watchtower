import { LINE_JOBS } from '@watchtower/shared';
import { UnrecoverableError, type Job } from 'bullmq';

import type { ProcessorContext } from '../processors/index.js';
import { createQuotaReconciler } from './reconcile.js';

export { createQuotaReconciler } from './reconcile.js';
export type { ReconcileDeps, ReconcileResult } from './reconcile.js';
export { lineChannelsFrom } from './transports.js';
export type { LineAccount, LineOverrides, LineTransportFor } from './transports.js';

/** Consumer of the `line` queue (T-103): the hourly quota reconcile. */
export function createLineRegistration(context: ProcessorContext) {
  const reconcile = createQuotaReconciler({
    database: context.database,
    transportFor: context.overrides.line?.transportFor,
    logger: context.logger,
  });
  return async (job: Job): Promise<unknown> => {
    switch (job.name) {
      case LINE_JOBS.reconcileQuota:
        return reconcile();
      default:
        throw new UnrecoverableError(`unknown line job "${job.name}"`);
    }
  };
}
