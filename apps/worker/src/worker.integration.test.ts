import { randomBytes } from 'node:crypto';

import { DEFAULT_JOB_OPTIONS, parseRedisUrl, QUEUE_NAMES, SYSTEM_JOBS } from '@watchtower/shared';
import { Queue, QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from './logger.js';
import { pingResultSchema } from './processors/system.js';
import { testConfig } from './testing/support.js';
import { startWorker, type RunningWorker } from './worker.js';

// Real Postgres and Redis from docker compose (`docker compose up -d --wait postgres redis`).
// A unique key prefix keeps this run away from any other BullMQ data in the same Redis.
const prefix = `wt-test-${randomBytes(4).toString('hex')}`;
// listenPort 0: let the OS pick a free port for the health server.
const config = { ...testConfig(), listenPort: 0 };

let worker: RunningWorker;
let queue: Queue;
let events: QueueEvents;

beforeAll(async () => {
  worker = await startWorker(config, createLogger(config), { queuePrefix: prefix });
  const connection = parseRedisUrl(config.REDIS_URL);
  queue = new Queue(QUEUE_NAMES.system, { connection, prefix });
  events = new QueueEvents(QUEUE_NAMES.system, { connection, prefix });
  await events.waitUntilReady();
});

afterAll(async () => {
  await events.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await worker.close();
});

describe('worker against real Postgres and Redis', () => {
  it('GET /health and /health/ready answer 200', async () => {
    const base = `http://127.0.0.1:${String(worker.healthPort)}`;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      status: 'ok',
      checks: { database: { status: 'up' }, redis: { status: 'up' } },
    });
  });

  it('consumes a job enqueued by a producer through Redis', async () => {
    const job = await queue.add(
      SYSTEM_JOBS.ping,
      {},
      { ...DEFAULT_JOB_OPTIONS, jobId: 'ping-roundtrip' },
    );
    const result: unknown = await job.waitUntilFinished(events, 10_000);
    expect(pingResultSchema.parse(result).pong).toBe(true);
  });

  it('is idempotent per jobId: the same key does not enqueue twice', async () => {
    const first = await queue.add(SYSTEM_JOBS.ping, {}, { jobId: 'ping-once' });
    const second = await queue.add(SYSTEM_JOBS.ping, {}, { jobId: 'ping-once' });
    expect(second.id).toBe(first.id);
    await first.waitUntilFinished(events, 10_000);
    expect(await queue.getJobCounts('waiting', 'active', 'delayed')).toEqual({
      waiting: 0,
      active: 0,
      delayed: 0,
    });
  });

  it('retries a failing job and then keeps it as failed', async () => {
    const job = await queue.add(
      'mystery',
      {},
      { attempts: 2, backoff: { type: 'fixed', delay: 50 } },
    );
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow(/unknown system job/);
    const failed = await queue.getJob(job.id ?? '');
    expect(failed?.attemptsMade).toBe(2);
  });
});

describe('readiness when Postgres is unreachable', () => {
  it('returns 503 naming the database', async () => {
    const broken = {
      ...testConfig({ DATABASE_URL: 'postgres://watchtower:watchtower@127.0.0.1:1/watchtower' }),
      listenPort: 0,
    };
    const running = await startWorker(broken, createLogger(broken), {
      queuePrefix: `${prefix}-broken`,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${String(running.healthPort)}/health/ready`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        checks: { database: { status: 'down' }, redis: { status: 'up' } },
      });
    } finally {
      await running.close();
    }
  });
});
