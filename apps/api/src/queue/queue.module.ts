import {
  Global,
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  EMAIL_JOBS,
  QUEUE_NAMES,
  emailJobSchema,
  parseRedisUrl,
  type EmailJob,
} from '@watchtower/shared';
import { Queue } from 'bullmq';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';

/** DI token for the BullMQ `email` queue. Use EmailOutbox instead of injecting it directly. */
export const EMAIL_QUEUE = Symbol('EMAIL_QUEUE');

/** DI token for the BullMQ key prefix; tests set a unique one. */
export const QUEUE_PREFIX = Symbol('QUEUE_PREFIX');

/** Producer side of the `email` queue; apps/worker consumes it and talks SMTP (Mailpit locally). */
@Injectable()
export class EmailOutbox {
  constructor(@Inject(EMAIL_QUEUE) private readonly queue: Queue) {}

  /**
   * Enqueues one email. `jobId` is the idempotency key: enqueueing the same id twice sends once.
   * The payload carries a one-time secret, so a finished job is deleted immediately and a failed
   * one is kept for an hour only.
   */
  async send(job: EmailJob, jobId: string): Promise<void> {
    const payload = emailJobSchema.parse(job);
    await this.queue.add(EMAIL_JOBS.send, payload, {
      jobId,
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: true,
      removeOnFail: { age: 3600 },
    });
  }
}

@Injectable()
class QueueLifecycle implements OnApplicationShutdown {
  constructor(@Inject(EMAIL_QUEUE) private readonly queue: Queue) {}

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}

@Global()
@Module({})
export class QueueModule {
  static forRoot(prefix?: string): DynamicModule {
    return {
      module: QueueModule,
      providers: [
        { provide: QUEUE_PREFIX, useValue: prefix },
        {
          provide: EMAIL_QUEUE,
          inject: [APP_CONFIG, LOGGER, QUEUE_PREFIX],
          useFactory: (config: ApiConfig, logger: AppLogger, queuePrefix: string | undefined) => {
            const queue = new Queue(QUEUE_NAMES.email, {
              connection: parseRedisUrl(config.REDIS_URL),
              ...(queuePrefix === undefined ? {} : { prefix: queuePrefix }),
            });
            queue.on('error', (error) => {
              logger.error({ err: error, queue: QUEUE_NAMES.email }, 'queue error');
            });
            return queue;
          },
        },
        EmailOutbox,
        QueueLifecycle,
      ],
      exports: [EmailOutbox, EMAIL_QUEUE],
    };
  }
}
