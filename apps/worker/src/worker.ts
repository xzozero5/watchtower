import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

import { createDatabase } from '@watchtower/db';
import { MAINTENANCE_JOBS, parseRedisUrl, QUEUE_NAMES, type QueueName } from '@watchtower/shared';
import { Queue, Worker, type Processor } from 'bullmq';
import { z } from 'zod';

import type { WorkerConfig } from './config.js';
import { createHealthServer } from './health.js';
import type { WorkerLogger } from './logger.js';
import { createSmtpMailer, type Mailer } from './mailer.js';
import { createEmailProcessor } from './processors/email.js';
import { createMaintenanceProcessor } from './processors/maintenance.js';
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
  /** Replaces the SMTP mailer. Tests inject a fake; production leaves it unset. */
  readonly mailer?: Mailer;
}

const packageJsonSchema = z.object({ version: z.string() });

function readVersion(): string {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  return packageJsonSchema.parse(raw).version;
}

/** Runs partition maintenance at 03:00 UTC every day, and once at start so a fresh install is ready. */
const PARTITION_SCHEDULE = { pattern: '0 3 * * *', tz: 'UTC' } as const;

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
  const prefixOption = options.queuePrefix === undefined ? {} : { prefix: options.queuePrefix };
  const mailer =
    options.mailer ??
    createSmtpMailer({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      from: config.SMTP_FROM,
      requireTls: config.NODE_ENV === 'production',
    });

  const consumers: Worker[] = [];
  const consume = (queue: QueueName, processor: Processor): Worker => {
    const worker = new Worker(queue, processor, {
      connection,
      concurrency: config.WORKER_CONCURRENCY,
      ...prefixOption,
    });
    worker.on('error', (error) => {
      logger.error({ err: error, queue }, 'queue worker error');
    });
    worker.on('failed', (job, error) => {
      logger.warn({ err: error, queue, jobId: job?.id, job: job?.name }, 'job failed');
    });
    consumers.push(worker);
    return worker;
  };

  consume(QUEUE_NAMES.system, processSystemJob);
  consume(QUEUE_NAMES.email, createEmailProcessor(mailer));
  consume(QUEUE_NAMES.maintenance, createMaintenanceProcessor(database));
  await Promise.all(consumers.map((consumer) => consumer.waitUntilReady()));

  // A round trip to Redis for the readiness probe (a Worker only holds blocking connections).
  const probe = new Queue(QUEUE_NAMES.system, { connection, ...prefixOption });
  probe.on('error', (error) => {
    logger.error({ err: error }, 'queue probe error');
  });

  const maintenance = new Queue(QUEUE_NAMES.maintenance, { connection, ...prefixOption });
  maintenance.on('error', (error) => {
    logger.error({ err: error }, 'maintenance queue error');
  });
  await maintenance.upsertJobScheduler(MAINTENANCE_JOBS.ensurePartitions, PARTITION_SCHEDULE, {
    name: MAINTENANCE_JOBS.ensurePartitions,
    opts: { removeOnComplete: true, removeOnFail: { age: 7 * 24 * 3600 } },
  });
  await maintenance.add(
    MAINTENANCE_JOBS.ensurePartitions,
    {},
    { jobId: `ensure-partitions-boot-${String(Date.now())}`, removeOnComplete: true },
  );

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
    { host: config.HOST, port: healthPort, queues: Object.values(QUEUE_NAMES) },
    'worker started',
  );

  return {
    healthPort,
    async close() {
      await Promise.all(consumers.map((consumer) => consumer.close()));
      await probe.close();
      await maintenance.close();
      mailer.close();
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
