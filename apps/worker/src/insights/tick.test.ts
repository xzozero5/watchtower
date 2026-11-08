import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@watchtower/db';
import type { Redis } from 'ioredis';

import { createAiRuntime } from '../ai/runtime.js';
import type { WorkerConfig } from '../config.js';
import type { WorkerLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import { runInsightTick } from './tick.js';
import { dirtyKey } from './marks.js';

vi.mock('./facts.js', () => ({
  buildFactsForElement: vi.fn().mockResolvedValue({
    asOf: '2026-11-08T00:00:00.000Z',
    element: 'dashboard.ops.sla',
    scopeKey: 'instance',
    period: 'd7',
    facts: [
      { id: 'open_tickets', kind: 'metric', value: 42, display: { th: '42', en: '42' } },
      { id: 'breach_rate_pct', kind: 'metric', value: 5, display: { th: '5%', en: '5%' } },
    ],
  }),
}));

function createMockLogger(): WorkerLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => createMockLogger(),
  } as unknown as WorkerLogger;
}

function createTestConfig(overrides?: Record<string, string | undefined>): WorkerConfig {
  return testConfig({
    AI_PROVIDER: 'mock',
    WORKER_AI_MAX_CONCURRENCY: '2',
    INSIGHT_DEBOUNCE_MINUTES: '3',
    INSIGHT_MAX_WAIT_MINUTES: '15',
    INSIGHT_MIN_INTERVAL_MINUTES: '30',
    INSIGHT_VIEWED_WITHIN_HOURS: '24',
    INSIGHT_NARRATION_TTL_HOURS: '6',
    INSIGHT_BUILDERS_PER_TICK: '20',
    INSIGHT_MAX_BATCH_ELEMENTS: '4',
    INSIGHT_STOP_AT_DAILY_PERCENT: '60',
    INSIGHT_CALLS_PER_HOUR: '6',
    INSIGHT_CALLS_PER_DAY: '60',
    INSIGHT_DAILY_TOKENS: '150000',
    INSIGHT_USER_SCOPED_CALLS_PER_DAY: '30',
    INSIGHT_USER_SCOPED_PER_USER_PER_DAY: '4',
    INSIGHT_USER_SCOPED_MIN_INTERVAL_MINUTES: '60',
    ...overrides,
  });
}

interface MockDbOptions {
  switches?: Array<{ key: string; isOn: boolean }>;
  feedbackStats?: { total: number; down: number };
  aiUsageTokens?: number;
  aiUsageCostUsd?: number;
  insightCallsToday?: number;
  insightTokensToday?: number;
  existingInsight?: Array<unknown>;
  users?: Array<unknown>;
  updateFn?: (val: unknown) => unknown;
}

