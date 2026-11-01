import { ALERTS_JOBS, alertChatJobSchema } from '@watchtower/shared';
import { UnrecoverableError, type Job } from 'bullmq';

import type { ProcessorContext } from '../processors/index.js';
import { FakeAlertChat, type AlertChatPort } from './chat.js';
import { createAlertChatNotifier } from './notifier.js';

export { FakeAlertChat } from './chat.js';
export type { AlertChatMessage, AlertChatPort, AlertChatResult } from './chat.js';
export { chatBackoffMs, createAlertChatNotifier } from './notifier.js';
export type { AlertChatNotifier, ChatOutcome, ChatSweepResult } from './notifier.js';

/** What a test replaces; production passes none. */
export interface AlertsOverrides {
  /** The chat service the escalation posts to. Default: the in-memory fake. */
  readonly chat?: AlertChatPort;
}

/**
 * Wires the `alerts` consumer (T-201d): the repeating `sweep` (escalation steps that are due, then the
 * chat posts that are owed) and the `chat` job of one step. Everything is decided by rows and the
 * database clock, so a late, repeated or lost job does nothing twice and forgets nothing.
 *
 * Without a bot configured the chat port is the in-memory fake: the step is recorded as `mock`, which
 * is a different state from `sent` on purpose (T-102 P1-1).
 */
export function createAlertsRegistration(context: ProcessorContext) {
  const { domain, database, logger, realtime, config } = context;
  const chat: AlertChatPort = context.overrides.alerts?.chat ?? new FakeAlertChat();
  const notifier = createAlertChatNotifier({
    database,
    logger,
    chat,
    appUrl: config.APP_URL,
    isProduction: config.NODE_ENV === 'production',
  });
  const system = () => domain.context({ actor: { type: 'system', id: null } });

  return async (job: Job): Promise<unknown> => {
    switch (job.name) {
      case ALERTS_JOBS.sweep: {
        const escalation = await domain.alerts.sweepEscalations(database.db, system());
        for (const event of escalation.events) {
          try {
            await realtime.publish(event);
          } catch (error) {
            logger.warn({ err: error, eventType: event.type }, 'realtime publish failed');
          }
        }
        const chatSweep = await notifier.sweep();
        if (escalation.steps + escalation.exhausted > 0 || chatSweep.redriven > 0) {
          logger.info(
            {
              steps: escalation.steps,
              notified: escalation.notified,
              exhausted: escalation.exhausted,
              chat: chatSweep,
            },
            'alerts sweep',
          );
        }
        return {
          steps: escalation.steps,
          notified: escalation.notified,
          exhausted: escalation.exhausted,
          chat: chatSweep,
        };
      }
      case ALERTS_JOBS.chat: {
        const parsed = alertChatJobSchema.safeParse(job.data);
        if (!parsed.success) throw new UnrecoverableError('alert chat payload is invalid');
        return notifier.post(parsed.data);
      }
      default:
        throw new UnrecoverableError(`unknown alerts job "${job.name}"`);
    }
  };
}
