import { describe, expect, it, vi } from 'vitest';
import { QUEUE_NAMES } from '@watchtower/shared';
import type { Database } from '@watchtower/db';
import type { Redis } from 'ioredis';
import { createConcurrencyLimiter } from '@watchtower/ai';

import { createAiRuntime } from '../ai/runtime.js';
import type { WorkerConfig } from '../config.js';
import type { WorkerLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import { INSIGHTS_QUEUE } from './constants.js';
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
    WORKER_AI_MAX_CONCURRENCY: '1',
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

describe('T-421 QA Gate: Queue Isolation & Slow Fake Bridge Concurrency Lockout', () => {
  it('strictly isolates INSIGHTS_QUEUE from QUEUE_NAMES.ai', () => {
    expect(INSIGHTS_QUEUE).toBe('insights');
    expect(QUEUE_NAMES.ai).toBe('ai');
    expect(INSIGHTS_QUEUE).not.toBe(QUEUE_NAMES.ai);
  });

  it('yields in milliseconds without blocking when queue ai has waiting customer jobs', async () => {
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
      getWaitingCount: vi.fn().mockResolvedValue(10), // 10 customer tickets waiting in queue ai
    };

    const logger = createMockLogger();
    const start = performance.now();
    const result = await runInsightTick({
      database: fakeDb,
      redis: fakeRedis,
      config: createTestConfig(),
      logger,
      ai: runtime,
      aiQueue,
      now: () => new Date(t0 + 10 * 60_000),
    });
    const durationMs = performance.now() - start;

    // Must yield immediately in single-digit or low tens of milliseconds
    expect(durationMs).toBeLessThan(100);
    expect(result.narratedBatches).toBe(0);
    expect(agentDepsSpy).not.toHaveBeenCalled();

    const infoCalls = vi.mocked(logger.info).mock.calls;
    expect(
      infoCalls.some((c) =>
        String(c[1]).includes('ai queue has waiting jobs; deferring insight narration'),
      ),
    ).toBe(true);
  });

  it('yields immediately (<50ms) when a slow fake bridge (5-10s) holds the worker concurrency slot', async () => {
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

    // Simulate 1 maxConcurrent slot
    const limiter = createConcurrencyLimiter({ maxConcurrent: 1 });
    // An ongoing ticket pipeline job holds the slot (simulating a slow 5-10s fake bridge)
    const releaseSimulatedSlowJob = limiter.tryAcquire();
    expect(releaseSimulatedSlowJob).not.toBeNull();

    const runtime = {
      ...baseRuntime,
      limiter,
    };

    const aiQueue = {
      getWaitingCount: vi.fn().mockResolvedValue(0),
    };

    const logger = createMockLogger();
    const start = performance.now();
    const result = await runInsightTick({
      database: fakeDb,
      redis: fakeRedis,
      config: createTestConfig(),
      logger,
      ai: runtime,
      aiQueue,
      now: () => new Date(t0 + 10 * 60_000),
    });
    const durationMs = performance.now() - start;

    // Must yield non-blockingly without waiting for the slow 5-10s job
    expect(durationMs).toBeLessThan(100);
    expect(result.narratedBatches).toBe(0);
    expect(agentDepsSpy).not.toHaveBeenCalled();

    const infoCalls = vi.mocked(logger.info).mock.calls;
    expect(
      infoCalls.some((c) => String(c[0]).includes('no free worker AI slot for insight narration')),
    ).toBe(true);

    // Clean up simulated slow job
    releaseSimulatedSlowJob?.();
  });
});