function createMockDb(options?: MockDbOptions): Database {
  const switches = options?.switches ?? [
    { key: 'ai_kill_switch', isOn: false },
    { key: 'ai_stage_cap_pinned', isOn: false },
  ];
  const feedbackStats = options?.feedbackStats ?? { total: 0, down: 0 };
  const aiUsageTokens = options?.aiUsageTokens ?? 0;
  const aiUsageCostUsd = options?.aiUsageCostUsd ?? 0;
  const insightCallsToday = options?.insightCallsToday ?? 0;
  const insightTokensToday = options?.insightTokensToday ?? 0;
  const existingInsight = options?.existingInsight ?? [];
  const users = options?.users ?? [{ id: 'user-1', status: 'active' }];
  const updateSpy =
    options?.updateFn ?? vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });

  const select = vi.fn().mockImplementation((fields?: unknown) => {
    return {
      from: vi.fn().mockImplementation(() => {
        const queryObj = {
          where: vi.fn().mockImplementation(() => {
            const whereObj = {
              limit: vi
                .fn()
                .mockResolvedValue(existingInsight.length > 0 ? existingInsight : users),
              then: (resolve: (val: unknown) => unknown, reject?: (err: unknown) => unknown) => {
                if (fields && typeof fields === 'object') {
                  if ('cost' in fields || 'tokens' in fields) {
                    return Promise.resolve([
                      {
                        cost: String(aiUsageCostUsd),
                        tokens: String(aiUsageTokens),
                      },
                    ]).then(resolve, reject);
                  }
                  if ('total' in fields || 'down' in fields) {
                    return Promise.resolve([
                      {
                        total: feedbackStats.total,
                        down: feedbackStats.down,
                      },
                    ]).then(resolve, reject);
                  }
                  if ('calls' in fields) {
                    return Promise.resolve([
                      {
                        calls: insightCallsToday,
                        tokens: insightTokensToday,
                      },
                    ]).then(resolve, reject);
                  }
                }
                return Promise.resolve(existingInsight).then(resolve, reject);
              },
            };
            return whereObj;
          }),
          limit: vi.fn().mockResolvedValue(existingInsight),
          then: (resolve: (val: unknown) => unknown, reject?: (err: unknown) => unknown) => {
            return Promise.resolve(switches).then(resolve, reject);
          },
        };
        return queryObj;
      }),
    };
  });

  return {
    db: {
      select,
      transaction: vi
        .fn()
        .mockImplementation((callback: (tx: unknown) => unknown) => callback({ select })),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockResolvedValue([]),
          then: (resolve: (val: unknown) => unknown) => Promise.resolve([]).then(resolve),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: updateSpy,
      }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    },
  } as unknown as Database;
}

describe('runInsightTick: timing, debounce & max-wait (AC-J20)', () => {
  it('skips candidates whose changes are still within the 3m debounce window and under 15m max-wait', async () => {
    const t0 = 1_000_000_000_000;
    const key = dirtyKey('dashboard.ops.sla', 'instance', 'd7');

    const fakeRedis = {
      scan: vi.fn().mockResolvedValue(['0', [key]]),
      hgetall: vi.fn().mockResolvedValue({
        firstAt: String(t0),
        lastAt: String(t0 + 2 * 60_000), // changed 1m ago relative to now
      }),
      zremrangebyscore: vi.fn().mockResolvedValue(0),
      zrange: vi.fn().mockResolvedValue(['user-1:en']),
      del: vi.fn().mockResolvedValue(1),
    } as unknown as Redis;

    const fakeDb = createMockDb();

    // now is t0 + 2.5m (lastAt was t0 + 2m, so only 30s debounce elapsed, and firstAt was 2.5m ago < 15m)
    const result = await runInsightTick({
      database: fakeDb,
      redis: fakeRedis,
      config: createTestConfig(),
      logger: createMockLogger(),
      ai: undefined,
      now: () => new Date(t0 + 2.5 * 60_000),
    });

    expect(result.processedCandidates).toBe(0);
    expect(result.narratedBatches).toBe(0);
  });

  it('runs candidates when debounce period (3m) has passed since last change', async () => {
    const t0 = 1_000_000_000_000;
    const key = dirtyKey('dashboard.ops.sla', 'instance', 'd7');

    const fakeRedis = {
      scan: vi.fn().mockResolvedValue(['0', [key]]),
      hgetall: vi.fn().mockResolvedValue({
        firstAt: String(t0),
        lastAt: String(t0 + 1 * 60_000),
      }),
      zremrangebyscore: vi.fn().mockResolvedValue(0),
      zrange: vi.fn().mockResolvedValue(['user-1:en']),
      del: vi.fn().mockResolvedValue(1),
    } as unknown as Redis;

    const fakeDb = createMockDb();

    // now is t0 + 5m (lastAt was t0 + 1m, so 4m > 3m debounce)
    const result = await runInsightTick({
      database: fakeDb,
      redis: fakeRedis,
      config: createTestConfig(),
      logger: createMockLogger(),
      ai: undefined,
      now: () => new Date(t0 + 5 * 60_000),
    });

    expect(result.processedCandidates).toBe(1);
  });

  it('forces candidate to run when max-wait (15m) elapsed even if changes keep arriving (AC-J20)', async () => {
    const t0 = 1_000_000_000_000;
    const key = dirtyKey('dashboard.ops.sla', 'instance', 'd7');

    const fakeRedis = {
      scan: vi.fn().mockResolvedValue(['0', [key]]),
      hgetall: vi.fn().mockResolvedValue({
        firstAt: String(t0),
        lastAt: String(t0 + 15.5 * 60_000), // last change was 30s ago, debounce not met!
      }),
      zremrangebyscore: vi.fn().mockResolvedValue(0),
      zrange: vi.fn().mockResolvedValue(['user-1:en']),
      del: vi.fn().mockResolvedValue(1),
    } as unknown as Redis;

    const fakeDb = createMockDb();

    // now is t0 + 16m: firstAt was 16m ago >= 15m max-wait!
    const result = await runInsightTick({
      database: fakeDb,
      redis: fakeRedis,
      config: createTestConfig(),
      logger: createMockLogger(),
      ai: undefined,
      now: () => new Date(t0 + 16 * 60_000),
    });

    expect(result.processedCandidates).toBe(1);
  });
});

