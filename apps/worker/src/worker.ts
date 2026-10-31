import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

import { createDatabase } from '@watchtower/db';
import { parseRedisUrl, QUEUE_NAMES } from '@watchtower/shared';
import { Queue, Worker } from 'bullmq';
import { z } from 'zod';

import type { WorkerConfig } from './config.js';
import { createHealthServer } from './health.js';
import type { WorkerLogger } from './logger.js';
import { processSystemJob } from './processors/system.js';

export interface RunningWorker {
  /** Port the health server is bound to (useful when configured with port 0). */
  readonly healthPort: number;
  /** Stops taking jobs, lets running ones finish, then closes every connection. */
  close(): Promise<void>;
}

export interface StartOptions {
  /** BullMQ key prefix. Tests use a unique one so runs never see each other's jobs. */
  readonly queuePrefix?: string;
}

const packageJsonSchema = z.object({ version: z.string() });

function readVersion(): string {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  return packageJsonSchema.parse(raw).version;
}

/**
 * Starts the queue consumers and the health server. Add a queue by adding its name to
 * QUEUE_NAMES in @watchtower/shared and a Worker here; see docs/04-ARCHITECTURE.md section 2.
 */
export async function startWorker(
  config: WorkerConfig,
  logger: WorkerLogger,
  options: StartOptions = {},
): Promise<RunningWorker> {
  const database = createDatabase({
    url: config.DATABASE_URL,
    max: 5,
    applicationName: config.OTEL_SERVICE_NAME,
    onError: (error) => {
      logger.error({ err: error }, 'idle database connection failed');
    },
  });

  const connection = parseRedisUrl(config.REDIS_URL);
  const system = new Worker(QUEUE_NAMES.system, processSystemJob, {
    connection,
    concurrency: config.WORKER_CONCURRENCY,
    ...(options.queuePrefix === undefined ? {} : { prefix: options.queuePrefix }),
  });
  system.on('error', (error) => {
    logger.error({ err: error, queue: QUEUE_NAMES.system }, 'queue worker error');
  });
  system.on('failed', (job, error) => {
    logger.warn(
      { err: error, queue: QUEUE_NAMES.system, jobId: job?.id, job: job?.name },
      'job failed',
    );
  });
  await system.waitUntilReady();

  // A round trip to Redis for the readiness probe (a Worker only holds blocking connections).
  const probe = new Queue(QUEUE_NAMES.system, {
    connection,
    ...(options.queuePrefix === undefined ? {} : { prefix: options.queuePrefix }),
  });
  probe.on('error', (error) => {
    logger.error({ err: error }, 'queue probe error');
  });

  const health = createHealthServer({
    service: config.OTEL_SERVICE_NAME,
    version: readVersion(),
    logger,
    checks: {
      database: () => database.ping(),
      redis: async () => {
        await probe.getJobCounts('waiting');
      },
    },
  });
  await new Promise<void>((resolve, reject) => {
    health.once('error', reject);
    health.listen(config.listenPort, config.HOST, () => {
      health.off('error', reject);
      resolve();
    });
  });
  const healthPort = (health.address() as AddressInfo).port;
  logger.info(
    { host: config.HOST, port: healthPort, queues: [QUEUE_NAMES.system] },
    'worker started',
  );

  return {
    healthPort,
    async close() {
      await system.close();
      await probe.close();
      await new Promise<void>((resolve) => {
        health.close(() => {
          resolve();
        });
        health.closeAllConnections();
      });
      await database.close();
      logger.info('worker stopped');
    },
  };
}
