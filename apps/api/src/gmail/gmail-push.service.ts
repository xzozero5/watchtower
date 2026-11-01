import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { gmail } from '@watchtower/channels';
import { enqueueOutbox, schema, type Database } from '@watchtower/db';
import {
  GMAIL_JOBS,
  GMAIL_QUEUES,
  GMAIL_SYNC_OUTBOX_JOB_OPTIONS,
  normaliseMailboxAddress,
  pubsubPushEnvelopeSchema,
  type GmailSyncJob,
} from '@watchtower/shared';
import { and, eq, ne } from 'drizzle-orm';

import { RateLimitedError, unauthenticated } from '../auth/http-errors.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';
import {
  PushAuthError,
  PushKeysUnavailableError,
  type PushTokenVerifier,
} from './push-verifier.js';

/** DI token of the push verifier; the value is `null` when push authentication is not configured. */
export const GMAIL_PUSH_VERIFIER = Symbol('GMAIL_PUSH_VERIFIER');

export type PushOutcome = 'queued' | 'duplicate' | 'ignored';

const MINUTE = 60;

/**
 * The Gmail Pub/Sub push receiver (T-102b, ADR-009 section 1). It is thin on purpose: authenticate,
 * record that the mailbox is alive, write ONE outbox job and answer, so Pub/Sub gets its acknowledgement
 * in milliseconds (R-2.9). Everything that talks to Gmail happens in the worker.
 *
 * Order matters: rate limit (cheap, before any crypto) -> verify the OIDC token -> only then read the
 * body. A request that fails verification writes nothing and logs no body.
 *
 * What is acknowledged (2xx) and what is not follows Pub/Sub's rules (2xx ack, anything else nack
 * and redeliver, https://docs.cloud.google.com/pubsub/docs/push, read 2026-11-01):
 *   - bad or missing token: 401 (nack; a real Pub/Sub will not recover, an attacker learns nothing);
 *   - keys unavailable / database down: 5xx (nack, Pub/Sub redelivers);
 *   - an authentic message we can never process (unreadable payload, unknown or disabled mailbox):
 *     2xx and dropped, otherwise Pub/Sub would redeliver it forever (poison message).
 * Idempotency: the Pub/Sub `messageId` is the job id, so a redelivery is the same outbox row; what
 * the sync then finds is deduplicated again by the Gmail message id (`inbound_event` unique key).
 */
@Injectable()
export class GmailPushService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(GMAIL_PUSH_VERIFIER) private readonly verifier: PushTokenVerifier | null,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  async accept(input: {
    readonly authorization: string | undefined;
    readonly body: unknown;
    readonly ip: string | null;
    readonly now?: Date;
  }): Promise<PushOutcome> {
    if (this.verifier === null) {
      // Not configured: refuse rather than accept unauthenticated mail notifications.
      throw new HttpException(
        { statusCode: 503, error: 'Service Unavailable', code: 'gmail_push_not_configured' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const limit = this.config.GMAIL_PUSH_RATE_PER_MINUTE;
    const hit = await this.limiter.hit('gmail-push-ip', input.ip ?? 'unknown', limit, MINUTE);
    if (!hit.allowed) throw new RateLimitedError(hit.retryAfterSeconds);

    const match = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(input.authorization ?? '');
    if (match?.[1] === undefined) throw unauthenticated('Authentication is required');
    try {
      await this.verifier.verify(match[1]);
    } catch (error) {
      if (error instanceof PushKeysUnavailableError) {
        this.logger.error('gmail push: verification keys unavailable');
        throw new HttpException(
          { statusCode: 503, error: 'Service Unavailable', code: 'push_keys_unavailable' },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      if (!(error instanceof PushAuthError)) throw error;
      this.logger.warn('gmail push: token rejected');
      throw unauthenticated('Authentication is required');
    }

    const envelope = pubsubPushEnvelopeSchema.safeParse(input.body);
    let pushed: { emailAddress: string; historyId: string };
    let messageId = '';
    try {
      if (!envelope.success) throw new Error('envelope');
      messageId = envelope.data.message.messageId;
      pushed = gmail.decodeGmailPushData(envelope.data.message.data);
      if (!/^[0-9]{1,20}$/.test(pushed.historyId) || pushed.emailAddress.length > 320) {
        throw new Error('payload');
      }
    } catch {
      this.logger.warn('gmail push: authentic message with an unreadable payload, dropped');
      return 'ignored';
    }

    const address = normaliseMailboxAddress(pushed.emailAddress);
    const now = input.now ?? new Date();

    return this.database.db.transaction(async (tx) => {
      const [state] = await tx
        .update(schema.gmailAccountState)
        .set({ lastPushAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.gmailAccountState.emailAddress, address),
            eq(schema.gmailAccountState.enabled, true),
          ),
        )
        .returning({ channelAccountId: schema.gmailAccountState.channelAccountId });
      if (state === undefined) {
        this.logger.warn('gmail push: no enabled mailbox for this notification, dropped');
        return 'ignored' as const;
      }
      // A push is proof of life: a mailbox the heartbeat marked unhealthy is healthy again (R-2.8).
      await tx
        .update(schema.channelAccount)
        .set({ health: 'healthy', updatedAt: now })
        .where(
          and(
            eq(schema.channelAccount.id, state.channelAccountId),
            ne(schema.channelAccount.health, 'healthy'),
          ),
        );
      const payload: GmailSyncJob = {
        channelAccountId: state.channelAccountId,
        reason: 'push',
        pushHistoryId: pushed.historyId,
      };
      const inserted = await enqueueOutbox(tx, {
        queue: GMAIL_QUEUES.gmail,
        jobName: GMAIL_JOBS.sync,
        // BullMQ job ids cannot contain ':'; the Pub/Sub message id is a decimal string.
        jobId: `push-${state.channelAccountId}-${messageId}`,
        payload,
        options: { ...GMAIL_SYNC_OUTBOX_JOB_OPTIONS },
      });
      return inserted ? ('queued' as const) : ('duplicate' as const);
    });
  }
}
