import 'reflect-metadata';

import type { Database } from '@watchtower/db';
import { recordAutosendFlagBoot } from '@watchtower/domain';
import { ConfigError, claudeCliRemoteWarning } from '@watchtower/shared';

import { createApp } from './bootstrap.js';
import { loadConfig } from './config/config.js';
import { DATABASE } from './database/database.module.js';
import { createLogger } from './logging/logger.js';

async function main(): Promise<void> {
  // Validate the environment before anything else; a ConfigError names variables, never values.
  const config = loadConfig(process.env);
  const logger = createLogger(config);
  const remoteWarning = claudeCliRemoteWarning(config);
  if (remoteWarning !== undefined) logger.warn(remoteWarning);
  const app = await createApp(config, logger);
  if (config.AI_AUTOSEND_ENABLED) {
    // ADR-025 section 2: the owner can see from the log, and from one audit row per boot, that this process
    // runs with the flag on.
    logger.warn(
      'AI_AUTOSEND_ENABLED=true: intents at stage 3 can send replies without a person (ADR-025)',
    );
    await recordAutosendFlagBoot(app.get<Database>(DATABASE).db, 'api').catch((error: unknown) => {
      logger.error({ err: error }, 'could not record the auto-send flag at boot');
    });
  }
  await app.listen(config.listenPort, config.HOST);
  logger.info(
    { host: config.HOST, port: config.listenPort, docs: config.docsEnabled },
    'api listening',
  );
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // Plain text on stderr: no logger exists yet and the message is safe to print.
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
