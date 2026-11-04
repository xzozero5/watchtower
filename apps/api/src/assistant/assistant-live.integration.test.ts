import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { AI_STATUS_REDIS_KEY, assistantReplySchema, type AssistantReply } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import { signIn, type Persona } from '../testing/ticketing.js';

// ADR-023 "Live provider": the assistant on AI_PROVIDER=claude-cli, through the real runtime of the
// api (createLiveProvider, redaction, ai_run, budget). The "bridge" is a fake HTTP server on loopback
// that speaks the bridge protocol; no provider is called and no key is used.
const net = disableNetConnect();
const secret = randomBytes(12).toString('hex');

interface Seen {
  readonly authorization: string | undefined;
  readonly body: { model: string; system: string; messages: { content: string }[] };
}
const seen: Seen[] = [];
let mode: 'ok' | 'busy' | 'hang' = 'ok';
/** Bridge-side connections that ended before the bridge answered (the api gave up on them). */
let abandoned = 0;
let bridge: Server;
let h: Harness;
let redis: Redis;
let agent: Persona;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

beforeAll(async () => {
  bridge = createServer((request, response) => {
    void readBody(request).then((raw) => {
      const body = JSON.parse(raw) as Seen['body'];
      seen.push({ authorization: request.headers.authorization, body });
      response.setHeader('content-type', 'application/json');
      if (mode === 'hang') {
        // Never answers; counts the calls the api abandons.
        response.on('close', () => {
          if (!response.writableFinished) abandoned += 1;
        });
        return;
      }
      if (mode === 'busy') {
        response.statusCode = 429;
        response.end(JSON.stringify({ error: 'busy' }));
        return;
      }
      // The plan comes first, then the answer (the assistant makes exactly those two calls).
      const isPlan = seen.length % 2 === 1;
      const text = isPlan
        ? JSON.stringify({ calls: [] })
        : JSON.stringify({
            claims: [{ text: 'Nothing needs attention right now.', evidenceIds: [] }],
            proposals: [],
          });
      response.end(
        JSON.stringify({ text, model: body.model, usage: { inputTokens: 40, outputTokens: 12 } }),
      );
    });
  });
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  const port = (bridge.address() as AddressInfo).port;
  h = await startHarness({
    env: {
      AI_PROVIDER: 'claude-cli',
      CLAUDE_CLI_BRIDGE_URL: `http://127.0.0.1:${String(port)}`,
      CLAUDE_CLI_BRIDGE_TOKEN: secret,
      AI_MODEL_DEEP: 'sonnet',
      AI_MODEL_STANDARD: 'sonnet',
      AI_MODEL_LIGHT: 'sonnet',
      AI_MODEL_PRICES: JSON.stringify({ sonnet: { inputUsdPerMTok: 0, outputUsdPerMTok: 0 } }),
    },
  });
  redis = new Redis(h.config.REDIS_URL);
  agent = await signIn(h, 'agent');
});

afterAll(async () => {
  redis.disconnect();
  await h.close();
  await new Promise((resolve) => bridge.close(resolve));
  expect(net.blocked()).toEqual([]);
  net.restore();
});

const online = () =>
  redis.set(
    AI_STATUS_REDIS_KEY,
    JSON.stringify({ status: 'online', checkedAt: new Date().toISOString() }),
    'EX',
    60,
  );

const ask = (text: string, signal?: AbortSignal) =>
  agent.client.post<AssistantReply>(
    '/v1/assistant/messages',
    { text, locale: 'en' },
    signal === undefined ? {} : { signal },
  );

describe('the assistant on claude-cli (fake bridge)', () => {
  it('answers through the bridge with the bearer, redacted text, and an audited ai_run row', async () => {
    await online();
    mode = 'ok';
    seen.length = 0;
    const response = await ask('what is going on? my address is jane.doe@customer.example');
    expect(response.status).toBe(200);
    const reply = assistantReplySchema.parse(response.body);
    expect(reply.state).toBe('ok');
    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.authorization).toBe(`Bearer ${secret}`);
      expect(call.body.model).toBe('sonnet');
      expect(JSON.stringify(call.body)).not.toContain('jane.doe@customer.example');
    }
    const runs = await h.db.owner.pool.query<{ provider: string; status: string; model: string }>(
      `SELECT provider, status, model FROM ai_run WHERE provider = 'claude-cli' ORDER BY started_at`,
    );
    expect(runs.rows.length).toBeGreaterThanOrEqual(2);
    expect(runs.rows.every((row) => row.status === 'ok' && row.model === 'sonnet')).toBe(true);
    // Never a silent fallback to the mock.
    const mock = await h.db.owner.pool.query(`SELECT 1 FROM ai_run WHERE provider = 'mock'`);
    expect(mock.rowCount).toBe(0);
  });

  it('answers unavailable without calling the bridge when the AI host is reported offline', async () => {
    await redis.del(AI_STATUS_REDIS_KEY);
    // The status is cached for a few seconds in the api: wait it out.
    await new Promise((resolve) => setTimeout(resolve, 5200));
    seen.length = 0;
    const response = await ask('anything');
    expect(response.status).toBe(200);
    expect(assistantReplySchema.parse(response.body).state).toBe('unavailable');
    expect(seen).toHaveLength(0);
  }, 15_000);

  it('answers unavailable (not a made-up answer) when the bridge is busy', async () => {
    await online();
    await new Promise((resolve) => setTimeout(resolve, 5200));
    mode = 'busy';
    seen.length = 0;
    const response = await ask('anything else');
    expect(response.status).toBe(200);
    expect(assistantReplySchema.parse(response.body).state).toBe('unavailable');
    expect(seen.length).toBeGreaterThan(0);
  }, 15_000);
});

describe('one answer at a time per person, and no work for a page that was closed (T-155a C-4)', () => {
  const until = async (done: () => boolean, ms = 8000): Promise<void> => {
    const stop = Date.now() + ms;
    while (!done() && Date.now() < stop) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(done()).toBe(true);
  };

  it('answers 429 assistant_busy to a second message while the first is unanswered', async () => {
    await online();
    mode = 'hang';
    seen.length = 0;
    abandoned = 0;
    const first = new AbortController();
    const slow = ask('first question', first.signal).catch(() => undefined);
    await until(() => seen.length > 0);
    const second = await ask('second question, same person');
    expect(second.status).toBe(429);
    expect((second.body as unknown as { code: string }).code).toBe('assistant_busy');
    // Nothing was sent to the bridge for it, and it did not use the hourly allowance.
    expect(seen).toHaveLength(1);

    // The person closes the page: the api drops the call to the bridge, so the bridge can stop work.
    first.abort();
    await until(() => abandoned > 0);
    await slow;
    // The person may ask again once the api has finished with the abandoned turn.
    mode = 'ok';
    seen.length = 0;
    await online();
    let again = await ask('and now?');
    for (let i = 0; i < 50 && again.status === 429; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      again = await ask('and now?');
    }
    expect(again.status).toBe(200);
  }, 30_000);
});
