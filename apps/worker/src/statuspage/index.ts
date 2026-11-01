import { schema } from '@watchtower/db';
import { mintStatusLink } from '@watchtower/domain';
import {
  STATUSPAGE_JOBS,
  statusConfirmJobSchema,
  statusNotifyJobSchema,
  type StatusLocale,
} from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';
import { UnrecoverableError, type Job } from 'bullmq';
import { and, asc, eq, notInArray, sql } from 'drizzle-orm';

import type { ProcessorContext } from '../processors/index.js';
import { renderConfirmation, renderNotice } from './email.js';

const BATCH = 100;

/** An SMTP answer in the 5xx class (or an envelope the transport refused): this mailbox will not take it. */
function isPermanentRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { responseCode, code } = error as { responseCode?: unknown; code?: unknown };
  return (
    (typeof responseCode === 'number' && responseCode >= 500 && responseCode < 600) ||
    code === 'EENVELOPE'
  );
}

const localeOf = (value: string): StatusLocale => (value === 'th' ? 'th' : 'en');

/**
 * The consumer of the `statuspage` queue (T-204c). Two jobs, both ids only:
 *
 *  - `confirm`: sends the double opt-in email of one subscription. The link is derived from the row (id and
 *    current nonce) with the signing key, so nothing secret rides the queue or sits in Redis. Nothing is
 *    sent unless the subscription is still `pending` and its window is open by the DATABASE clock.
 *  - `notify`: tells every confirmed subscriber about one published post or window, once each. The claim
 *    row `(subscription, kind, ref)` is written before the send and removed if the send fails, so a retry
 *    resumes with the people not yet told and nobody is told twice. A post that is not published (or a
 *    window that was cancelled) tells nobody.
 *
 * All email goes through the worker's `Mailer` (Mailpit locally); the unsubscribe link is in every notice.
 */
