// Starts apps/worker the way main.ts does, with the same BullMQ prefix as the api of this run.
// Used by tools/e2e-stack/stack.mjs; needs `pnpm --filter @watchtower/worker build` first.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..', '..');
const load = (file) => import(pathToFileURL(join(root, 'apps', 'worker', 'dist', file)).href);

const { loadConfig } = await load('config.js');
const { createLogger } = await load('logger.js');
const { startWorker } = await load('worker.js');

const config = loadConfig(process.env);
const logger = createLogger(config);
const prefix = process.env.E2E_QUEUE_PREFIX;
const worker = await startWorker(config, logger, prefix ? { queuePrefix: prefix } : {});

const stop = () => {
  worker.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
