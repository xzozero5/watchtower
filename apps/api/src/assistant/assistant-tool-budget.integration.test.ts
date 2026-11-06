import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { RateLimiter } from '../auth/rate-limiter.js';
import { assistantToolBudget } from './assistant-tool-budget.js';

const redisUrl = process.env.TEST_REDIS_URL;
if (!redisUrl) throw new Error('Point TEST_REDIS_URL at a disposable Redis');
const namespace = `test:assistant-tool-budget:${randomUUID()}`;
const redis = new Redis(redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
});
const limiter = new RateLimiter(redis, {
  RATE_LIMIT_NAMESPACE: namespace,
  APP_ENCRYPTION_KEY: 'a'.repeat(32),
});

beforeAll(() => redis.connect());
afterAll(async () => {
  if (redis.status === 'ready') {
    const keys = await redis.keys(`${namespace}:*`);
    if (keys.length > 0) await redis.unlink(...keys);
    await redis.quit();
  } else redis.disconnect();
});

it('allows 60 calls, refuses 61, and isolates both person and tool', async () => {
  const first = assistantToolBudget(limiter, 'synthetic-user-a');
  for (let i = 0; i < 60; i += 1) await first('summarize_ticket');
  await expect(first('summarize_ticket')).rejects.toMatchObject({ status: 429 });
  await expect(first('kb_search')).resolves.toBeUndefined();
  await expect(
    assistantToolBudget(limiter, 'synthetic-user-b')('summarize_ticket'),
  ).resolves.toBeUndefined();
});
