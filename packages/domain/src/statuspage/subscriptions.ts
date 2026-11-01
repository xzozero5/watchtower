import { schema } from '@watchtower/db';
import {
  QUEUE_NAMES,
  STATUSPAGE_AUDIT_ACTIONS,
  STATUSPAGE_JOBS,
  statusEmailSchema,
  type StatusLocale,
} from '@watchtower/shared';
import { eq, sql } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { badRequest } from '../errors.js';
import { enqueueJob } from '../outbox.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';
import { newStatusNonce, verifyStatusLink } from './links.js';

/** How long a confirmation link stays open `[ASSUMED]`. */
export const STATUS_CONFIRM_WINDOW_HOURS = 48;
/** A pending subscription is sent a new confirmation no sooner than this `[ASSUMED]`. */
export const STATUS_RESEND_AFTER_SECONDS = 300;

const SEND_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: true,
  removeOnFail: { age: 24 * 3600 },
} as const;

export type SubscriptionRequestOutcome =
  'created' | 'resent' | 'reactivated' | 'throttled' | 'already_confirmed';

const dbNow = sql`clock_timestamp()`;

async function queueConfirmation(
  tx: DbTransaction,
  ctx: DomainContext,
  id: string,
  nonce: string,
): Promise<void> {
  await enqueueJob(tx, ctx.config, {
    queue: QUEUE_NAMES.statuspage,
    name: STATUSPAGE_JOBS.confirm,
    jobId: `status-confirm-${id}-${nonce}`,
    payload: { subscriptionId: id },
    options: SEND_OPTIONS,
  });
}

/**
 * Someone asks to be told about the status page (R-6.2). Nothing is public about the answer: the caller
 * says the same thing whatever happened here, so the form cannot be used to find out who is subscribed.
 *
 *  - new address: a `pending` row and a confirmation email;
 *  - pending: a new confirmation (new nonce, so the old link dies), at most once per
 *    `STATUS_RESEND_AFTER_SECONDS` of the database clock;
 *  - unsubscribed: pending again with new nonces, and a confirmation: coming back needs a new opt-in;
 *  - confirmed: nothing is sent (an unrequested email to a confirmed reader is noise).
 *
 * Only the address's owner can confirm, because the link goes to the address.
 */
