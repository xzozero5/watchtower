// Starts apps/worker the way main.ts does, with the same BullMQ prefix as the api of this run.
// Used by tools/e2e-stack/stack.mjs; needs `pnpm --filter @watchtower/worker build` first.
import { appendFileSync } from 'node:fs';
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

// Gmail has no credential either (GMAIL_MOCK_ENABLED): the mock runtime answers every mailbox. It is wrapped
// so each reply the stack "sends" is appended to E2E_GMAIL_LOG (headers and thread id, never the body), which
// is how a test sees that a reply went into the thread of the customer's mail.
const { createMockGmailRuntime } = await load('gmail/runtime.js');
const { createDatabase } = await import(
  pathToFileURL(join(root, 'packages', 'db', 'dist', 'index.js')).href
);
const gmailDb = createDatabase({
  url: process.env.DATABASE_URL,
  max: 2,
  applicationName: 'e2e-gmail-runtime',
});
const mockGmail = createMockGmailRuntime({ database: gmailDb });
const gmailLog = process.env.E2E_GMAIL_LOG;
const gmailRuntime = {
  ...mockGmail,
  async senderFor(account) {
    const sender = await mockGmail.senderFor(account);
    if (!sender || !gmailLog) return sender;
    return {
      from: sender.from,
      async send(input) {
        const result = await sender.send(input);
        appendFileSync(
          gmailLog,
          `${JSON.stringify({
            at: Date.now(),
            requestedThreadId: input.threadId ?? null,
            gmailThreadId: result.gmailThreadId,
            messageId: result.messageId,
            headers: result.built,
          })}
`,
        );
        return result;
      },
    };
  },
};
const worker = await startWorker(config, logger, {
  ...(prefix ? { queuePrefix: prefix } : {}),
  overrides: {
    gmail: { runtime: gmailRuntime },
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
