import { webpush } from '@watchtower/channels';
import { schema, type Database } from '@watchtower/db';
import {
  formatTicketKey,
  notificationKindSchema,
  notificationSeveritySchema,
  webPushDelivery,
  webPushJobSchema,
  type WebPushPayload,
} from '@watchtower/shared';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';

import type { WorkerLogger } from '../logger.js';
import { PushTransportError, type PushTransport } from './transport.js';

/** A subscription that failed for good this many times in a row is dropped (its browser or key is wrong for us). */
export const MAX_PERMANENT_FAILURES = 5;
/** A `Retry-After` longer than this is not waited for in one go; the job is looked at again then. */
const MAX_RETRY_AFTER_MS = 15 * 60 * 1000;

export interface VapidConfig {
  readonly keys: webpush.VapidKeys;
  readonly subject: string;
}

export interface WebPushProcessorDeps {
  readonly database: Database;
  readonly logger: WorkerLogger;
  readonly transport: PushTransport;
  /** The VAPID credential in effect, or null when Web Push is off (missing, incomplete or inconsistent). */
  readonly vapid: () => Promise<VapidConfig | null>;
  readonly ticketKeyPrefix: string;
  readonly now?: () => number;
}

export type WebPushResult =
  | { readonly status: 'sent' }
  | {
      readonly status: 'skipped';
      readonly reason: 'disabled' | 'expired' | 'read' | 'gone_notification' | 'gone_subscription';
    }
  | { readonly status: 'subscription_removed'; readonly reason: string }
  | { readonly status: 'rejected'; readonly httpStatus: number; readonly removed: boolean };

/**
 * Consumer of the Web Push queue: one job is one notification for one browser. It sends nothing a customer
 * wrote: the message holds the kind, the severity, the notification id and an in-app path (the ticket key
 * is the internal number, not text from a message). The app fetches the details once it is open.
 *
 *  - 201: done. 404/410: the browser unsubscribed, the subscription is deleted. 413 and other 4xx: the
 *    request is wrong for this subscription, it is not retried and counts toward the failure limit.
 *  - 429 and 5xx: the job is moved to `Retry-After` when the service sent seconds (no attempt used, bounded by
 *    the job's own expiry), otherwise it fails and BullMQ retries with exponential backoff (WEB_PUSH_JOB_OPTIONS).
 *  - A network failure or timeout throws: retried the same way, then kept as a failed job.
 *  - The endpoint, the keys and the message never reach a log line: only ids and the HTTP status.
 */
