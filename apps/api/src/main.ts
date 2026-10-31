import 'reflect-metadata';

import { ConfigError } from '@watchtower/shared';

import { createApp } from './bootstrap.js';
import { loadConfig } from './config/config.js';
import { createLogger } from './logging/logger.js';

async function main(): Promise<void> {
  // Validate the environment before anything else; a ConfigError names variables, never values.
  const config = loadConfig(process.env);
  const logger = createLogger(config);
  const app = await createApp(config, logger);
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