export async function requestStatusSubscription(
  tx: DbTransaction,
  ctx: DomainContext,
  input: { readonly email: string; readonly locale: StatusLocale },
): Promise<DomainResult<{ readonly outcome: SubscriptionRequestOutcome }>> {
  const fx = new Effects();
  const parsed = statusEmailSchema.safeParse(input.email);
  if (!parsed.success) throw badRequest('Not an email address');
  const email = parsed.data;

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`status-subscription:${email}`}, 0))`,
  );
  const [row] = await tx
    .select({
      id: schema.statusSubscription.id,
      state: schema.statusSubscription.state,
      recent: sql<boolean>`${schema.statusSubscription.confirmationSentAt} IS NOT NULL
        AND ${schema.statusSubscription.confirmationSentAt}
          > clock_timestamp() - make_interval(secs => ${STATUS_RESEND_AFTER_SECONDS})`,
    })
    .from(schema.statusSubscription)
    .where(eq(schema.statusSubscription.email, email))
    .for('update')
    .limit(1);

  let outcome: SubscriptionRequestOutcome;
  let id: string;
  const confirmExpiresAt = sql`clock_timestamp() + make_interval(hours => ${STATUS_CONFIRM_WINDOW_HOURS})`;
  if (row === undefined) {
    const nonce = newStatusNonce();
    const [created] = await tx
      .insert(schema.statusSubscription)
      .values({
        email,
        locale: input.locale,
        state: 'pending',
        confirmNonce: nonce,
        unsubscribeNonce: newStatusNonce(),
        confirmExpiresAt,
        confirmationSentAt: dbNow,
      })
      .returning({ id: schema.statusSubscription.id });
    if (created === undefined) throw new Error('status_subscription insert returned no row');
    id = created.id;
    await queueConfirmation(tx, ctx, id, nonce);
    outcome = 'created';
  } else {
    id = row.id;
    if (row.state === 'confirmed') {
      outcome = 'already_confirmed';
    } else if (row.state === 'pending' && row.recent) {
      outcome = 'throttled';
    } else {
      const nonce = newStatusNonce();
      await tx
        .update(schema.statusSubscription)
        .set({
          state: 'pending',
          locale: input.locale,
          confirmNonce: nonce,
          // A returning reader gets a new unsubscribe link too: the old one belonged to the old opt-in.
          ...(row.state === 'unsubscribed'
            ? { unsubscribeNonce: newStatusNonce(), unsubscribedAt: null, confirmedAt: null }
            : {}),
          confirmExpiresAt,
          confirmationSentAt: dbNow,
          updatedAt: dbNow,
        })
        .where(eq(schema.statusSubscription.id, id));
      await queueConfirmation(tx, ctx, id, nonce);
      outcome = row.state === 'unsubscribed' ? 'reactivated' : 'resent';
    }
  }
  await recordAuditInTx(tx, ctx, fx, {
    action: STATUSPAGE_AUDIT_ACTIONS.subscriptionRequest,
    targetType: 'status_subscription',
    targetId: id,
    metadata: { outcome },
  });
  return fx.result({ outcome });
}

/**
 * The owner of an address followed the confirmation link. The signature is checked first (a forged link
 * never reaches the database), then the row: the nonce must be the current one and the window still open
 * by the database clock. Following the link twice is harmless. Every refusal is `invalid`, one answer, so
 * the page cannot be used to probe.
 */
export async function confirmStatusSubscription(
  tx: DbTransaction,
  ctx: DomainContext,
  key: Buffer,
  token: string,
): Promise<DomainResult<{ readonly outcome: 'confirmed' | 'invalid' }>> {
  const fx = new Effects();
  const claims = verifyStatusLink(key, token);
  if (claims?.purpose !== 'confirm') return fx.result({ outcome: 'invalid' });
  const [row] = await tx
    .select({
      state: schema.statusSubscription.state,
      nonce: schema.statusSubscription.confirmNonce,
      open: sql<boolean>`${schema.statusSubscription.confirmExpiresAt} IS NOT NULL
        AND ${schema.statusSubscription.confirmExpiresAt} > clock_timestamp()`,
    })
    .from(schema.statusSubscription)
    .where(eq(schema.statusSubscription.id, claims.subscriptionId))
    .for('update')
    .limit(1);
  if (row?.nonce !== claims.nonce) return fx.result({ outcome: 'invalid' });
  if (row.state === 'confirmed') return fx.result({ outcome: 'confirmed' });
  if (row.state !== 'pending' || !row.open) return fx.result({ outcome: 'invalid' });
  await tx
    .update(schema.statusSubscription)
    .set({ state: 'confirmed', confirmedAt: dbNow, updatedAt: dbNow })
    .where(eq(schema.statusSubscription.id, claims.subscriptionId));
  await recordAuditInTx(tx, ctx, fx, {
    action: STATUSPAGE_AUDIT_ACTIONS.subscriptionConfirm,
    targetType: 'status_subscription',
    targetId: claims.subscriptionId,
  });
  return fx.result({ outcome: 'confirmed' });
}

/** The unsubscribe link in every email. Idempotent; a stale link (a newer opt-in replaced it) is `invalid`. */
export async function unsubscribeStatusSubscription(
  tx: DbTransaction,
  ctx: DomainContext,
  key: Buffer,
  token: string,
): Promise<DomainResult<{ readonly outcome: 'unsubscribed' | 'invalid' }>> {
  const fx = new Effects();
  const claims = verifyStatusLink(key, token);
  if (claims?.purpose !== 'unsubscribe') return fx.result({ outcome: 'invalid' });
  const [row] = await tx
    .select({
      state: schema.statusSubscription.state,
      nonce: schema.statusSubscription.unsubscribeNonce,
    })
    .from(schema.statusSubscription)
    .where(eq(schema.statusSubscription.id, claims.subscriptionId))
    .for('update')
    .limit(1);
  if (row?.nonce !== claims.nonce) return fx.result({ outcome: 'invalid' });
  if (row.state === 'unsubscribed') return fx.result({ outcome: 'unsubscribed' });
  await tx
    .update(schema.statusSubscription)
    .set({ state: 'unsubscribed', unsubscribedAt: dbNow, updatedAt: dbNow })
    .where(eq(schema.statusSubscription.id, claims.subscriptionId));
  await recordAuditInTx(tx, ctx, fx, {
    action: STATUSPAGE_AUDIT_ACTIONS.subscriptionUnsubscribe,
    targetType: 'status_subscription',
    targetId: claims.subscriptionId,
  });
  return fx.result({ outcome: 'unsubscribed' });
}