describe('runInsightTick: AC-J16 (unviewed in 24h & unchanged fingerprint)', () => {
  it('makes 0 LLM calls and clears dirty mark when an element has no viewers in 24h', async () => {
    const t0 = 1_000_000_000_000;
    const key = dirtyKey('dashboard.ops.sla', 'instance', 'd7');

    const delSpy = vi.fn().mockResolvedValue(1);
    const fakeRedis = {
      scan: vi.fn().mockResolvedValue(['0', [key]]),
      hgetall: vi.fn().mockResolvedValue({
        firstAt: String(t0),
        lastAt: String(t0),
      }),
      zremrangebyscore: vi.fn().mockResolvedValue(2), // 2 old views pruned
      zrange: vi.fn().mockResolvedValue([]), // 0 active viewers in 24h!
      del: delSpy,
    } as unknown as Redis;

    const fakeDb = createMockDb();
    const runtime = createAiRuntime(createTestConfig(), fakeDb, createMockLogger());
    const agentDepsSpy = vi.spyOn(runtime, 'agentDeps');

    const result = await runInsightTick({
      database: fakeDb,
      redis: fakeRedis,
      config: createTestConfig(),
      logger: createMockLogger(),
      ai: runtime,
      now: () => new Date(t0 + 10 * 60_000),
    });

    // Verified: 0 calls made, and dirty key cleared!
    expect(result.narratedBatches).toBe(0);
    expect(delSpy).toHaveBeenCalledWith(key);
    expect(agentDepsSpy).not.toHaveBeenCalled();
  });

  it('makes 0 LLM calls and extends expires_at when facts fingerprint is unchanged', async () => {
    const t0 = 1_000_000_000_000;
    const key = dirtyKey('dashboard.ops.sla', 'instance', 'd7');

    const delSpy = vi.fn().mockResolvedValue(1);
    const fakeRedis = {
      scan: vi.fn().mockResolvedValue(['0', [key]]),
      hgetall: vi.fn().mockResolvedValue({
        firstAt: String(t0),
        lastAt: String(t0),
      }),
      zremrangebyscore: vi.fn().mockResolvedValue(0),
      zrange: vi.fn().mockResolvedValue(['user-1:en']),
      del: delSpy,
    } as unknown as Redis;

    const { factsFingerprint } = await import('@watchtower/domain');
    const { INSIGHT_ELEMENTS } = await import('@watchtower/shared');
    const facts = [
      { id: 'open_tickets', kind: 'metric' as const, value: 42, display: { th: '42', en: '42' } },
      { id: 'breach_rate_pct', kind: 'metric' as const, value: 5, display: { th: '5%', en: '5%' } },
    ];
    const fp = factsFingerprint(facts, INSIGHT_ELEMENTS['dashboard.ops.sla'].materiality);

    const updateSpy = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
    const fakeDb = createMockDb({
      existingInsight: [
        {
          factsFingerprint: fp,
          generatedAt: new Date(t0 - 3600_000),
        },
      ],
      updateFn: updateSpy,
    });

    const runtime = createAiRuntime(createTestConfig(), fakeDb, createMockLogger());
    const agentDepsSpy = vi.spyOn(runtime, 'agentDeps');

    const result = await runInsightTick({
      database: fakeDb,
      redis: fakeRedis,
      config: createTestConfig(),
      logger: createMockLogger(),
      ai: runtime,
      now: () => new Date(t0 + 10 * 60_000),
    });

    expect(result.narratedBatches).toBe(0);
    expect(updateSpy).toHaveBeenCalled();
    expect(delSpy).toHaveBeenCalledWith(key);
    expect(agentDepsSpy).not.toHaveBeenCalled();
  });
});

