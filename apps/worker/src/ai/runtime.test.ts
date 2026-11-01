import type { AiRunSink } from '@watchtower/ai';
import type { Database } from '@watchtower/db';
import { createAiRunRecorder } from '@watchtower/domain';
import { describe, expect, it } from 'vitest';

import { createLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import { createAiRuntime } from './runtime.js';

const database = { db: {} } as unknown as Database;

describe('createAiRuntime', () => {
  it('builds the mock runtime by default, with the budget caps from the config', () => {
    const runtime = createAiRuntime(
      testConfig({ AI_DAILY_COST_CAP_USD: '2.5', AI_DAILY_TOKEN_CAP: '1234' }),
      database,
      createLogger(testConfig()),
    );
    expect(runtime.provider).toBe('mock');
    expect(runtime.caps).toEqual({ dailyCostUsd: 2.5, dailyTokens: 1234, alertPercent: 80 });
    expect(runtime.prompts.list().map((prompt) => prompt.id)).toEqual(
      expect.arrayContaining(['classifier', 'summarizer']),
    );
  });

  it('gives each ticket a redactor that knows its people, and never the same session twice', () => {
    const runtime = createAiRuntime(testConfig(), database, createLogger(testConfig()));
    const deps = runtime.agentDeps(['Somchai Jaidee']);
    const session = deps.redactor.session({ scope: 'ticket-1' });
    expect(session.redact('Hello Somchai Jaidee')).not.toContain('Somchai');
    expect(deps.redactor.session({ scope: 'ticket-1' })).not.toBe(session);
  });

  it('AI_PROVIDER selects the adapter: a real provider gets a runtime, never the mock (T-132)', () => {
    for (const provider of ['mock', 'anthropic', 'vertex'] as const) {
      const config = testConfig({ AI_PROVIDER: provider });
      expect(createAiRuntime(config, database, createLogger(config))).toMatchObject({ provider });
    }
  });

  it('is ready on mock without any credential', async () => {
    const runtime = createAiRuntime(testConfig(), database, createLogger(testConfig()), {
      credentials: { read: () => Promise.reject(new Error('must not be read for mock')) },
    });
    await expect(runtime.readiness()).resolves.toEqual({ ready: true, problems: [] });
  });

  it('says what is missing for a selected provider and reports ready only when all is there', async () => {
    const full = {
      AI_PROVIDER: 'anthropic',
      AI_MODEL_DEEP: 'label-deep',
      AI_MODEL_STANDARD: 'label-standard',
      AI_MODEL_LIGHT: 'label-light',
      AI_MODEL_PRICES: JSON.stringify({
        'label-deep': { inputUsdPerMTok: 1, outputUsdPerMTok: 1 },
        'label-standard': { inputUsdPerMTok: 1, outputUsdPerMTok: 1 },
        'label-light': { inputUsdPerMTok: 1, outputUsdPerMTok: 1 },
      }),
    };
    const build = (env: Record<string, string>, held: Record<string, string>) => {
      const config = testConfig(env);
      return createAiRuntime(config, database, createLogger(config), {
        credentials: { read: () => Promise.resolve(held) },
      });
    };

    const noKey = await build(full, {}).readiness();
    expect(noKey.ready).toBe(false);
    expect(noKey.problems).toEqual([expect.stringContaining('Anthropic API key')]);

    const noModels = await build(
      { AI_PROVIDER: 'anthropic' },
      { anthropicApiKey: 'k' },
    ).readiness();
    expect(noModels.ready).toBe(false);
    expect(noModels.problems).toContain('AI_MODEL_DEEP is not set');

    await expect(build(full, { anthropicApiKey: 'k' }).readiness()).resolves.toEqual({
      ready: true,
      problems: [],
    });

    const vertex = await build(
      { ...full, AI_PROVIDER: 'vertex' },
      { vertexProjectId: 'example-project', vertexLocation: 'asia-southeast1' },
    ).readiness();
    expect(vertex.problems).toEqual(['no Vertex access token source is wired in the worker']);
  });

  it('a credential store that cannot be read is a problem, not a crash and not a silent mock', async () => {
    const config = testConfig({ AI_PROVIDER: 'anthropic' });
    const runtime = createAiRuntime(config, database, createLogger(config), {
      credentials: { read: () => Promise.reject(new Error('boom')) },
    });
    const state = await runtime.readiness();
    expect(state.ready).toBe(false);
    expect(state.problems).toContain('the credential store could not be read');
  });

  it('the domain recorder is an AiRunSink (compile-time pin of the structural match)', () => {
    const sink: AiRunSink = createAiRunRecorder({ db: {} as never });
    expect(typeof sink.record).toBe('function');
  });
});