export function createStatusPageRegistration(context: ProcessorContext) {
  const { database, mailer, config, logger } = context;
  const db = database.db;
  const pageUrl = new URL('/status', config.APP_URL).toString();
  const linkUrl = (path: string, token: string): string => {
    const url = new URL(path, config.APP_URL);
    // The token sits in the fragment: it is not sent to the server by the browser, not logged by a proxy.
    url.hash = `token=${token}`;
    return url.toString();
  };
  // Its own subkey (the api derives the same one): a status link can never be a survey link.
  const signingKey = deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.statusLink);

  async function confirm(subscriptionId: string): Promise<{ sent: boolean; reason?: string }> {
    // The page is closed (STATUS_PAGE_PUBLIC=false): nobody is mailed about, or invited to, a page that
    // answers 404.
    if (!config.STATUS_PAGE_PUBLIC) return { sent: false, reason: 'page_closed' };
    const [row] = await db
      .select({
        email: schema.statusSubscription.email,
        locale: schema.statusSubscription.locale,
        state: schema.statusSubscription.state,
        nonce: schema.statusSubscription.confirmNonce,
        open: sql<boolean>`${schema.statusSubscription.confirmExpiresAt} IS NOT NULL
          AND ${schema.statusSubscription.confirmExpiresAt} > clock_timestamp()`,
      })
      .from(schema.statusSubscription)
      .where(eq(schema.statusSubscription.id, subscriptionId))
      .limit(1);
    if (row === undefined) return { sent: false, reason: 'missing' };
    if (row.state !== 'pending' || !row.open) return { sent: false, reason: 'not_pending' };
    try {
      await mailer.send(
        renderConfirmation({
          to: row.email,
          locale: localeOf(row.locale),
          confirmUrl: linkUrl(
            '/status/confirm',
            mintStatusLink(signingKey, 'confirm', subscriptionId, row.nonce),
          ),
        }),
      );
    } catch (error) {
      // The mailbox refuses for good: nothing to retry.
      if (isPermanentRejection(error)) return { sent: false, reason: 'rejected' };
      throw error;
    }
    return { sent: true };
  }

  /** The published content a notice is about, or null when it is not (or no longer) to be sent. */
  async function contentOf(kind: 'post' | 'maintenance', refId: string) {
    if (kind === 'post') {
      const [post] = await db
        .select()
        .from(schema.statusPost)
        .where(and(eq(schema.statusPost.id, refId), eq(schema.statusPost.state, 'published')))
        .limit(1);
      if (post === undefined) return null;
      const names = await db
        .select({ name: schema.statusComponent.name })
        .from(schema.statusPostComponent)
        .innerJoin(
          schema.statusComponent,
          eq(schema.statusComponent.id, schema.statusPostComponent.componentId),
        )
        .where(
          and(
            eq(schema.statusPostComponent.postId, refId),
            eq(schema.statusComponent.public, true),
          ),
        )
        .orderBy(asc(schema.statusComponent.position), asc(schema.statusComponent.name));
      return {
        title: post.title,
        body: post.body,
        names: names.map((row) => row.name),
        startsAt: undefined,
        endsAt: undefined,
      };
    }
    const [window] = await db
      .select()
      .from(schema.statusMaintenance)
      .where(
        and(
          eq(schema.statusMaintenance.id, refId),
          eq(schema.statusMaintenance.state, 'published'),
        ),
      )
      .limit(1);
    if (window === undefined) return null;
    const names = await db
      .select({ name: schema.statusComponent.name })
      .from(schema.statusMaintenanceComponent)
      .innerJoin(
        schema.statusComponent,
        eq(schema.statusComponent.id, schema.statusMaintenanceComponent.componentId),
      )
      .where(
        and(
          eq(schema.statusMaintenanceComponent.maintenanceId, refId),
          eq(schema.statusComponent.public, true),
        ),
      )
      .orderBy(asc(schema.statusComponent.position), asc(schema.statusComponent.name));
    return {
      title: window.title,
      body: window.body,
      names: names.map((row) => row.name),
      startsAt: window.startsAt,
      endsAt: window.endsAt,
    };
  }

  async function notify(
    kind: 'post' | 'maintenance',
    refId: string,
  ): Promise<{ sent: number; bounced?: number; skipped?: string }> {
    if (!config.STATUS_PAGE_PUBLIC) return { sent: 0, skipped: 'page_closed' };
    const content = await contentOf(kind, refId);
    if (content === null) return { sent: 0, skipped: 'not_published' };
    let sent = 0;
    let bounced = 0;
    // Readers whose send failed for a reason that may pass: tried again by the retry of this job, not again now.
    const failed: string[] = [];
    let lastError: unknown;
    for (;;) {
      const batch = await db
        .select({
          id: schema.statusSubscription.id,
          email: schema.statusSubscription.email,
          locale: schema.statusSubscription.locale,
          nonce: schema.statusSubscription.unsubscribeNonce,
        })
        .from(schema.statusSubscription)
        .where(
          and(
            eq(schema.statusSubscription.state, 'confirmed'),
            failed.length === 0 ? undefined : notInArray(schema.statusSubscription.id, failed),
            sql`NOT EXISTS (SELECT 1 FROM status_notification n
              WHERE n.subscription_id = ${schema.statusSubscription.id}
                AND n.ref_kind = ${kind} AND n.ref_id = ${refId})`,
          ),
        )
        .orderBy(asc(schema.statusSubscription.id))
        .limit(BATCH);
      if (batch.length === 0) break;
      let progressed = 0;
      for (const subscriber of batch) {
        const claimed = await db
          .insert(schema.statusNotification)
          .values({ subscriptionId: subscriber.id, refKind: kind, refId })
          .onConflictDoNothing()
          .returning({ id: schema.statusNotification.subscriptionId });
        if (claimed.length === 0) continue;
        progressed += 1;
        try {
          await mailer.send(
            renderNotice({
              to: subscriber.email,
              locale: localeOf(subscriber.locale),
              kind,
              title: content.title,
              body: content.body,
              componentNames: content.names,
              ...(content.startsAt === undefined ? {} : { startsAt: content.startsAt }),
              ...(content.endsAt === undefined ? {} : { endsAt: content.endsAt }),
              pageUrl,
              unsubscribeUrl: linkUrl(
                '/status/unsubscribe',
                mintStatusLink(signingKey, 'unsubscribe', subscriber.id, subscriber.nonce),
              ),
            }),
          );
          sent += 1;
        } catch (error) {
          // One reader's failure never stops the others.
          if (isPermanentRejection(error)) {
            // The server refused this mailbox for good: the claim stays, so no retry mails it again.
            bounced += 1;
            logger.warn({ subscriptionId: subscriber.id }, 'status notice rejected for good');
          } else {
            // Not told, and it may pass: release the claim so a retry of this job tries this person again.
            await db
              .delete(schema.statusNotification)
              .where(
                and(
                  eq(schema.statusNotification.subscriptionId, subscriber.id),
                  eq(schema.statusNotification.refKind, kind),
                  eq(schema.statusNotification.refId, refId),
                ),
              );
            failed.push(subscriber.id);
            lastError = error;
          }
        }
      }
      // A whole batch already claimed by someone else: stop instead of spinning.
      if (progressed === 0) break;
    }
    // Everyone else has been told; the retry (BullMQ backoff) picks up only the readers that failed.
    if (failed.length > 0)
      throw lastError instanceof Error ? lastError : new Error('status notice failed');
    return { sent, bounced };
  }

  return async (job: Job): Promise<unknown> => {
    switch (job.name) {
      case STATUSPAGE_JOBS.confirm: {
        const parsed = statusConfirmJobSchema.safeParse(job.data);
        if (!parsed.success) throw new UnrecoverableError('statuspage job payload is invalid');
        const result = await confirm(parsed.data.subscriptionId);
        logger.info({ sent: result.sent, reason: result.reason }, 'status confirmation');
        return result;
      }
      case STATUSPAGE_JOBS.notify: {
        const parsed = statusNotifyJobSchema.safeParse(job.data);
        if (!parsed.success) throw new UnrecoverableError('statuspage job payload is invalid');
        const result = await notify(parsed.data.kind, parsed.data.refId);
        logger.info({ kind: parsed.data.kind, ...result }, 'status notice');
        return result;
      }
      default:
        throw new UnrecoverableError(`unknown statuspage job "${job.name}"`);
    }
  };
}