describe('runInsightTick: AC-J21 (feedback gate auto-pause)', () => {
  it('auto-pauses narration of an element when 7-day 👎 exceeds 50% with >=20 votes', async () => {
    const t0 = 1_000_000_000_000;
    const key = dirtyKey('dashboard.ops.sla', 'instance', 'd7');

    const fakeRedis = {
      scan: vi.fn().mockResolvedValue(['0', [key]]),
      hgetall: vi.fn().mockResolvedValue({
        firstAt: String(t0),
        lastAt: String(t0),
      }),
      zremrangebyscore: vi.fn().mockResolvedValue(0),
      zrange: vi.fn().mockResolvedValue(['user-1:en']),
      del: vi.fn().mockResolvedValue(1),
    } as unknown as Redis;

    // Total 25 votes: 15 down (-1), 10 up (1) -> 60% down > 50%
    const fakeDb = createMockDb({
      feedbackStats: { total: 25, down: 15 },
    });

    const runtime = createAiRuntime(createTestConfig(), fakeDb, createMockLogger());
    const agentDepsSpy = vi.spyOn(runtime, 'agentDeps');

    const logger = createMockLogger();
    const result = await runInsightTick({
      database: fakeDb,
      redis: fakeRedis,
      config: createTestConfig(),
      logger,
      ai: runtime,
      now: () => new Date(t0 + 10 * 60_000),
    });

    // Narrated batches = 0 because it was auto-paused
    expect(result.narratedBatches).toBe(0);
    expect(agentDepsSpy).not.toHaveBeenCalled();
    const warnCalls = vi.mocked(logger.warn).mock.calls;
    expect(
      warnCalls.some((c) => String(c[1]).includes('auto-paused due to >50% negative feedback')),
    ).toBe(true);
  });
});

