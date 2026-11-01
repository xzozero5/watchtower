import { ChannelError } from '@watchtower/channels';
import { GMAIL_JOBS, gmailSyncJobSchema } from '@watchtower/shared';
import { UnrecoverableError, type Job } from 'bullmq';

import type { WorkerLogger } from '../logger.js';
import type { GmailHeartbeat } from './heartbeat.js';
import type { GmailSync } from './sync.js';
import type { GmailWatch } from './watch.js';

/**
 * Consumer of the `gmail` queue (T-102c). One job at a time (see the registration): the three jobs
 * are cheap and ordering them keeps a sync from racing a renewal of the same mailbox.
 *
 * Failure handling (the dead letter of PRD section 8.3): a transient failure (rate limit, timeout,
 * server error, network) is thrown as is and BullMQ retries it with the backoff the producer set;
 * after the last attempt the job stays in the queue's failed set for a week. A failure that cannot
 * improve by waiting (bad credentials, a refused request) ends the job at once with
 * `UnrecoverableError`, with only an error code in the message. The mailbox's `last_error_code`
 * and health record it; the heartbeat or the next push tries again.
 */
export function createGmailProcessor(deps: {
  readonly sync: GmailSync;
  readonly watch: GmailWatch;
  readonly heartbeat: GmailHeartbeat;
  readonly logger: WorkerLogger;
}) {
  function classify(error: unknown): unknown {
    if (error instanceof ChannelError && !error.retryable) {
      return new UnrecoverableError(`gmail ${error.operation} failed: ${error.kind}`);
    }
    return error;
  }

  return async (job: Job): Promise<unknown> => {
    try {
      switch (job.name) {
        case GMAIL_JOBS.sync: {
          const parsed = gmailSyncJobSchema.safeParse(job.data);
          if (!parsed.success) throw new UnrecoverableError('gmail sync payload is invalid');
          return await deps.sync.syncAccount(parsed.data.channelAccountId, parsed.data.reason);
        }
        case GMAIL_JOBS.renewWatch:
          return await deps.watch.renewAll();
        case GMAIL_JOBS.heartbeat:
          return await deps.heartbeat.run();
        default:
          throw new UnrecoverableError(`unknown gmail job "${job.name}"`);
      }
    } catch (error) {
      throw classify(error);
    }
  };
}
