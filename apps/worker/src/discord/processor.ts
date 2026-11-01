import { DISCORD_JOBS, discordNotifyJobSchema } from '@watchtower/shared';
import { UnrecoverableError, type Job } from 'bullmq';

import { DiscordRetryError, type DiscordNotifier } from './notifier.js';

/**
 * Consumer of the `discord` queue. A `notify` job carries ids only. The ledger rows decide what is
 * still owed, so a repeated or late job posts nothing twice. When a post could not be made and may
 * succeed later (rate limit, timeout, 5xx) the job fails and BullMQ retries it with backoff; on the
 * last attempt the rows are settled as `failed` and the job completes, so the failure is visible in
 * `discord_notification` and not only in the queue.
 */
export function createDiscordProcessor(deps: { readonly notifier: DiscordNotifier }) {
  return async (job: Job): Promise<unknown> => {
    switch (job.name) {
      case DISCORD_JOBS.notify: {
        const parsed = discordNotifyJobSchema.safeParse(job.data);
        if (!parsed.success) throw new UnrecoverableError('discord notify payload is invalid');
        const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        const result = await deps.notifier.notify(parsed.data, { final });
        const waiting = result.slots.flatMap((slot) =>
          slot.state === 'pending' ? [slot.retryAfterMs] : [],
        );
        if (waiting.length > 0) throw new DiscordRetryError(Math.max(...waiting));
        return {
          status: result.status,
          mode: result.mode,
          slots: result.slots.map((slot) => `${slot.slot}:${slot.state}`),
        };
      }
      default:
        throw new UnrecoverableError(`unknown discord job "${job.name}"`);
    }
  };
}
