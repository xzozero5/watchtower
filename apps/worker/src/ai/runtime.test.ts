import type { AiRunSink } from '@watchtower/ai';
import type { Database } from '@watchtower/db';
import { createAiRunRecorder } from '@watchtower/domain';
import { describe, expect, it, vi } from 'vitest';

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
    expect(runtime?.provider).toBe('mock');
    expect(runtime?.caps).toEqual({ dailyCostUsd: 2.5, dailyTokens: 1234, alertPercent: 80 });
    expect(runtime?.prompts.list().map((prompt) => prompt.id)).toEqual(
      expect.arrayContaining(['classifier', 'summarizer']),
    );
  });

  it('gives each ticket a redactor that knows its people, and never the same session twice', () => {
    const runtime = createAiRuntime(testConfig(), database, createLogger(testConfig()));
    const deps = runtime?.agentDeps(['Somchai Jaidee']);
    const session = deps?.redactor.session({ scope: 'ticket-1' });
    expect(session?.redact('Hello Somchai Jaidee')).not.toContain('Somchai');
    expect(deps?.redactor.session({ scope: 'ticket-1' })).not.toBe(session);
  });

  it('stops the boot for an embedding provider that is not wired, never ignoring it (N5)', () => {
    expect(() =>
      createAiRuntime(
        testConfig({ EMBEDDING_PROVIDER: 'vertex' }),
        database,
        createLogger(testConfig()),
      ),
    ).toThrow(/EMBEDDING_PROVIDER=vertex is not wired yet/);
  });

  it('stays off for a provider that is not wired, and says so (fail closed to rules)', () => {
    const logger = createLogger(testConfig());
    const error = vi.spyOn(logger, 'error');
    for (const provider of ['anthropic', 'vertex']) {
      expect(
        createAiRuntime(testConfig({ AI_PROVIDER: provider }), database, logger),
      ).toBeUndefined();
    }
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('the domain recorder is an AiRunSink (compile-time pin of the structural match)', () => {
    const sink: AiRunSink = createAiRunRecorder({ db: {} as never });
    expect(typeof sink.record).toBe('function');
  });
});
