import { DISCORD_JOBS, discordNotifyJobSchema } from '@watchtower/shared';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';

import type { DiscordNotifier } from './notifier.js';

/** A job is never put back sooner than this, whatever the ledger says. */
const MIN_DELAY_MS = 1000;

/**
 * Consumer of the `discord` queue. A `notify` job carries ids only; the ledger rows decide what is
 * still owed, so a repeated or late job posts nothing twice.
 *
 * What the queue guarantees is only a nudge. When a post is owed later (a rate limit, a timeout) the
 * row holds the time it is due, which already includes Discord's `Retry-After`, and the job is moved
 * to that time with `moveToDelayed` (this does not use up an attempt). If the worker restarts, or
 * the job is lost, the `sweep` job re-drives every due row, so a retry does not depend on the queue
 * remembering it. A throw here (for example the database is down) is a plain failure that BullMQ
 * retries with backoff; the ledger is then still `pending`/`sending` and the sweep picks it up.
 */
export function createDiscordProcessor(deps: { readonly notifier: DiscordNotifier }) {
  return async (job: Job, token?: string): Promise<unknown> => {
    switch (job.name) {
      case DISCORD_JOBS.notify: {
        const parsed = discordNotifyJobSchema.safeParse(job.data);
        if (!parsed.success) throw new UnrecoverableError('discord notify payload is invalid');
        const result = await deps.notifier.notify(parsed.data);
        const due = result.slots.flatMap((slot) =>
          slot.state === 'pending' ? [slot.retryAt.getTime()] : [],
        );
        if (due.length > 0) {
          await job.moveToDelayed(Math.max(Date.now() + MIN_DELAY_MS, Math.min(...due)), token);
          throw new DelayedError();
        }
        return {
          status: result.status,
          mode: result.mode,
          slots: result.slots.map((slot) => `${slot.slot}:${slot.state}`),
        };
      }
      case DISCORD_JOBS.sweep:
        return deps.notifier.sweep();
      default:
        throw new UnrecoverableError(`unknown discord job "${job.name}"`);
    }
  };
}
