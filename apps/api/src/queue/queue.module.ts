import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { enqueueOutbox, type Database, type OutboxWriter } from '@watchtower/db';
import {
  EMAIL_JOBS,
  EMAIL_OUTBOX_JOB_OPTIONS,
  QUEUE_NAMES,
  emailJobSchema,
  outboxJobOptionsSchema,
  type EmailJob,
  type OutboxJobOptions,
  type QueueName,
} from '@watchtower/shared';

import { DATABASE } from '../database/database.module.js';

/** What a caller asks the outbox to enqueue. */
export interface OutboxRequest {
  readonly queue: QueueName;
  readonly name: string;
  /** Idempotency key (the BullMQ jobId): the same `(queue, jobId)` is enqueued once. */
  readonly jobId: string;
  readonly payload: Record<string, unknown>;
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
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  /**
   * Stores one job. Without `executor` it is its own statement (durable on return); with a
   * transaction it commits with it. Returns false when `jobId` was enqueued before.
   */
  async enqueue(request: OutboxRequest, executor?: OutboxWriter): Promise<boolean> {
    if (!QUEUES.has(request.queue)) throw new Error(`unknown queue "${request.queue}"`);
    const options = outboxJobOptionsSchema.parse(request.options ?? {});
    return enqueueOutbox(executor ?? this.database.db, {
      queue: request.queue,
      jobName: request.name,
      jobId: request.jobId,
      payload: request.payload,
      options,
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
   * commit together.
   */
  async send(job: EmailJob, jobId: string, executor?: OutboxWriter): Promise<void> {
    const payload = emailJobSchema.parse(job);
    await this.outbox.enqueue(
      {
        queue: QUEUE_NAMES.email,
        name: EMAIL_JOBS.send,
        jobId,
        payload,
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
