// Starts apps/api the way main.ts does, but with a BullMQ prefix of its own (E2E_QUEUE_PREFIX) so
// that a run never shares queues or realtime channels with another api or worker on the same Redis.
// Used by tools/e2e-stack/stack.mjs; needs `pnpm --filter @watchtower/api build` first.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..', '..');
const load = (file) => import(pathToFileURL(join(root, 'apps', 'api', 'dist', file)).href);

const { loadConfig } = await load('config/config.js');
const { createLogger } = await load('logging/logger.js');
const { createApp } = await load('bootstrap.js');

const config = loadConfig(process.env);
const logger = createLogger(config);
const prefix = process.env.E2E_QUEUE_PREFIX;
const app = await createApp(config, logger, prefix ? { queuePrefix: prefix } : {});
if (config.AI_AUTOSEND_ENABLED) {
  // The same as main.ts (ADR-025 section 2): one audit row per boot of a process that runs with the flag on.
  const { recordAutosendFlagBoot } = await import(
    pathToFileURL(join(root, 'packages', 'domain', 'dist', 'index.js')).href
  );
  const { DATABASE } = await load('database/database.module.js');
  await recordAutosendFlagBoot(app.get(DATABASE).db, 'api').catch(() => undefined);
}
await app.listen(config.listenPort, config.HOST);
logger.info({ port: config.listenPort }, 'e2e api listening');
