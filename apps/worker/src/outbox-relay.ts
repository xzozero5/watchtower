import {
  PermanentOutboxError,
  outboxBacklog,
  purgeOutbox,
  relayOutbox,
  type Database,
  type OutboxPublisher,
  type RelayOptions,
  type RelayResult,
} from '@watchtower/db';
import { QUEUE_NAMES, outboxJobOptionsSchema } from '@watchtower/shared';
import { Queue, type ConnectionOptions } from 'bullmq';

import type { WorkerLogger } from './logger.js';

/**
 * The relay of the transactional outbox (ADR-006). `apps/api` writes `outbox` rows in the same
 * transaction as the change that needs a job; this loop moves pending rows to BullMQ, retrying with
 * exponential backoff while Redis is unavailable, so a Redis outage delays jobs and never loses
 * them. It lives in the worker because the worker is the process that owns background work and is
 * kept running by the platform; the api never talks to Redis for queues.
 */

const QUEUE_SET: ReadonlySet<string> = new Set(Object.values(QUEUE_NAMES));
/** A hand-over to Redis that takes longer than this counts as failed (Redis hanging, not refusing). */
const PUBLISH_TIMEOUT_MS = 5000;
const PASSES_PER_TICK = 10;
const PURGE_EVERY_MS = 60 * 60 * 1000;

export interface BullmqPublisher {
  readonly publish: OutboxPublisher;
  close(): Promise<void>;
}

/** Publishes outbox rows with `queue.add`, one cached `Queue` per queue name. */
export function createBullmqPublisher(
  connection: ConnectionOptions,
  logger: WorkerLogger,
  options: { readonly prefix?: string; readonly timeoutMs?: number } = {},
): BullmqPublisher {
  const queues = new Map<string, Queue>();
  const timeoutMs = options.timeoutMs ?? PUBLISH_TIMEOUT_MS;
  const queueFor = (name: string): Queue => {
    if (!QUEUE_SET.has(name)) throw new PermanentOutboxError(`unknown queue "${name}"`);
    let queue = queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection,
        ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      });
      queue.on('error', (error) => {
        logger.error({ err: error, queue: name }, 'outbox publisher queue error');
      });
      queues.set(name, queue);
    }
    return queue;
  };

  return {
    async publish(row) {
      const queue = queueFor(row.queue);
      const parsed = outboxJobOptionsSchema.safeParse(row.options);
      if (!parsed.success) {
        throw new PermanentOutboxError(
          `job options do not validate: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
        );
      }
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Redis did not accept the job within ${String(timeoutMs)} ms`));
        }, timeoutMs);
      });
      try {
        // `jobId` is the idempotency key: adding an id that exists is a no-op that returns that job.
        await Promise.race([
          queue.add(row.jobName, row.payload, { ...parsed.data, jobId: row.jobId }),
          timeout,
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      await Promise.all([...queues.values()].map((queue) => queue.close()));
    },
  };
}

export interface OutboxRelayOptions extends RelayOptions {
  readonly database: Pick<Database, 'pool'>;
  readonly publish: OutboxPublisher;
  readonly logger: WorkerLogger;
  /** Delay between passes while the outbox is quiet. Default 1000 ms. */
  readonly intervalMs?: number;
  /** Finished rows older than this many days are deleted. Default 7. */
  readonly retentionDays?: number;
}

export interface RunningOutboxRelay {
  /** One pass now (or waits for the one in progress). Used by tests. */
  runOnce(): Promise<RelayResult>;
  /** Stops scheduling and waits for the pass in progress. */
  stop(): Promise<void>;
}

/** Starts the relay loop. Errors are logged, never thrown: the loop outlives a bad moment. */
export function startOutboxRelay(options: OutboxRelayOptions): RunningOutboxRelay {
  const { database, publish, logger } = options;
  const intervalMs = options.intervalMs ?? 1000;
  const retentionDays = options.retentionDays ?? 7;
  const relayOptions: RelayOptions = {
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    ...(options.leaseSeconds === undefined ? {} : { leaseSeconds: options.leaseSeconds }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.baseDelaySeconds === undefined
      ? {}
      : { baseDelaySeconds: options.baseDelaySeconds }),
    ...(options.maxDelaySeconds === undefined ? {} : { maxDelaySeconds: options.maxDelaySeconds }),
  };
  const batchSize = options.batchSize ?? 50;

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<RelayResult> | undefined;
  let lastPurge = 0;
  let lastFailureLogged = 0;

  const pass = async (): Promise<RelayResult> => {
    let total: RelayResult = { claimed: 0, sent: 0, retried: 0, dead: 0 };
    for (let index = 0; index < PASSES_PER_TICK; index += 1) {
      const result = await relayOutbox(database, publish, relayOptions);
      total = {
        claimed: total.claimed + result.claimed,
        sent: total.sent + result.sent,
        retried: total.retried + result.retried,
        dead: total.dead + result.dead,
        ...(total.firstError !== undefined
          ? { firstError: total.firstError }
          : result.firstError === undefined
            ? {}
            : { firstError: result.firstError }),
      };
      // A full batch means more may be waiting; a failure means Redis is not taking jobs right now.
      if (result.claimed < batchSize || result.firstError !== undefined) break;
    }
    if (total.sent > 0) logger.debug({ sent: total.sent }, 'outbox relayed');
    if (total.firstError !== undefined) {
      // At most one warning a minute while Redis is down, with the backlog so an alert can use it.
      const now = Date.now();
      if (now - lastFailureLogged >= 60_000) {
        lastFailureLogged = now;
        const backlog = await outboxBacklog(database).catch(() => undefined);
        logger.warn(
          { retried: total.retried, dead: total.dead, error: total.firstError, backlog },
          'outbox relay could not hand jobs to the queue',
        );
      }
    }
    if (total.dead > 0) logger.error({ dead: total.dead }, 'outbox rows given up on');
    if (Date.now() - lastPurge >= PURGE_EVERY_MS) {
      lastPurge = Date.now();
      const purged = await purgeOutbox(database, retentionDays);
      if (purged > 0) logger.info({ purged }, 'outbox finished rows purged');
    }
    return total;
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      current = pass()
        .catch((error: unknown) => {
          logger.error({ err: error }, 'outbox relay pass failed');
          return { claimed: 0, sent: 0, retried: 0, dead: 0 } satisfies RelayResult;
        })
        .finally(() => {
          current = undefined;
          schedule();
        });
    }, intervalMs);
  };
  schedule();

  return {
    async runOnce() {
      return current ?? pass();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
    },
  };
}
