import {
  ProviderUnavailableError,
  createRedactor,
  type AiSettings,
  type LlmRequest,
} from '@watchtower/ai';
import { describe, expect, it, vi } from 'vitest';

import { createLogger } from '../logger.js';
import { createReplayFetch, forbiddenFetch, readFixture } from '../testing/replay-fetch.js';
import { testConfig } from '../testing/support.js';
import { createLiveProvider, type AiCredentials } from './live-provider.js';
import { UNCONFIGURED_MODEL, buildAiSettings } from './settings.js';

// A made-up value that only has to be non-empty. It is not a credential.
const FAKE_KEY = 'test-key-not-a-secret';
const PRICES = JSON.stringify({
  'label-deep': { inputUsdPerMTok: 10, outputUsdPerMTok: 50 },
  'label-standard': { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  'label-light': { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
});
const MODELS = {
  AI_MODEL_DEEP: 'label-deep',
  AI_MODEL_STANDARD: 'label-standard',
  AI_MODEL_LIGHT: 'label-light',
  AI_MODEL_PRICES: PRICES,
};
const fixture = readFixture('anthropic-classifier.json');

function settingsFor(provider: 'anthropic' | 'vertex', extra: Record<string, string> = {}) {
  return buildAiSettings(testConfig({ AI_PROVIDER: provider, ...MODELS, ...extra })).settings;
}

/** A request built the legitimate way: through the redactor, so the text is `RedactedText`. */
function request(settings: AiSettings, tier: LlmRequest['tier'] = 'light'): LlmRequest {
  const session = createRedactor({ names: () => ['Somchai Jaidee'] }).session({ scope: 't-1' });
  return {
    model: settings.tiers[tier].model,
    tier,
    prompt: { id: 'classifier', version: 1, hash: 'a'.repeat(64) },
    system: session.redact('You classify support tickets.'),
    messages: [
      {
        role: 'user',
        content: session.redact('Hi, I am Somchai Jaidee. Write to somchai@customer.example.test'),
      },
    ],
    maxOutputTokens: 100,
  };
}

function setup(options: {
  credentials?: AiCredentials | (() => Promise<AiCredentials>);
  kind?: 'anthropic' | 'vertex';
  settings?: AiSettings;
  fetch?: Parameters<typeof createLiveProvider>[0]['fetch'];
  vertexAccessToken?: () => Promise<string>;
  now?: () => number;
}) {
  const logger = createLogger(testConfig());
  const error = vi.spyOn(logger, 'error');
  const kind = options.kind ?? 'anthropic';
  const settings = options.settings ?? settingsFor(kind);
  const credentials = options.credentials ?? { anthropicApiKey: FAKE_KEY };
  const provider = createLiveProvider({
    kind,
    settings,
    credentials: {
      read: typeof credentials === 'function' ? credentials : () => Promise.resolve(credentials),
    },
    fetch: options.fetch ?? forbiddenFetch,
    ...(options.vertexAccessToken === undefined
      ? {}
      : { vertexAccessToken: options.vertexAccessToken }),
    logger,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { provider, settings, error };
}

describe('createLiveProvider: anthropic', () => {
  it('sends the redacted request through the injected fetch only, with the key from the reader', async () => {
    const replay = createReplayFetch(fixture);
    const { provider, settings } = setup({ fetch: replay.fetch });
    const response = await provider.generate(request(settings));

    expect(provider.kind).toBe('anthropic');
    expect(response.usage).toEqual({ inputTokens: 1000, outputTokens: 50 });
    expect(replay.requests).toHaveLength(1);
    const sent = replay.requests[0];
    expect(sent?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent?.headers['x-api-key']).toBe(FAKE_KEY);
    expect((sent?.body as { model: string }).model).toBe('label-light');
  });

  it('redaction proof: the outgoing body holds placeholders, never the name or the address', async () => {
    const replay = createReplayFetch(fixture);
    const { provider, settings } = setup({ fetch: replay.fetch });
    await provider.generate(request(settings));

    const wire = replay.requests[0]?.rawBody ?? '';
    expect(wire).toContain('[EMAIL_1]');
    expect(wire).toContain('[NAME_1]');
    expect(wire).not.toContain('somchai@customer.example.test');
    expect(wire).not.toContain('Somchai');
    expect(wire).not.toContain('Jaidee');
    expect(wire).not.toContain(FAKE_KEY);
  });

  it('refuses without a key: ProviderUnavailableError, nothing sent, logged once per minute', async () => {
    let clock = 0;
    const { provider, settings, error } = setup({
      credentials: {},
      fetch: forbiddenFetch,
      now: () => clock,
    });
    await expect(provider.generate(request(settings))).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    await expect(provider.generate(request(settings))).rejects.toThrow(/no API key/);
    expect(error).toHaveBeenCalledTimes(1);
    clock = 61_000;
    await expect(provider.generate(request(settings))).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('treats a blank key as no key', async () => {
    const { provider, settings } = setup({ credentials: { anthropicApiKey: '   ' } });
    await expect(provider.generate(request(settings))).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it('refuses when the credential store cannot be read, without leaking the cause', async () => {
    const { provider, settings } = setup({
      credentials: () => Promise.reject(new Error('db password=hunter2 refused')),
    });
    const failure = await provider.generate(request(settings)).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect((failure as Error).message).not.toContain('hunter2');
  });

  it('reads the credentials on every call, so a key saved after boot is used without a restart', async () => {
    const replay = createReplayFetch(fixture);
    let held: AiCredentials = {};
    const { provider, settings } = setup({
      credentials: () => Promise.resolve(held),
      fetch: replay.fetch,
    });
    await expect(provider.generate(request(settings))).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    held = { anthropicApiKey: FAKE_KEY };
    await provider.generate(request(settings));
    expect(replay.requests).toHaveLength(1);
  });

  it('refuses a tier with no model id, and a model with no price (the cost cap must be able to count)', async () => {
    const noModel = settingsFor('anthropic', { AI_MODEL_LIGHT: '' });
    expect(noModel.tiers.light.model).toBe(UNCONFIGURED_MODEL);
    const first = setup({ settings: noModel });
    await expect(first.provider.generate(request(noModel))).rejects.toThrow(/no model id/);

    const noPrice = settingsFor('anthropic', {
      AI_MODEL_PRICES: JSON.stringify({
        'label-deep': { inputUsdPerMTok: 1, outputUsdPerMTok: 1 },
      }),
    });
    const second = setup({ settings: noPrice });
    await expect(second.provider.generate(request(noPrice))).rejects.toThrow(/no price/);
  });

  it('does not fall back to the environment for the key', async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'env-key-must-not-be-used';
    try {
      const { provider, settings } = setup({ credentials: {}, fetch: forbiddenFetch });
      await expect(provider.generate(request(settings))).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});

describe('createLiveProvider: vertex', () => {
  const vertexReply = {
    candidates: [
      {
        content: { role: 'model', parts: [{ text: 'ok' }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
  };

  it('refuses without a project, a location or an access token source', async () => {
    const settings = settingsFor('vertex');
    const token = () => Promise.resolve('token-not-a-secret');
    for (const setupOptions of [
      { credentials: { vertexLocation: 'asia-southeast1' }, vertexAccessToken: token },
      { credentials: { vertexProjectId: 'example-project' }, vertexAccessToken: token },
      { credentials: { vertexProjectId: 'example-project', vertexLocation: 'asia-southeast1' } },
    ]) {
      const { provider } = setup({ kind: 'vertex', settings, ...setupOptions });
      await expect(provider.generate(request(settings))).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
    }
  });

  it('calls Vertex through the injected fetch with a bearer token and redacted text', async () => {
    const replay = createReplayFetch(vertexReply);
    const settings = settingsFor('vertex');
    const { provider } = setup({
      kind: 'vertex',
      settings,
      credentials: { vertexProjectId: 'example-project', vertexLocation: 'asia-southeast1' },
      fetch: replay.fetch,
      vertexAccessToken: () => Promise.resolve('token-not-a-secret'),
    });
    const response = await provider.generate(request(settings));
    expect(response.text).toBe('ok');
    const sent = replay.requests[0];
    expect(sent?.url).toContain('asia-southeast1-aiplatform.googleapis.com');
    expect(sent?.url).toContain('projects/example-project');
    expect(sent?.headers.authorization).toBe('Bearer token-not-a-secret');
    expect(sent?.rawBody).toContain('[EMAIL_1]');
    expect(sent?.rawBody).not.toContain('somchai@customer.example.test');
    expect(sent?.rawBody).not.toContain('Somchai');
  });
});
