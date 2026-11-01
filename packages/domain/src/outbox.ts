import { enqueueOutbox, type OutboxWriter } from '@watchtower/db';
import {
  QUEUE_NAMES,
  outboxJobOptionsSchema,
  type OutboxJobOptions,
  type QueueName,
} from '@watchtower/shared';
import { outboxAad, sealFields } from '@watchtower/shared/secret-box';

import type { DomainConfig } from './types.js';

/** What a caller asks the outbox to enqueue. */
export interface OutboxRequest {
  readonly queue: QueueName;
  readonly name: string;
  /** Idempotency key (the BullMQ jobId): the same `(queue, jobId)` is enqueued once. */
  readonly jobId: string;
  /** The non-secret part of the job, stored in the clear. Must not have a `secret` key. */
  readonly payload: Record<string, unknown>;
  /**
   * The secret part: named string fields (a link that carries a token). They are sealed with
   * AES-256-GCM under a subkey of APP_ENCRYPTION_KEY, bound to this queue and job id, and stored
   * as `payload.secret`; the consumer opens them just before it uses them (ADR-006).
   */
  readonly secret?: Readonly<Record<string, string>>;
  /** After this instant the job is dropped unsent (the outbox relay dead-letters it, the worker skips it). */
  readonly expiresAt?: Date;
  /** The relay holds the job back until this instant (a trigger that must wait, ADR-010). */
  readonly notBefore?: Date;
  readonly options?: OutboxJobOptions;
}

const QUEUES: ReadonlySet<string> = new Set(Object.values(QUEUE_NAMES));

/**
 * Stores one job in the transactional outbox (ADR-006). It writes a row; it never talks to Redis,
 * so the job exists if and only if the transaction that holds `writer` commits. Returns false when
 * `jobId` was enqueued before. The relay in `apps/worker` moves rows to BullMQ.
 */
export async function enqueueJob(
  writer: OutboxWriter,
  config: Pick<DomainConfig, 'sealKey'>,
  request: OutboxRequest,
): Promise<boolean> {
  if (!QUEUES.has(request.queue)) throw new Error(`unknown queue "${request.queue}"`);
  const options = outboxJobOptionsSchema.parse(request.options ?? {});
  if ('secret' in request.payload) throw new Error('payload.secret is reserved for sealed fields');
  const payload =
    request.secret === undefined
      ? request.payload
      : {
          ...request.payload,
          secret: sealFields(
            config.sealKey,
            request.secret,
            outboxAad(request.queue, request.jobId),
          ),
        };
  return enqueueOutbox(writer, {
    queue: request.queue,
    jobName: request.name,
    jobId: request.jobId,
    payload,
    options,
    ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
    ...(request.notBefore === undefined ? {} : { notBefore: request.notBefore }),
  });
}
