import { Global, Inject, Injectable, Module } from '@nestjs/common';
import type { Database, OutboxWriter } from '@watchtower/db';
import { enqueueJob, type OutboxRequest } from '@watchtower/domain';
import {
  EMAIL_JOBS,
  EMAIL_OUTBOX_JOB_OPTIONS,
  QUEUE_NAMES,
  splitEmailSecrets,
  type EmailJob,
} from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';

export type { OutboxRequest };

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
    // The sealing and the insert moved to @watchtower/domain (ADR-009), where the worker uses them too.
    return enqueueJob(executor ?? this.database.db, { sealKey: this.sealKey }, request);
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
