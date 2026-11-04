import { ConfigError, claudeCliRemoteWarning } from '@watchtower/shared';

import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { startWorker } from './worker.js';

async function main(): Promise<void> {
  // Validate the environment first; a ConfigError names variables, never values.
  const config = loadConfig(process.env);
  const logger = createLogger(config);
  const remoteWarning = claudeCliRemoteWarning(config);
  if (remoteWarning !== undefined) logger.warn(remoteWarning);
  const worker = await startWorker(config, logger);

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    worker.close().then(
      () => {
        process.exit(0);
      },
      (error: unknown) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => {
    stop('SIGTERM');
  });
  process.on('SIGINT', () => {
    stop('SIGINT');
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