describe('runInsightTick: queue priority & limiter concurrency', () => {
  it('yields when queue ai has waiting jobs so insight narration never blocks main AI pipeline', async () => {
    const t0 = 1_000_000_000_000;
    const key = dirtyKey('dashboard.ops.sla', 'instance', 'd7');

    const fakeRedis = {
      scan: vi.fn().mockResolvedValue(['0', [key]]),
      hgetall: vi.fn().mockResolvedValue({
        firstAt: String(t0),
        lastAt: String(t0),
      }),
      zremrangebyscore: vi.fn().mockResolvedValue(0),
      zrange: vi.fn().mockResolvedValue(['user-1:en']),
      del: vi.fn().mockResolvedValue(1),
    } as unknown as Redis;

    const fakeDb = createMockDb();
    const runtime = createAiRuntime(createTestConfig(), fakeDb, createMockLogger());
    const agentDepsSpy = vi.spyOn(runtime, 'agentDeps');

    const aiQueue = {
      getWaitingCount: vi.fn().mockResolvedValue(3), // 3 tickets waiting for AI!
    };

    const logger = createMockLogger();
    const result = await runInsightTick({
      database: fakeDb,
      redis: fakeRedis,
      config: createTestConfig(),
      logger,
      ai: runtime,
      aiQueue,
      now: () => new Date(t0 + 10 * 60_000),
    });

    expect(result.narratedBatches).toBe(0);
    expect(agentDepsSpy).not.toHaveBeenCalled();
    const infoCalls = vi.mocked(logger.info).mock.calls;
    expect(
      infoCalls.some((c) =>
        String(c[1]).includes('ai queue has waiting jobs; deferring insight narration'),
      ),
    ).toBe(true);
  });

  it('yields when limiter.tryAcquire returns null (all worker slots busy)', async () => {
    const t0 = 1_000_000_000_000;
    const key = dirtyKey('dashboard.ops.sla', 'instance', 'd7');

    const fakeRedis = {
      scan: vi.fn().mockResolvedValue(['0', [key]]),
      hgetall: vi.fn().mockResolvedValue({
        firstAt: String(t0),
        lastAt: String(t0),
      }),
      zremrangebyscore: vi.fn().mockResolvedValue(0),
      zrange: vi.fn().mockResolvedValue(['user-1:en']),
      del: vi.fn().mockResolvedValue(1),
    } as unknown as Redis;

    const fakeDb = createMockDb();
    const baseRuntime = createAiRuntime(createTestConfig(), fakeDb, createMockLogger());
    const agentDepsSpy = vi.spyOn(baseRuntime, 'agentDeps');

    const { createConcurrencyLimiter } = await import('@watchtower/ai');
    const limiter = createConcurrencyLimiter({ maxConcurrent: 1 });
    const tryAcquireSpy = vi.spyOn(limiter, 'tryAcquire').mockReturnValue(null);
    const runtime = {
      ...baseRuntime,
      limiter,
    };

    const aiQueue = {
      getWaitingCount: vi.fn().mockResolvedValue(0),
    };

    const logger = createMockLogger();
    const result = await runInsightTick({
      database: fakeDb,
      redis: fakeRedis,
      config: createTestConfig(),
      logger,
      ai: runtime,
      aiQueue,
      now: () => new Date(t0 + 10 * 60_000),
    });

    expect(result.narratedBatches).toBe(0);
    expect(tryAcquireSpy).toHaveBeenCalled();
    expect(agentDepsSpy).not.toHaveBeenCalled();
    const infoCalls = vi.mocked(logger.info).mock.calls;
    expect(
      infoCalls.some((c) => String(c[0]).includes('no free worker AI slot for insight narration')),
    ).toBe(true);
  });
});

describe('runInsightTick: AC-J22 budget gates', () => {
  it('stops narration when app_ai_daily usage exceeds 60%', async () => {
    const t0 = 1_000_000_000_000;
    const key = dirtyKey('dashboard.ops.sla', 'instance', 'd7');

    const fakeRedis = {
      scan: vi.fn().mockResolvedValue(['0', [key]]),
      hgetall: vi.fn().mockResolvedValue({
        firstAt: String(t0),
        lastAt: String(t0),
      }),
      zremrangebyscore: vi.fn().mockResolvedValue(0),
      zrange: vi.fn().mockResolvedValue(['user-1:en']),
      del: vi.fn().mockResolvedValue(1),
    } as unknown as Redis;

    // Daily token limit in default caps is 500_000.
    // 60% of 500_000 is 300_000. 350_000 tokens used = 70% >= 60% stop threshold!
    const fakeDb = createMockDb({
      aiUsageTokens: 350_000,
    });

    const runtime = createAiRuntime(createTestConfig(), fakeDb, createMockLogger());
    const agentDepsSpy = vi.spyOn(runtime, 'agentDeps');

    const logger = createMockLogger();
    const result = await runInsightTick({
      database: fakeDb,
      redis: fakeRedis,
      config: createTestConfig(),
      logger,
      ai: runtime,
      now: () => new Date(t0 + 10 * 60_000),
    });

    expect(result.narratedBatches).toBe(0);
    expect(agentDepsSpy).not.toHaveBeenCalled();
    const infoCalls = vi.mocked(logger.info).mock.calls;
    expect(
      infoCalls.some((c) => String(c[1]).includes('insight tick: standing check paused narration')),
    ).toBe(true);
  });
});
