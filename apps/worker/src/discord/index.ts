import { createCredentialStore } from '@watchtower/db';
import { pickCredentialEnv } from '@watchtower/shared';
import { localKmsFromConfig } from '@watchtower/shared/credential-box';

import type { ProcessorContext } from '../processors/index.js';
import { createDiscordNotifier } from './notifier.js';
import { createDiscordProcessor } from './processor.js';

export { createDiscordNotifier, DiscordRetryError } from './notifier.js';
export type {
  DiscordMode,
  DiscordNotifier,
  DiscordNotifierDeps,
  DiscordOverrides,
  NotifyResult,
  SlotOutcome,
} from './notifier.js';
export { createDiscordProcessor } from './processor.js';

/**
 * Wires the `discord` consumer. Webhook URLs come from the credential store (ADR-004, ADR-012):
 * environment first, then the encrypted database. Nothing is configured by default, so the default
 * is the explicit mock mode of the notifier.
 */
export function createDiscordRegistration(context: ProcessorContext) {
  const { config, database, logger } = context;
  const notifier = createDiscordNotifier({
    database,
    logger,
    channelMap: config.DISCORD_CHANNEL_MAP,
    ticketKeyPrefix: config.TICKET_KEY_PREFIX,
    appUrl: config.APP_URL,
    isProduction: config.NODE_ENV === 'production',
    credentials: createCredentialStore({
      database,
      kms: localKmsFromConfig(config),
      env: pickCredentialEnv(config),
    }),
    ...(context.overrides.discord === undefined ? {} : { overrides: context.overrides.discord }),
  });
  return createDiscordProcessor({ notifier });
}
