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
// Discord has no bot token either: the bot transport is the in-memory fake, wrapped so each call it records
// (the final JSON a live transport would send: content and buttons, never a token) is appended to
// E2E_DISCORD_LOG. The alert escalation and the incident threads share one transport, as they would one bot.
const discordLog = process.env.E2E_DISCORD_LOG;
let discordBot;
if (discordLog) {
  const { discord } = await import(
    pathToFileURL(join(root, 'packages', 'channels', 'dist', 'index.js')).href
  );
  class RecordingBot extends discord.FakeBotTransport {
    #record() {
      const call = this.calls.at(-1);
      appendFileSync(discordLog, `${JSON.stringify({ ...call, at: call.at.getTime() })}\n`);
    }
    async postMessage(...args) {
      const result = await super.postMessage(...args);
      this.#record();
      return result;
    }
    async editMessage(...args) {
      const result = await super.editMessage(...args);
      this.#record();
      return result;
    }
    async createThread(...args) {
      const result = await super.createThread(...args);
      this.#record();
      return result;
    }
    async postInThread(...args) {
      const result = await super.postInThread(...args);
      this.#record();
      return result;
    }
  }
  discordBot = new RecordingBot();
}
// Stage 3 e2e (T-306b): with E2E_AI_FAKE_LIVE_FILE the AI layer gets a provider of kind `anthropic` that is the dev
// mock inside (no network; the loopback-only guard stays on), because a grade made by kind `mock` can never clear an
// automatic send (decide.ts `grade_mock`). The file is read on every call so a test can change the grader's model and
// answer between tickets: { drafterModel, graderModel, score, violations: [...] }.
let aiOverrides;
const fakeLiveFile = process.env.E2E_AI_FAKE_LIVE_FILE;
if (fakeLiveFile) {
  const { readFileSync } = await import('node:fs');
  const aiPkg = await import(pathToFileURL(join(root, 'packages', 'ai', 'dist', 'index.js')).href);
  const dev = new aiPkg.DevMockLlmProvider();
  const knobs = () => JSON.parse(readFileSync(fakeLiveFile, 'utf8'));
  const provider = {
    kind: 'anthropic',
    async generate(request) {
      if (request.prompt.id === 'grader_pre_send') {
        const k = knobs();
        return {
          text: JSON.stringify({ score: k.score ?? 0.95, violations: k.violations ?? [] }),
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5 },
          model: request.model,
        };
      }
      // The dev mock's drafter cites the first two cards it is shown, whatever they say. For a ticket whose evidence has
      // the customer-facing article of the scenario (titled "Reset a ...") the stack's drafter answers from
      // that card alone and cites it: the kind of reply an automatic send can be about (ADR-025 condition 9). Without
      // such a card it is the dev mock as it is.
      if (request.prompt.id === 'drafter') {
        const raw = request.messages[0]?.content ?? '';
        // A line is "[ev-1] kb (customer-safe) (mock data): title snippet": the flags come in any number of brackets.
        const cards = [...raw.matchAll(/^\[(ev-\d+)\] kb((?: \([^)]*\))*): (.*)$/gm)];
        const card = cards.find(
          (match) => (match[2] ?? '').includes('customer-safe') && /reset a password/i.test(match[3] ?? ''),
        );
        if (card) {
          const sentence = (text, kind, evidenceIds, newParagraph) => ({ text, kind, evidenceIds, newParagraph });
          return {
            text: JSON.stringify({
              language: 'en',
              sentences: [
                sentence('Hello, thank you for contacting us.', 'courtesy', [], false),
                sentence('You can reset your password with the Forgot password link on the sign in page.', 'fact', [card[1]], true),
                sentence('If you have any questions, just reply to this message.', 'courtesy', [], true),
              ],
            }),
            finishReason: 'stop',
            usage: { inputTokens: 10, outputTokens: 5 },
            model: request.model,
          };
        }
      }
      const answer = await dev.generate(request);
      if (request.prompt.id === 'classifier') {
        // The dev mock's confidence is a hash of the input between 0.62 and 0.93; the tools and the draft only trust an
        // intent above AI_INTENT_SCOPE_MIN_CONFIDENCE, so a run would pass or not by chance. A confident classifier
        // makes the scenario deterministic; what is under test is the gate, not the classifier.
        try {
          const parsed = JSON.parse(answer.text);
          if (parsed.intentKey) parsed.confidence = Math.max(Number(parsed.confidence) || 0, 0.95);
          return { ...answer, text: JSON.stringify(parsed), model: request.model };
        } catch {
          return { ...answer, model: request.model };
        }
      }
      return { ...answer, model: request.model };
    },
  };
  const base = aiPkg.mockSettings();
  aiOverrides = {
    providers: { anthropic: provider },
    settings: {
      load: async () => {
        const k = knobs();
        const prices = {
          [k.drafterModel]: { inputUsdPerMTok: 0, outputUsdPerMTok: 0 },
          [k.graderModel]: { inputUsdPerMTok: 0, outputUsdPerMTok: 0 },
        };
        const tier = { provider: 'anthropic', model: k.drafterModel };
        return {
          ...base,
          tiers: { deep: tier, standard: tier, light: tier },
          agentModels: { grader: k.graderModel },
          prices: { ...base.prices, ...prices },
        };
      },
    },
  };
}
const worker = await startWorker(config, logger, {
  ...(prefix ? { queuePrefix: prefix } : {}),
  overrides: {
    ...(aiOverrides ? { ai: aiOverrides } : {}),
    gmail: { runtime: gmailRuntime },
    ingest: { store: createMemoryObjectStore() },
    ...(discordBot ? { alerts: { bot: discordBot }, incidents: { bot: discordBot } } : {}),
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
