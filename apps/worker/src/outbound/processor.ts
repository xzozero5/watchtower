import { OUTBOUND_JOBS, dispatchJobSchema } from '@watchtower/shared';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';

import type { WorkerLogger } from '../logger.js';
import type { OutboundDispatcher } from './dispatcher.js';

/**
 * Consumer of the `outbound` queue (ADR-010). A `dispatch` job is only a nudge: the delivery row
 * decides whether anything is sent, so a repeated or late job is harmless, and an early one waits
 * for its time. `sweep` is the repeating housekeeping job (`schedules.ts`).
 */
export function createOutboundProcessor(deps: {
  readonly dispatcher: OutboundDispatcher;
  readonly logger: WorkerLogger;
}) {
  return async (job: Job, token?: string): Promise<unknown> => {
    switch (job.name) {
      case OUTBOUND_JOBS.dispatch: {
        const parsed = dispatchJobSchema.safeParse(job.data);
        if (!parsed.success) throw new UnrecoverableError('outbound dispatch payload is invalid');
        const outcome = await deps.dispatcher.dispatch(parsed.data.deliveryId);
        deps.logger.info(
          { deliveryId: parsed.data.deliveryId, outcome: outcome.status },
          'outbound dispatch',
        );
        if (outcome.status === 'early') {
          await job.moveToDelayed(outcome.notBefore.getTime(), token);
          throw new DelayedError();
        }
        return outcome;
      }
      case OUTBOUND_JOBS.sweep: {
        const result = await deps.dispatcher.sweep();
        return {
          released: result.released,
          unknownOutcome: result.unknownOutcome,
          retriedPush: result.retriedPush,
          retryLimited: result.retryLimited,
          retriggered: result.retriggered.length,
          staleReplyTokens: result.staleReplyTokens,
        };
      }
      default:
        throw new UnrecoverableError(`unknown outbound job "${job.name}"`);
    }
  };
}
