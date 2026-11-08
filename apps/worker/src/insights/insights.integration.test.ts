import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { DevMockLlmProvider } from '@watchtower/ai';
import { disableNetConnect } from '@watchtower/shared/testing';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAiRuntime } from '../ai/runtime.js';
import { createLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import { runInsightTick } from './tick.js';
import { dirtyKey, markDirty, markInsightDirty, userDirtyKey, viewedKey } from './marks.js';

// Embedded Element Insights integration tests (T-418, ADR-029 section 9).
// Runs against real disposable Postgres and Redis with network disabled.
const net = disableNetConnect();
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@127.0.0.1:47043/watchtower';
const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:48043';

let testDb: TestDatabase;
let appDb: Database;
let redis: Redis;
let config: ReturnType<typeof testConfig>;
let testUser: { id: string; email: string };

const owner = () => testDb.owner.db;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  config = testConfig({
    DATABASE_URL: testDb.appUrl,
    REDIS_URL: redisUrl,
    AI_PROVIDER: 'mock',
  });
  appDb = createDatabase({ url: testDb.appUrl, max: 4, applicationName: 'wt-insight-test' });
  redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 1 });

  // Create an active staff user
  const [u] = await owner()
    .insert(schema.users)
    .values({
      email: `test-agent-${randomBytes(4).toString('hex')}@example.com`,
      name: 'Test Agent',
      role: 'agent',
      status: 'active',
    })
    .returning();
  if (!u) {
    throw new Error('failed to seed user');
  }
  testUser = { id: u.id, email: u.email };
});

afterAll(async () => {
  redis.disconnect();
  await appDb.close();
  await testDb.cleanup();
  net.restore();
});

