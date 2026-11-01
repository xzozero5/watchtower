import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

import { createDatabase, type OutboxPublisher } from '@watchtower/db';
import { createDomain, createPolicyGate } from '@watchtower/domain';
import { parseRedisUrl, QUEUE_NAMES, type QueueName } from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';
import { Queue, Worker, type Processor } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';

import { createAiRuntime } from './ai/runtime.js';
import type { WorkerConfig } from './config.js';
import { defaultGmailRuntime } from './gmail/index.js';
import { createHealthServer } from './health.js';
import type { WorkerLogger } from './logger.js';
import { createSmtpMailer, type Mailer } from './mailer.js';
import {
  createBullmqPublisher,
  startOutboxRelay,
  type RunningOutboxRelay,
} from './outbox-relay.js';
import { PROCESSORS, type ProcessorOverrides } from './processors/index.js';
import { createRealtimeSink } from './realtime.js';
import { SCHEDULES } from './schedules.js';

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
  /** Replaces how the outbox relay hands jobs to BullMQ. Tests inject a publisher that fails on demand. */
  readonly outboxPublisher?: OutboxPublisher;
  /** Replaces the outside world of the processors (object storage, provider transports, classifier). */
  readonly overrides?: ProcessorOverrides;
  /** Redis pub/sub channel for realtime events. Tests use a unique one; production leaves the default. */
  readonly realtimeChannel?: string;
}

const packageJsonSchema = z.object({ version: z.string() });

function readVersion(): string {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  return packageJsonSchema.parse(raw).version;
}

/**
 * Starts the queue consumers and the health server. Add a queue by declaring its name in
 * `packages/shared/src/features/<feature>.ts` and a line in `processors/index.ts` (a repeating
 * job: `schedules.ts`); see docs/04-ARCHITECTURE.md section 2.
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

  // The write logic shared with the api (ADR-009), with the same policy gate (ADR-011): it reads the
  // stage and the switches fresh on every call, through the worker's own database handle. The
  // dispatcher asks it again when it claims a delivery (ADR-010 section 5).
  const domain = createDomain({
    ticketKeyPrefix: config.TICKET_KEY_PREFIX,
    sealKey: deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.outboxSecret),
    portalUrl: new URL('/portal', config.APP_URL).toString(),
    policyGate: createPolicyGate({ db: database.db }),
  });
  const realtimeRedis = new Redis({
    ...connection,
    connectionName: `${config.OTEL_SERVICE_NAME}-realtime`,
    maxRetriesPerRequest: 2,
  });
  realtimeRedis.on('error', (error: Error) => {
    logger.error({ err: error }, 'realtime redis connection error');
  });
  const realtime = createRealtimeSink(realtimeRedis, options.realtimeChannel);
  const overrides = options.overrides ?? {};
  // The AI layer (T-106e): the mock provider by default; absent (rules only) for a provider not wired yet.
  const ai = createAiRuntime(config, database, logger, overrides.ai);

  // How Gmail mailboxes are reached (T-102): the in-memory fake unless the `gmail` credential is complete.
  const gmailRuntime =
    overrides.gmail?.runtime ?? defaultGmailRuntime(config, database, logger, domain);

  const consumers: Worker[] = [];
  const consume = (queue: QueueName, processor: Processor, concurrency?: number): Worker => {
    const worker = new Worker(queue, processor, {
      connection,
      concurrency: concurrency ?? config.WORKER_CONCURRENCY,
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

  for (const registration of PROCESSORS) {
    consume(
      registration.queue,
      registration.create({
        config,
        logger,
        database,
        mailer,
        domain,
        realtime,
        ai,
        gmail: gmailRuntime,
        overrides,
      }),
      registration.concurrency,
    );
  }
  await Promise.all(consumers.map((consumer) => consumer.waitUntilReady()));

  // A round trip to Redis for the readiness probe (a Worker only holds blocking connections).
  const probe = new Queue(QUEUE_NAMES.system, { connection, ...prefixOption });
  probe.on('error', (error) => {
    logger.error({ err: error }, 'queue probe error');
  });

  // Repeating jobs (schedules.ts): one producer connection per queue that has any.
  const schedulers = new Map<QueueName, Queue>();
  for (const schedule of SCHEDULES) {
    let scheduler = schedulers.get(schedule.queue);
    if (scheduler === undefined) {
      const created = new Queue(schedule.queue, { connection, ...prefixOption });
      created.on('error', (error) => {
        logger.error({ err: error, queue: schedule.queue }, 'schedule queue error');
      });
      schedulers.set(schedule.queue, created);
      scheduler = created;
    }
    await scheduler.upsertJobScheduler(schedule.id, schedule.repeat, {
      name: schedule.job.name,
      ...(schedule.job.data === undefined ? {} : { data: schedule.job.data }),
      ...(schedule.job.opts === undefined ? {} : { opts: schedule.job.opts }),
    });
    if (schedule.runAtBoot === true) {
      await scheduler.add(schedule.job.name, schedule.job.data ?? {}, {
        jobId: `${schedule.id}-boot-${String(Date.now())}`,
        removeOnComplete: true,
      });
    }
  }

  // The transactional outbox (ADR-006): rows the api wrote in its own transactions become BullMQ jobs.
  const publisher = createBullmqPublisher(connection, logger, prefixOption);
  const outboxRelay: RunningOutboxRelay = startOutboxRelay({
    database,
    publish: options.outboxPublisher ?? publisher.publish,
    logger,
    intervalMs: config.OUTBOX_POLL_INTERVAL_MS,
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
    { host: config.HOST, port: healthPort, queues: Object.values(QUEUE_NAMES) },
    'worker started',
  );

  return {
    healthPort,
    async close() {
      await outboxRelay.stop();
      await publisher.close();
      await Promise.all(consumers.map((consumer) => consumer.close()));
      await probe.close();
      await Promise.all([...schedulers.values()].map((scheduler) => scheduler.close()));
      mailer.close();
      await realtimeRedis.quit().catch(() => {
        realtimeRedis.disconnect();
      });
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
