import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { enqueueOutbox, type Database, type OutboxWriter } from '@watchtower/db';
import {
  EMAIL_JOBS,
  EMAIL_OUTBOX_JOB_OPTIONS,
  QUEUE_NAMES,
  outboxJobOptionsSchema,
  splitEmailSecrets,
  type EmailJob,
  type OutboxJobOptions,
  type QueueName,
} from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey, outboxAad, sealFields } from '@watchtower/shared/secret-box';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';

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
  readonly options?: OutboxJobOptions;
}

const QUEUES: ReadonlySet<string> = new Set(Object.values(QUEUE_NAMES));

/**
 * Producer side of every BullMQ queue (ADR-006). It writes a row to the `outbox` table; it never
 * talks to Redis. Pass the transaction of the change the job belongs to and the job exists if and
 * only if that change commits. `apps/worker` runs the relay that moves rows to BullMQ, so a Redis
 * outage delays a job and never loses it. Future channel sends (reply on Gmail or LINE) enqueue
 * the same way.
 */
@Injectable()
export class OutboxService {
  private readonly sealKey: Buffer;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APP_CONFIG) config: ApiConfig,
  ) {
    this.sealKey = deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.outboxSecret);
  }

  /**
   * Stores one job. Without `executor` it is its own statement (durable on return); with a
   * transaction it commits with it. Returns false when `jobId` was enqueued before.
   */
  async enqueue(request: OutboxRequest, executor?: OutboxWriter): Promise<boolean> {
    if (!QUEUES.has(request.queue)) throw new Error(`unknown queue "${request.queue}"`);
    const options = outboxJobOptionsSchema.parse(request.options ?? {});
    if ('secret' in request.payload)
      throw new Error('payload.secret is reserved for sealed fields');
    const payload =
      request.secret === undefined
        ? request.payload
        : {
            ...request.payload,
            secret: sealFields(
              this.sealKey,
              request.secret,
              outboxAad(request.queue, request.jobId),
            ),
          };
    return enqueueOutbox(executor ?? this.database.db, {
      queue: request.queue,
      jobName: request.name,
      jobId: request.jobId,
      payload,
      options,
      ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
    });
  }
}

/** Outbound email: the api describes the message, the worker renders and sends it over SMTP. */
@Injectable()
export class EmailOutbox {
  constructor(@Inject(OutboxService) private readonly outbox: OutboxService) {}

  /**
   * Enqueues one email. `jobId` is the idempotency key: enqueueing the same id twice sends once.
   * Give the transaction that created whatever the email is about (a token, a ticket) so the two
   * commit together. The link inside (`EMAIL_SECRET_FIELDS`) is sealed before it is stored, and
   * the email is dropped unsent once `ttlSeconds` have passed (a magic link past its lifetime is
   * useless; a tracking link that sat in the queue for a day is stale).
   */
  async send(
    job: EmailJob,
    jobId: string,
    executor: OutboxWriter | undefined,
    ttlSeconds: number,
  ): Promise<void> {
    const { clear, secret } = splitEmailSecrets(job);
    await this.outbox.enqueue(
      {
        queue: QUEUE_NAMES.email,
        name: EMAIL_JOBS.send,
        jobId,
        payload: clear,
        secret,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
        options: EMAIL_OUTBOX_JOB_OPTIONS,
      },
      executor,
    );
  }
}

@Global()
@Module({
  providers: [OutboxService, EmailOutbox],
  exports: [OutboxService, EmailOutbox],
})
export class QueueModule {}
