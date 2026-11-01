import { schema } from '@watchtower/db';
import { mintStatusLink } from '@watchtower/domain';
import {
  STATUSPAGE_JOBS,
  statusConfirmJobSchema,
  statusNotifyJobSchema,
  type StatusLocale,
} from '@watchtower/shared';
import { UnrecoverableError, type Job } from 'bullmq';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { ProcessorContext } from '../processors/index.js';
import { renderConfirmation, renderNotice } from './email.js';

const BATCH = 100;

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
  const { database, domain, mailer, config, logger } = context;
  const db = database.db;
  const pageUrl = new URL('/status', config.APP_URL).toString();
  const linkUrl = (path: string, token: string): string => {
    const url = new URL(path, config.APP_URL);
    // The token sits in the fragment: it is not sent to the server by the browser, not logged by a proxy.
    url.hash = `token=${token}`;
    return url.toString();
  };
  const signingKey = domain.config.csat?.signingKey;

  async function confirm(subscriptionId: string): Promise<{ sent: boolean; reason?: string }> {
    if (signingKey === undefined) throw new UnrecoverableError('no signing key for status links');
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
  ): Promise<{ sent: number; skipped?: string }> {
    if (signingKey === undefined) throw new UnrecoverableError('no signing key for status links');
    const content = await contentOf(kind, refId);
    if (content === null) return { sent: 0, skipped: 'not_published' };
    let sent = 0;
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
        } catch (error) {
          // Not told: release the claim so the retry of this job tries this person again.
          await db
            .delete(schema.statusNotification)
            .where(
              and(
                inArray(schema.statusNotification.subscriptionId, [subscriber.id]),
                eq(schema.statusNotification.refKind, kind),
                eq(schema.statusNotification.refId, refId),
              ),
            );
          throw error;
        }
        sent += 1;
        progressed += 1;
      }
      // A whole batch already claimed by someone else: stop instead of spinning.
      if (progressed === 0) break;
    }
    return { sent };
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
