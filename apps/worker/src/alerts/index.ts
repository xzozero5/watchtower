import type { discord } from '@watchtower/channels';
import { ALERTS_JOBS, alertChatJobSchema } from '@watchtower/shared';
import { UnrecoverableError, type Job } from 'bullmq';

import type { ProcessorContext } from '../processors/index.js';
import { BotAlertChat, createBotRuntime } from './bot.js';
import type { AlertChatPort } from './chat.js';
import { createAlertChatNotifier } from './notifier.js';

export { BotAlertChat, createBotRuntime, FAKE_CHANNEL_ID } from './bot.js';
export type { BotRuntime } from './bot.js';
export { FakeAlertChat } from './chat.js';
export type { AlertChatMessage, AlertChatPort, AlertChatResult } from './chat.js';
export { chatBackoffMs, createAlertChatNotifier } from './notifier.js';
export type { AlertChatNotifier, ChatOutcome, ChatSweepResult } from './notifier.js';

/** What a test replaces; production passes none. */
export interface AlertsOverrides {
  /** The chat service the escalation posts to. Default: the Discord bot (the in-memory fake in this build). */
  readonly chat?: AlertChatPort;
  /** The bot transport behind the default chat port. Default: the in-memory fake. */
  readonly bot?: discord.BotTransport;
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
  const chat: AlertChatPort =
    context.overrides.alerts?.chat ??
    new BotAlertChat(createBotRuntime(context, context.overrides.alerts?.bot));
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
        // Heartbeats first: a missing one opens an alert that the escalation below can already page.
        const heartbeats = await domain.alerts.sweepHeartbeats(database.db, system());
        const escalation = await domain.alerts.sweepEscalations(database.db, system());
        for (const event of [...heartbeats.events, ...escalation.events]) {
          try {
            await realtime.publish(event);
          } catch (error) {
            logger.warn({ err: error, eventType: event.type }, 'realtime publish failed');
          }
        }
        const chatSweep = await notifier.sweep();
        const result = {
          missingHeartbeats: heartbeats.missing,
          steps: escalation.steps,
          notified: escalation.notified,
          exhausted: escalation.exhausted,
          unreached: escalation.unreached.length,
          chat: chatSweep,
        };
        if (escalation.unreached.length > 0) {
          // Loud on purpose: an alert nobody could be told about. Ids only.
          logger.error(
            { alertIds: escalation.unreached },
            'alert escalation step reached nobody: no lead, no head and nobody on shift',
          );
        }
        if (
          heartbeats.missing + escalation.steps + escalation.exhausted > 0 ||
          chatSweep.redriven > 0
        ) {
          logger.info(result, 'alerts sweep');
        }
        return result;
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
