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
// LINE has no live credential in the stack: every account is answered by the in-memory transport of
// line-transport.mjs, which records each call in E2E_LINE_LOG for the test process to read (T-113).
const { createStackLineTransport } = await import('./line-transport.mjs');
const lineLog = process.env.E2E_LINE_LOG;
const lineTransport = lineLog
  ? await createStackLineTransport({ root, logFile: lineLog })
  : undefined;
// Raw inbound payloads go to object storage. The stack has no object storage (no MinIO, and no credential
// for one): an in-memory store keeps them for the life of the run.
const { createMemoryObjectStore } = await load('ingest/object-store.js');
const worker = await startWorker(config, logger, {
  ...(prefix ? { queuePrefix: prefix } : {}),
  overrides: {
    ingest: { store: createMemoryObjectStore() },
    ...(lineTransport ? { line: { transportFor: () => lineTransport } } : {}),
  },
});

const stop = () => {
  worker.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