describe('Worker Embedded Insights (T-418 Integration)', () => {
  beforeEach(async () => {
    // Clean keys prefixed with insight for test isolation
    const keys = await redis.keys('insight:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  it('makes 0 LLM calls and clears dirty mark when an element has 0 viewers in 24h (AC-J16)', async () => {
    const t0 = new Date('2026-11-08T10:00:00Z');
    const element = 'dashboard.ops.sla';
    const scopeKey = 'instance';
    const period = 'd7';

    // 1. Mark dirty at t0 - 5 minutes (so it passes debounce)
    const dirtyAt = t0.getTime() - 5 * 60_000;
    const key = dirtyKey(element, scopeKey, period);
    await markDirty(redis, key, dirtyAt);

    // 2. Zero viewers in viewedKey!
    expect(await redis.exists(key)).toBe(1);

    const logger = createLogger(config);
    const aiRuntime = createAiRuntime(config, appDb, logger);

    // 3. Run tick at t0
    const result = await runInsightTick({
      database: appDb,
      redis,
      config,
      logger,
      ai: aiRuntime,
      now: () => t0,
    });

    // 4. Dirty mark cleared, 0 batches narrated, 0 rows in ai_element_insight
    expect(await redis.exists(key)).toBe(0);
    expect(result.narratedBatches).toBe(0);

    const rows = await appDb.db
      .select()
      .from(schema.aiElementInsight)
      .where(
        and(
          eq(schema.aiElementInsight.element, element),
          eq(schema.aiElementInsight.scopeKey, scopeKey),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it('generates narration and records ai_run + audit log when element is dirty and viewed (AC-J16..AC-J20)', async () => {
    const t0 = new Date('2026-11-08T10:00:00Z');
    const element = 'dashboard.ops.sla';
    const scopeKey = 'instance';
    const period = 'd7';

    // 1. Mark dirty 5m ago
    const dirtyAt = t0.getTime() - 5 * 60_000;
    const dKey = dirtyKey(element, scopeKey, period);
    await markDirty(redis, dKey, dirtyAt);

    // 2. Mark viewed by active staff user within 24h
    const vKey = viewedKey(element, scopeKey, period);
    await redis.zadd(vKey, dirtyAt, `${testUser.id}:en`);

    const logger = createLogger(config);

    // Provide a deterministic mock answer citing 'window_days' (value 7)
    const mockProvider = new DevMockLlmProvider({
      rules: [
        {
          promptId: 'element_insight',
          text: JSON.stringify({
            'dashboard.ops.sla': {
              en: [{ text: 'Window of 7 days', factIds: ['window_days'] }],
            },
          }),
        },
      ],
    });

    const aiRuntime = createAiRuntime(config, appDb, logger, {
      providers: { mock: mockProvider },
    });

    // 3. Run tick at t0
    const result = await runInsightTick({
      database: appDb,
      redis,
      config,
      logger,
      ai: aiRuntime,
      now: () => t0,
    });

    expect(result.narratedBatches).toBe(1);
    expect(result.generatedElements).toBe(1);

    // 4. Verify stored row in ai_element_insight
    const [stored] = await appDb.db
      .select()
      .from(schema.aiElementInsight)
      .where(
        and(
          eq(schema.aiElementInsight.element, element),
          eq(schema.aiElementInsight.scopeKey, scopeKey),
          eq(schema.aiElementInsight.period, period),
          eq(schema.aiElementInsight.locale, 'en'),
        ),
      );

    expect(stored).toBeDefined();
    if (!stored) throw new Error('stored insight missing');
    expect(stored.element).toBe(element);
    expect(stored.claims).toHaveLength(1);
    expect(stored.factsFingerprint).toBeDefined();

    // 5. Verify ai_run row was recorded (N4)
    const [run] = await appDb.db
      .select()
      .from(schema.aiRun)
      .where(eq(schema.aiRun.agent, 'insight_narrator'));
    expect(run).toBeDefined();

    // 6. Verify audit log row was recorded
    const [audit] = await appDb.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, 'insight.generated'),
          eq(schema.auditLog.targetType, 'ai_element_insight'),
        ),
      );
    expect(audit).toBeDefined();
    if (!audit) throw new Error('audit missing');
    expect((audit.metadata as Record<string, unknown>).element).toBe(element);

    // 7. Verify dirty mark cleared in Redis
    expect(await redis.exists(dKey)).toBe(0);

    // 8. Subsequent tick: mark dirty again but facts have not changed -> fingerprint match = 0 LLM calls! (AC-J16)
    const t1 = new Date(t0.getTime() + 10 * 60_000);
    await markDirty(redis, dKey, t1.getTime() - 5 * 60_000);
    await redis.zadd(vKey, t1.getTime(), `${testUser.id}:en`);

    const aiRunsCountBefore = (
      await appDb.db.select().from(schema.aiRun).where(eq(schema.aiRun.agent, 'insight_narrator'))
    ).length;

    const result2 = await runInsightTick({
      database: appDb,
      redis,
      config,
      logger,
      ai: aiRuntime,
      now: () => t1,
    });

    // 0 LLM batches made!
    expect(result2.narratedBatches).toBe(0);

    // ai_run count has not increased
    const aiRunsCountAfter = (
      await appDb.db.select().from(schema.aiRun).where(eq(schema.aiRun.agent, 'insight_narrator'))
    ).length;
    expect(aiRunsCountAfter).toBe(aiRunsCountBefore);

    // Dirty mark was cleared
    expect(await redis.exists(dKey)).toBe(0);
  });

  it('records audit log insight.narration_rejected when claim violates fact numbers (AC-J18, N4)', async () => {
    const t0 = new Date('2026-11-08T11:00:00Z');
    const element = 'dashboard.ops.volume';
    const scopeKey = 'instance';
    const period = 'd7';

    // 1. Mark dirty 5m ago
    const dirtyAt = t0.getTime() - 5 * 60_000;
    const dKey = dirtyKey(element, scopeKey, period);
    await markDirty(redis, dKey, dirtyAt);

    // 2. Mark viewed by active staff
    const vKey = viewedKey(element, scopeKey, period);
    await redis.zadd(vKey, dirtyAt, `${testUser.id}:en`);

    const logger = createLogger(config);

    // Return a hallucinated number 99999 citing window_days (which is 7)
    const mockProvider = new DevMockLlmProvider({
      rules: [
        {
          promptId: 'element_insight',
          text: JSON.stringify({
            'dashboard.ops.volume': {
              en: [{ text: 'There were 99999 tickets received', factIds: ['window_days'] }],
            },
          }),
        },
      ],
    });

    const aiRuntime = createAiRuntime(config, appDb, logger, {
      providers: { mock: mockProvider },
    });

    // 3. Run tick
    await runInsightTick({
      database: appDb,
      redis,
      config,
      logger,
      ai: aiRuntime,
      now: () => t0,
    });

    // 4. Verify audit row insight.narration_rejected was created
    const rejectedAudits = await appDb.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, 'insight.narration_rejected'),
          eq(schema.auditLog.targetType, 'ai_element_insight'),
        ),
      );

    expect(rejectedAudits.length).toBeGreaterThanOrEqual(1);
    const rej = rejectedAudits.find(
      (a) => (a.metadata as Record<string, unknown>).element === element,
    );
    expect(rej).toBeDefined();
    if (!rej) throw new Error('rejection audit missing');
    expect((rej.metadata as Record<string, unknown>).reason).toBe('number_not_in_facts');
  });

  it('auto-pauses element narration when 7-day negative feedback exceeds 50% with >=20 votes (AC-J21)', async () => {
    const t0 = new Date('2026-11-08T12:00:00Z');
    const element = 'alerts.noise';
    const scopeKey = 'instance';
    const period = 'd7';

    // 1. Insert 22 down votes and 2 up votes (22/24 = 91% down > 50%, >=20 votes)
    const feedbackInserts = [];
    for (let i = 0; i < 22; i++) {
      feedbackInserts.push({
        userId: testUser.id,
        targetKind: 'insight' as const,
        targetId: randomUUID(),
        element,
        rating: 'down' as const,
        createdAt: new Date(t0.getTime() - 2 * 86_400_000),
      });
    }
    for (let i = 0; i < 2; i++) {
      feedbackInserts.push({
        userId: testUser.id,
        targetKind: 'insight' as const,
        targetId: randomUUID(),
        element,
        rating: 'up' as const,
        createdAt: new Date(t0.getTime() - 2 * 86_400_000),
      });
    }
    await owner().insert(schema.assistantFeedback).values(feedbackInserts);

    // 2. Mark dirty & viewed
    const dirtyAt = t0.getTime() - 5 * 60_000;
    const dKey = dirtyKey(element, scopeKey, period);
    await markDirty(redis, dKey, dirtyAt);
    const vKey = viewedKey(element, scopeKey, period);
    await redis.zadd(vKey, dirtyAt, `${testUser.id}:en`);

    const logger = createLogger(config);
    const aiRuntime = createAiRuntime(config, appDb, logger);

    // 3. Run tick
    const result = await runInsightTick({
      database: appDb,
      redis,
      config,
      logger,
      ai: aiRuntime,
      now: () => t0,
    });

    // 4. Narration was paused: 0 batches narrated
    expect(result.narratedBatches).toBe(0);
  });

  it('goldenoff0calls: when INSIGHT_PERSON_NARRATION_ENABLED is default false, viewers on shift.overview and home.my_work result in 0 LLM calls (DoD C-25 / ADR-029 §9.9)', async () => {
    const t0 = new Date('2026-11-08T12:00:00Z');
    const dirtyAt = t0.getTime() - 5 * 60_000;

    // Viewers on shift.overview and home.my_work
    const sDirty = dirtyKey('shift.overview', 'instance', 'now');
    await markDirty(redis, sDirty, dirtyAt);
    const sViewed = viewedKey('shift.overview', 'instance', 'now');
    await redis.zadd(sViewed, dirtyAt, `${testUser.id}:en`);

    const uDirty = userDirtyKey(testUser.id, 'home.my_work');
    await markDirty(redis, uDirty, dirtyAt);
    const uViewed = viewedKey('home.my_work', `user:${testUser.id}`, '-');
    await redis.zadd(uViewed, dirtyAt, `${testUser.id}:en`);

    const logger = createLogger(config);
    let mockLlmCalls = 0;
    const mockProvider = new DevMockLlmProvider({
      rules: [
        {
          promptId: 'element_insight',
          text: JSON.stringify({
            'shift.overview': { en: [{ text: 'Shift info', factIds: [] }] },
            'home.my_work': { en: [{ text: 'Work info', factIds: [] }] },
          }),
        },
      ],
    });
    const originalGenerate = mockProvider.generate.bind(mockProvider);
    mockProvider.generate = async (req) => {
      mockLlmCalls++;
      return originalGenerate(req);
    };

    const aiRuntime = createAiRuntime(config, appDb, logger, {
      providers: { mock: mockProvider },
    });

    const result = await runInsightTick({
      database: appDb,
      redis,
      config, // default INSIGHT_PERSON_NARRATION_ENABLED is false
      logger,
      ai: aiRuntime,
      now: () => t0,
    });

    expect(mockLlmCalls).toBe(0);
    expect(result.narratedBatches).toBe(0);
    expect(await redis.exists(sDirty)).toBe(0);
    expect(await redis.exists(uDirty)).toBe(0);
  });

  it('handles lazy home.my_work user scope stored in ai_summary (kind = my_work) and purges on inactive user', async () => {
    const personConfig = testConfig({
      DATABASE_URL: testDb.appUrl,
      REDIS_URL: redisUrl,
      AI_PROVIDER: 'mock',
      INSIGHT_PERSON_NARRATION_ENABLED: 'true',
    });
    const t0 = new Date('2026-11-08T13:00:00Z');
    const dirtyAt = t0.getTime() - 5 * 60_000;

    // 1. Mark dirty for user
    const uKey = userDirtyKey(testUser.id, 'home.my_work');
    await markDirty(redis, uKey, dirtyAt);

    // 2. Mark viewed for user scope
    const vKey = viewedKey('home.my_work', `user:${testUser.id}`, '-');
    await redis.zadd(vKey, dirtyAt, `${testUser.id}:en`);

    const logger = createLogger(personConfig);
    const mockProvider = new DevMockLlmProvider({
      rules: [
        {
          promptId: 'element_insight',
          text: JSON.stringify({
            'home.my_work': {
              en: [{ text: 'You hold 0 items', factIds: ['open'] }],
            },
          }),
        },
      ],
    });

    const aiRuntime = createAiRuntime(personConfig, appDb, logger, {
      providers: { mock: mockProvider },
    });

    // 3. Run tick
    const result = await runInsightTick({
      database: appDb,
      redis,
      config: personConfig,
      logger,
      ai: aiRuntime,
      now: () => t0,
    });

    expect(result.narratedBatches).toBe(1);

    // 4. Verify stored row in ai_summary (kind = 'my_work')
    const [summary] = await appDb.db
      .select()
      .from(schema.aiSummary)
      .where(and(eq(schema.aiSummary.kind, 'my_work'), eq(schema.aiSummary.userId, testUser.id)));
    expect(summary).toBeDefined();
    if (!summary) throw new Error('summary missing');
    expect(summary.claims).toHaveLength(1);

    // 5. Revoke user authorization: set status to 'disabled'
    await owner()
      .update(schema.users)
      .set({ status: 'disabled' })
      .where(eq(schema.users.id, testUser.id));

    // 6. Mark dirty again
    const t1 = new Date(t0.getTime() + 10 * 60_000);
    await markDirty(redis, uKey, t1.getTime() - 5 * 60_000);
    await redis.zadd(vKey, t1.getTime(), `${testUser.id}:en`);

    // 7. Run tick again
    await runInsightTick({
      database: appDb,
      redis,
      config: personConfig,
      logger,
      ai: aiRuntime,
      now: () => t1,
    });

    // 8. ai_summary row for disabled user must be deleted
    const [deletedSummary] = await appDb.db
      .select()
      .from(schema.aiSummary)
      .where(and(eq(schema.aiSummary.kind, 'my_work'), eq(schema.aiSummary.userId, testUser.id)));
    expect(deletedSummary).toBeUndefined();

    // Restore user to active
    await owner()
      .update(schema.users)
      .set({ status: 'active' })
      .where(eq(schema.users.id, testUser.id));
  });

  it('purges ai_summary and skips narration when ticket.read is revoked via role_permissions in DB', async () => {
    const personConfig = testConfig({
      DATABASE_URL: testDb.appUrl,
      REDIS_URL: redisUrl,
      AI_PROVIDER: 'mock',
      INSIGHT_PERSON_NARRATION_ENABLED: 'true',
    });
    const t0 = new Date('2026-11-08T14:00:00Z');
    const dirtyAt = t0.getTime() - 5 * 60_000;

    const uKey = userDirtyKey(testUser.id, 'home.my_work');
    await markDirty(redis, uKey, dirtyAt);
    const vKey = viewedKey('home.my_work', `user:${testUser.id}`, '-');
    await redis.zadd(vKey, dirtyAt, `${testUser.id}:en`);

    const logger = createLogger(personConfig);
    const mockProvider = new DevMockLlmProvider({
      rules: [
        {
          promptId: 'element_insight',
          text: JSON.stringify({
            'home.my_work': {
              en: [{ text: 'You hold 0 items', factIds: ['open'] }],
            },
          }),
        },
      ],
    });
    const aiRuntime = createAiRuntime(personConfig, appDb, logger, {
      providers: { mock: mockProvider },
    });

    // 1. First tick generates ai_summary
    const res1 = await runInsightTick({
      database: appDb,
      redis,
      config: personConfig,
      logger,
      ai: aiRuntime,
      now: () => t0,
    });
    expect(res1.narratedBatches).toBe(1);

    // 2. Revoke ticket.read for role agent in DB role_permissions
    await owner().delete(schema.rolePermissions).where(eq(schema.rolePermissions.role, 'agent'));
    await owner()
      .insert(schema.rolePermissions)
      .values([{ role: 'agent', permission: 'ticket.reply' }]);

    // 3. Mark dirty again
    const t1 = new Date(t0.getTime() + 10 * 60_000);
    await markDirty(redis, uKey, t1.getTime() - 5 * 60_000);
    await redis.zadd(vKey, t1.getTime(), `${testUser.id}:en`);

    // 4. Tick should detect revoked permission via DB RBAC, delete existing ai_summary, clear dirty
    const res2 = await runInsightTick({
      database: appDb,
      redis,
      config: personConfig,
      logger,
      ai: aiRuntime,
      now: () => t1,
    });
    expect(res2.narratedBatches).toBe(0);

    const [deleted] = await appDb.db
      .select()
      .from(schema.aiSummary)
      .where(and(eq(schema.aiSummary.kind, 'my_work'), eq(schema.aiSummary.userId, testUser.id)));
    expect(deleted).toBeUndefined();

    // Clean up role_permissions
    await owner().delete(schema.rolePermissions).where(eq(schema.rolePermissions.role, 'agent'));
  });

  it('marks dirty via hook markInsightDirty for relevant event kinds', async () => {
    // When a ticket event fires, it should mark home.my_work dirty for that user
    await markInsightDirty(redis, 'ticket', { userId: testUser.id });

    const uKey = userDirtyKey(testUser.id, 'home.my_work');
    expect(await redis.exists(uKey)).toBe(1);

    // When an alert event fires, it should mark alerts.noise dirty
    await markInsightDirty(redis, 'alert');
    const aKey = dirtyKey('alerts.noise', 'instance', 'd7');
    expect(await redis.exists(aKey)).toBe(1);
  });

  it('R-1: checkFeedbackGate catches negative feedback via updatedAt within 7 days even with older createdAt', async () => {
    const { checkFeedbackGate } = await import('./gate.js');
    const element = 'alerts.noise';
    const now = new Date('2026-11-08T15:00:00Z');

    // Clean up any existing feedback for isolation
    await owner()
      .delete(schema.assistantFeedback)
      .where(eq(schema.assistantFeedback.element, element));

    // Insert 20 feedback entries with createdAt = 10 days ago, but updatedAt = 1 day ago (user switched rating to 'down')
    for (let i = 0; i < 20; i++) {
      const [u] = await owner()
        .insert(schema.users)
        .values({
          email: `fb-voter-${randomBytes(4).toString('hex')}@example.com`,
          name: `Voter ${String(i)}`,
          role: 'agent',
          status: 'active',
        })
        .returning();
      if (!u) {
        throw new Error('Expected created voter user');
      }
      await owner()
        .insert(schema.assistantFeedback)
        .values({
          userId: u.id,
          targetKind: 'insight',
          targetId: randomUUID(), // unlinked or past id: does not join to ai_element_insight
          element,
          rating: 'down',
          createdAt: new Date(now.getTime() - 10 * 86_400_000), // 10 days ago
          updatedAt: new Date(now.getTime() - 1 * 86_400_000), // 1 day ago
        });
    }

    const gate = await checkFeedbackGate(appDb, element, now);
    expect(gate.paused).toBe(true);
    expect(gate.total).toBe(20);
    expect(gate.down).toBe(20);
  });

  it('R-2: enforces 2-layer budget check (60% app-wide vs <= 30% insight_narrator)', async () => {
    const { checkStanding, checkInsightSpecificBudget } = await import('./gate.js');
    const futureDate = new Date('2026-11-20T12:00:00Z');

    // Insert 6,000 tokens on futureDate for agent = 'insight_narrator'
    await owner()
      .insert(schema.aiRun)
      .values({
        startedAt: futureDate,
        createdAt: futureDate,
        agent: 'insight_narrator',
        provider: 'anthropic',
        model: 'm',
        tier: 'light',
        promptId: 'element_insight',
        promptVersion: 1,
        promptHash: 'a'.repeat(64),
        inputHmac: 'b'.repeat(64),
        redaction: { total: 0, byKind: {} },
        inputTokens: 4000,
        outputTokens: 2000, // total 6,000 tokens
        costUsd: '0.0100',
        status: 'ok',
      });

    // 1. Initial state on futureDate with default config (caps: 300k app-wide, 150k narrator): both allowed
    const standing0 = await checkStanding(appDb, config, futureDate);
    const narrator0 = await checkInsightSpecificBudget(appDb, config, futureDate);
    expect(standing0.allowed).toBe(true);
    expect(narrator0.allowed).toBe(true);

    // 2. Layer 2: Tight insight narrator token cap (1,000 tokens) -> narrator-specific is blocked (6000 >= 1000) while app-wide is open
    const narratorTightConfig = testConfig({
      DATABASE_URL: testDb.appUrl,
      REDIS_URL: redisUrl,
      AI_PROVIDER: 'mock',
      INSIGHT_DAILY_TOKENS: '1000',
    });
    const standing1 = await checkStanding(appDb, narratorTightConfig, futureDate);
    expect(standing1.allowed).toBe(true); // Layer 1 (app-wide) is open!

    const narrator1 = await checkInsightSpecificBudget(appDb, narratorTightConfig, futureDate);
    expect(narrator1.allowed).toBe(false); // Layer 2 (narrator-specific) is blocked!
    expect(narrator1.reason).toMatch(/insight daily token cap reached/);

    // 3. Layer 1: App-wide budget cap tight (1% of 500,000 = 5,000 tokens) -> app-wide is blocked (6000 >= 5000)
    const appTightConfig = testConfig({
      DATABASE_URL: testDb.appUrl,
      REDIS_URL: redisUrl,
      AI_PROVIDER: 'mock',
      INSIGHT_STOP_AT_DAILY_PERCENT: '1',
    });
    const standing2 = await checkStanding(appDb, appTightConfig, futureDate);
    expect(standing2.allowed).toBe(false); // Layer 1 is blocked!
    expect(standing2.budgetFull).toBe(true);
  });

  it('generates narration for Wave 9b mode N element (home.volume)', async () => {
    const t0 = new Date('2026-11-08T16:00:00Z');
    const element = 'home.volume';
    const scopeKey = 'instance';
    const period = 'd90';

    const dirtyAt = t0.getTime() - 5 * 60_000;
    const dKey = dirtyKey(element, scopeKey, period);
    await markDirty(redis, dKey, dirtyAt);
    const vKey = viewedKey(element, scopeKey, period);
    await redis.zadd(vKey, dirtyAt, `${testUser.id}:en`);

    const logger = createLogger(config);
    const mockProvider = new DevMockLlmProvider({
      rules: [
        {
          promptId: 'element_insight',
          text: JSON.stringify({
            'home.volume': {
              en: [{ text: 'Window of 90 days', factIds: ['window_days'] }],
            },
          }),
        },
      ],
    });
    const aiRuntime = createAiRuntime(config, appDb, logger, {
      providers: { mock: mockProvider },
    });

    const result = await runInsightTick({
      database: appDb,
      redis,
      config,
      logger,
      ai: aiRuntime,
      now: () => t0,
    });

    expect(result.narratedBatches).toBe(1);
    expect(await redis.exists(dKey)).toBe(0);

    const [row] = await appDb.db
      .select()
      .from(schema.aiElementInsight)
      .where(
        and(
          eq(schema.aiElementInsight.element, element),
          eq(schema.aiElementInsight.scopeKey, scopeKey),
          eq(schema.aiElementInsight.period, period),
        ),
      );
    expect(row).toBeDefined();
    expect(row?.claims).toBeDefined();
  });
});