export function createWebPushProcessor(deps: WebPushProcessorDeps) {
  const { database, logger } = deps;
  const db = database.db;
  const now = deps.now ?? (() => Date.now());

  return async (job: Job, token?: string): Promise<WebPushResult> => {
    const parsed = webPushJobSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError('web push job payload is invalid');
    const { notificationId, subscriptionId } = parsed.data;
    const notAfter = (job.data as { notAfter?: unknown }).notAfter;
    if (typeof notAfter === 'number' && now() > notAfter) {
      return { status: 'skipped', reason: 'expired' };
    }

    const vapid = await deps.vapid();
    if (vapid === null) return { status: 'skipped', reason: 'disabled' };

    const [found] = await db
      .select({
        userId: schema.notification.userId,
        kind: schema.notification.kind,
        severity: schema.notification.severity,
        readAt: schema.notification.readAt,
        ticketNumber: schema.ticket.number,
      })
      .from(schema.notification)
      .leftJoin(schema.ticket, eq(schema.ticket.id, schema.notification.ticketId))
      .where(eq(schema.notification.id, notificationId))
      .limit(1);
    if (found === undefined) return { status: 'skipped', reason: 'gone_notification' };
    // Read in the app in the meantime (the app is open): a push now would only repeat it.
    if (found.readAt !== null) return { status: 'skipped', reason: 'read' };

    const [subscription] = await db
      .select({
        id: schema.webPushSubscription.id,
        endpoint: schema.webPushSubscription.endpoint,
        p256dh: schema.webPushSubscription.p256dh,
        auth: schema.webPushSubscription.auth,
        failureCount: schema.webPushSubscription.failureCount,
      })
      .from(schema.webPushSubscription)
      // The subscription must be the notification's own person's: a job cannot be pointed at someone else's browser.
      .where(
        and(
          eq(schema.webPushSubscription.id, subscriptionId),
          eq(schema.webPushSubscription.userId, found.userId),
        ),
      )
      .limit(1);
    if (subscription === undefined) return { status: 'skipped', reason: 'gone_subscription' };

    const kind = notificationKindSchema.parse(found.kind);
    const severity = notificationSeveritySchema.parse(found.severity);
    const payload: WebPushPayload = {
      v: 1,
      kind,
      severity,
      notificationId,
      url:
        found.ticketNumber === null
          ? '/'
          : `/?ticket=${encodeURIComponent(formatTicketKey(found.ticketNumber, deps.ticketKeyPrefix))}`,
    };

    const removeSubscription = async (): Promise<void> => {
      await db
        .delete(schema.webPushSubscription)
        .where(eq(schema.webPushSubscription.id, subscription.id));
    };

    let request: webpush.PushRequest;
    try {
      request = webpush.buildPushRequest({
        subscription,
        payload: Buffer.from(JSON.stringify(payload), 'utf8'),
        options: webPushDelivery(kind, severity),
        vapid,
        nowMs: now(),
      });
    } catch (error) {
      if (error instanceof webpush.PushRequestError) {
        // A stored endpoint that is no longer allowed (the list was tightened) or keys that cannot be used.
        await removeSubscription();
        logger.warn(
          { subscriptionId: subscription.id, reason: error.reason },
          'web push subscription removed: unusable',
        );
        return { status: 'subscription_removed', reason: error.reason };
      }
      throw error;
    }

    let response;
    try {
      response = await deps.transport(request);
    } catch (error) {
      if (error instanceof PushTransportError && error.reason === 'blocked_address') {
        // The allow-listed host resolved to a non-public address: never send, never retry.
        logger.error(
          { subscriptionId: subscription.id },
          'web push host resolved to a blocked address',
        );
        throw new UnrecoverableError('web push host resolved to a blocked address');
      }
      // A timeout or a network error: BullMQ retries with backoff.
      throw error;
    }

    const outcome = webpush.classifyPushResponse(response.status, response.retryAfter);
    switch (outcome.kind) {
      case 'sent':
        await db
          .update(schema.webPushSubscription)
          .set({ lastSuccessAt: sql`now()`, failureCount: 0 })
          .where(eq(schema.webPushSubscription.id, subscription.id));
        return { status: 'sent' };
      case 'gone':
        await removeSubscription();
        logger.info(
          { subscriptionId: subscription.id, httpStatus: response.status },
          'web push subscription is gone, removed',
        );
        return { status: 'subscription_removed', reason: 'gone' };
      case 'retry': {
        logger.warn(
          {
            subscriptionId: subscription.id,
            httpStatus: response.status,
            retryAfter: outcome.retryAfterSeconds,
          },
          'web push service asked to try again later',
        );
        if (outcome.retryAfterSeconds !== null && token !== undefined) {
          const wait = Math.min(outcome.retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS);
          await job.moveToDelayed(now() + Math.max(1000, wait), token);
          throw new DelayedError();
        }
        throw new Error(`push service answered ${response.status.toString()}`);
      }
      case 'rejected': {
        const failures = subscription.failureCount + 1;
        const removed = failures >= MAX_PERMANENT_FAILURES;
        if (removed) await removeSubscription();
        else {
          await db
            .update(schema.webPushSubscription)
            .set({ failureCount: failures })
            .where(eq(schema.webPushSubscription.id, subscription.id));
        }
        logger.warn(
          { subscriptionId: subscription.id, httpStatus: outcome.status, failures, removed },
          'web push rejected by the push service',
        );
        return { status: 'rejected', httpStatus: outcome.status, removed };
      }
    }
  };
}
