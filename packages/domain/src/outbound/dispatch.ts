import { randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  DELIVERY_LEASE_SECONDS,
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_RETRY_KEY_MAX_AGE_SECONDS,
  OUTBOUND_DISPATCH_JOB_OPTIONS,
  OUTBOUND_JOBS,
  OUTBOUND_TICKET_EVENTS,
  QUEUE_NAMES,
  type DeliveryRoute,
} from '@watchtower/shared';
import { and, asc, eq, gte, lt, lte, or, sql, type SQL } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { authorityNow } from '../clock.js';
import { clearStaleReplyTokens } from './reply-token.js';
import { enqueueJob } from '../outbox.js';
import type { PolicyDecision } from '../policy.js';
import type { MessageRow, OutboundDeliveryRow, TicketRow } from '../rows.js';
import { TicketKeys } from '../ticket-keys.js';
import { messageEvent, recordTicketEvent, ticketEvent } from '../tickets/support.js';
import {
  Effects,
  type Actor,
  type DbTransaction,
  type DomainContext,
  type DomainResult,
  type ReadExecutor,
} from '../types.js';
import { billingPeriod, moveQuota } from './quota.js';
import { contentHash, dispatchJobId, retryKeyExpired, type FailureDecision } from './state.js';
import { parseRenderInputs, renderSystemTemplate } from './templates.js';

/**
 * The database half of the dispatcher (ADR-010 section 3). The worker composes these steps with the
 * channel adapters, which the domain does not import:
 *
 *   claimDelivery          CAS `scheduled -> sending` (short transaction, nothing else in it)
 *   vetDelivery            policy gate and content checks, outside any transaction (the gate uses its own connection)
 *   denyDelivery           vetting failed: `sending -> cancelled`, nothing was sent
 *   markDispatched         route chosen, quota reserved by the caller, about to call the provider
 *   recordSent|recordFailure   the result, one transaction each
 *   sweepDeliveries        stuck `sending`, overdue `scheduled`, stale reply tokens
 *
 * Every write is a compare-and-set on the state, so a duplicate trigger, a sweeper and a slow worker
 * can all run at once and at most one of them acts.
 */

const leaseUntil = (now: Date): Date => new Date(now.getTime() + DELIVERY_LEASE_SECONDS * 1000);

/**
 * "This claim still owns the row" (review O-1): the delivery is `sending` AND carries the token this
 * worker was given. A worker that stalled past its lease, was swept back to `scheduled` and replaced by
 * another claim presents a token that no longer exists, so none of its writes match.
 */
function owned(delivery: Pick<OutboundDeliveryRow, 'id' | 'claimToken'>): SQL {
  return and(
    eq(schema.outboundDelivery.id, delivery.id),
    eq(schema.outboundDelivery.state, 'sending'),
    delivery.claimToken === null
      ? sql`false`
      : eq(schema.outboundDelivery.claimToken, delivery.claimToken),
  ) as SQL;
}

/** Who the gate sees as the sender of a delivery: reconstructed from the row, never supplied by a job. */
export function actorOfDelivery(delivery: OutboundDeliveryRow): Actor {
  switch (delivery.origin) {
    case 'human':
      return { type: 'user', id: delivery.createdBy };
    case 'ai_approved':
      return { type: 'user', id: delivery.approvedBy };
    default:
      return { type: 'system', id: null };
  }
}

/**
 * Takes a due delivery: one UPDATE that succeeds for exactly one caller. Null means somebody else
 * has it, it was undone, it was sent, or the hold has not ended (a repeated trigger, an early one).
 */
export async function claimDelivery(
  tx: DbTransaction,
  ctx: DomainContext,
  deliveryId: string,
): Promise<OutboundDeliveryRow | null> {
  // The same clock that stamped the hold (review O-7): a worker whose own clock is fast cannot claim early.
  const now = await authorityNow(tx, ctx);
  const [claimed] = await tx
    .update(schema.outboundDelivery)
    .set({
      state: 'sending',
      attempts: sql`${schema.outboundDelivery.attempts} + 1`,
      // Fencing (review O-1): every later write presents this token; a replaced worker's has changed.
      claimToken: randomUUID(),
      leaseUntil: leaseUntil(now),
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.outboundDelivery.id, deliveryId),
        eq(schema.outboundDelivery.state, 'scheduled'),
        lte(schema.outboundDelivery.nextAttemptAt, now),
      ),
    )
    .returning();
  return claimed ?? null;
}

export type Vetting =
  | { readonly ok: true; readonly ticket: TicketRow; readonly message: MessageRow }
  | { readonly ok: false; readonly reason: string };

/**
 * Re-checks everything that made the send legitimate when it was scheduled, now that it is about
 * to happen: the text is still the text (hash), an AI draft is still approved by the same person for
 * the same text (A-2), and the policy gate still says yes (switches and stages may have changed
 * during the hold; N3). A missing gate refuses. A gate that throws propagates: the caller treats it
 * as "not sent, try again" (fail closed, never fail open).
 */
export async function vetDelivery(
  db: ReadExecutor,
  ctx: DomainContext,
  delivery: OutboundDeliveryRow,
): Promise<Vetting> {
  const [message] = await db
    .select()
    .from(schema.message)
    .where(eq(schema.message.id, delivery.messageId))
    .limit(1);
  const [ticket] = await db
    .select()
    .from(schema.ticket)
    .where(eq(schema.ticket.id, delivery.ticketId))
    .limit(1);
  if (message === undefined || ticket === undefined)
    return { ok: false, reason: 'message_missing' };
  if (
    message.direction !== 'outbound' ||
    message.visibility !== 'public' ||
    message.ticketId !== ticket.id
  ) {
    return { ok: false, reason: 'message_not_sendable' };
  }
  if (contentHash(message.bodyText) !== delivery.contentHash) {
    return { ok: false, reason: 'content_changed' };
  }
  if (delivery.aiDraftId !== null) {
    const [draft] = await db
      .select()
      .from(schema.aiDraft)
      .where(eq(schema.aiDraft.id, delivery.aiDraftId))
      .limit(1);
    if (draft === undefined) return { ok: false, reason: 'ai_draft_not_found' };
    if (
      draft.status !== 'approved' ||
      draft.approvedBy === null ||
      draft.approvedBy !== delivery.approvedBy
    ) {
      return { ok: false, reason: 'ai_draft_not_approved' };
    }
    if (draft.contentHash !== delivery.contentHash) {
      return { ok: false, reason: 'ai_draft_content_mismatch' };
    }
  }
  if (delivery.origin === 'system_template') {
    // Review O-4: the text must be what the key renders from the inputs stored at schedule time, and
    // those inputs must still be the ticket's own key and the instance's portal address.
    const inputs = parseRenderInputs(delivery.renderInputs);
    const rendered =
      inputs === null || delivery.templateKey === null
        ? null
        : renderSystemTemplate(delivery.templateKey, inputs);
    if (
      inputs === null ||
      rendered === null ||
      rendered !== message.bodyText ||
      inputs.ticketKey !== new TicketKeys(ctx.config.ticketKeyPrefix).format(ticket.number) ||
      inputs.portalUrl !== (ctx.config.portalUrl ?? null)
    ) {
      return { ok: false, reason: 'template_body_mismatch' };
    }
  }
  const gate = ctx.policyGate;
  if (gate === undefined) return { ok: false, reason: 'no_policy_gate' };
  const decision: PolicyDecision = await gate.check({
    ticketId: ticket.id,
    channel: ticket.channel,
    intentId: ticket.intentId,
    actor: actorOfDelivery(delivery),
    origin: delivery.origin as 'human' | 'ai_approved' | 'system_template',
    templateKey: delivery.templateKey,
    approvedBy: delivery.approvedBy,
    auditMeta: ctx.auditMeta,
  });
  return decision.allowed ? { ok: true, ticket, message } : { ok: false, reason: decision.reason };
}

async function ticketOf(tx: DbTransaction, ticketId: string): Promise<TicketRow | undefined> {
  return (await tx.select().from(schema.ticket).where(eq(schema.ticket.id, ticketId)).limit(1))[0];
}

/** An approved AI draft goes back to waiting when its send did not happen. */
async function reopenDraft(tx: DbTransaction, delivery: OutboundDeliveryRow): Promise<void> {
  if (delivery.aiDraftId === null) return;
  await tx
    .update(schema.aiDraft)
    .set({ status: 'draft', approvedBy: null, approvedAt: null })
    .where(and(eq(schema.aiDraft.id, delivery.aiDraftId), eq(schema.aiDraft.status, 'approved')));
}

/**
 * Vetting refused a claimed delivery: nothing was sent and nothing will be. `sending -> cancelled`
 * with `error_code = policy_denied`; the message is marked failed so staff see it did not go out
 * (a Retry goes through the gate again). The reason is in the audit row, never the text.
 */
export async function denyDelivery(
  tx: DbTransaction,
  ctx: DomainContext,
  delivery: OutboundDeliveryRow,
  reason: string,
): Promise<DomainResult<boolean>> {
  const fx = new Effects();
  if (delivery.claimToken === null) return fx.result(false);
  const now = await authorityNow(tx, ctx);
  // T-122f F-1: a push that went out in an earlier attempt may have reached the customer. Refusing the
  // next attempt must not read as "nothing was sent": it ends `failed` with the unknown outcome, so the
  // person who retries is told it may arrive twice. Otherwise nothing was sent and it is `cancelled`.
  const pinnedPush = delivery.route === 'line_push';
  const [updated] = await tx
    .update(schema.outboundDelivery)
    .set(
      pinnedPush
        ? {
            state: 'failed',
            errorCode: 'policy_denied',
            outcomeUnknown: true,
            leaseUntil: null,
            updatedAt: now,
          }
        : {
            state: 'cancelled',
            errorCode: 'policy_denied',
            leaseUntil: null,
            cancelledAt: now,
            updatedAt: now,
          },
    )
    .where(owned(delivery))
    .returning({ id: schema.outboundDelivery.id });
  if (updated === undefined) return fx.result(false);
  await tx
    .update(schema.message)
    .set({ deliveryStatus: 'failed' })
    .where(eq(schema.message.id, delivery.messageId));
  await reopenDraft(tx, delivery);
  const ticket = await ticketOf(tx, delivery.ticketId);
  await recordTicketEvent(
    tx,
    delivery.ticketId,
    OUTBOUND_TICKET_EVENTS.messageDeliveryFailed,
    ctx.actor,
    'internal',
    {
      deliveryId: delivery.id,
      messageId: delivery.messageId,
      errorCode: 'policy_denied',
      reason,
      ...(pinnedPush ? { outcomeUnknown: true } : {}),
    },
  );
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.outboundPolicyDenied,
    outcome: 'denied',
    targetType: 'outbound_delivery',
    targetId: delivery.id,
    metadata: {
      ticketId: delivery.ticketId,
      messageId: delivery.messageId,
      channel: delivery.channel,
      origin: delivery.origin,
      templateKey: delivery.templateKey,
      aiDraftId: delivery.aiDraftId,
      approvedBy: delivery.approvedBy,
      reason,
      attempts: delivery.attempts,
      outcomeUnknown: pinnedPush,
    },
  });
  if (ticket !== undefined) fx.emit(ticketEvent(ctx, 'ticket.updated', ticket, ['delivery']));
  return fx.result(true);
}

/**
 * Right before the provider is called: records the route and that the call is about to happen.
 * From here on a lost answer means "unknown", before it the delivery provably never left. False
 * when the row is no longer ours (the sweeper took it).
 */
export async function markDispatched(
  tx: DbTransaction,
  ctx: DomainContext,
  delivery: Pick<OutboundDeliveryRow, 'id' | 'claimToken'>,
  route: DeliveryRoute,
): Promise<boolean> {
  const now = await authorityNow(tx, ctx);
  const rows = await tx
    .update(schema.outboundDelivery)
    .set({ route, dispatchedAt: now, leaseUntil: leaseUntil(now), updatedAt: now })
    .where(owned(delivery))
    .returning({ id: schema.outboundDelivery.id });
  return rows.length > 0;
}

export interface SentResult {
  readonly route: DeliveryRoute;
  readonly providerMessageId: string | null;
  /** Our `Message-ID`, normalised (Gmail). */
  readonly rfc822MessageId: string | null;
  readonly providerThreadId: string | null;
  /** The conversation key to stamp on the message (`gmail:<threadId>`, `line:<id>`). */
  readonly threadKey: string | null;
  /** LINE answered 409 to a repeated retry key: it had already accepted this message. */
  readonly alreadyAccepted: boolean;
}

/**
 * The provider accepted the message. `sending -> sent`, the message becomes `delivered` and gets its
 * provider identity (so a customer's reply can be matched to the ticket, T-122c), and for a person's
 * reply the SLA clock's first response is stamped at this instant, not when the button was pressed
 * (ADR-010 section 3). An automatic acknowledgment is not a first response.
 *
 * A delivery that the sweeper already failed as `outcome_unknown` is healed by a late success.
 */
export async function recordSent(
  tx: DbTransaction,
  ctx: DomainContext,
  delivery: OutboundDeliveryRow,
  result: SentResult,
): Promise<DomainResult<boolean>> {
  const fx = new Effects();
  const now = await authorityNow(tx, ctx);
  const [sent] = await tx
    .update(schema.outboundDelivery)
    .set({
      state: 'sent',
      route: result.route,
      providerMessageId: result.providerMessageId,
      rfc822MessageId: result.rfc822MessageId,
      providerThreadId: result.providerThreadId,
      errorCode: null,
      outcomeUnknown: false,
      leaseUntil: null,
      sentAt: now,
      updatedAt: now,
    })
    .where(
      // The claim that made the call; or, after the sweeper failed it as unknown, the same claim
      // answering late. A newer claim has a different token.
      delivery.claimToken === null
        ? sql`false`
        : and(
            eq(schema.outboundDelivery.id, delivery.id),
            eq(schema.outboundDelivery.claimToken, delivery.claimToken),
            or(
              eq(schema.outboundDelivery.state, 'sending'),
              and(
                eq(schema.outboundDelivery.state, 'failed'),
                eq(schema.outboundDelivery.outcomeUnknown, true),
              ),
            ),
          ),
    )
    .returning({ id: schema.outboundDelivery.id });
  if (sent === undefined) return fx.result(false);

  const [delivered] = await tx
    .update(schema.message)
    .set({
      deliveryStatus: 'delivered',
      ...(result.providerMessageId === null ? {} : { externalId: result.providerMessageId }),
      threadKey:
        result.threadKey === null
          ? sql`${schema.message.threadKey}`
          : sql`COALESCE(${schema.message.threadKey}, ${result.threadKey})`,
    })
    .where(eq(schema.message.id, delivery.messageId))
    .returning();
  if (delivery.aiDraftId !== null) {
    await tx
      .update(schema.aiDraft)
      // `draft` too: an unknown outcome reopened the draft and a late success closes it again.
      .set({
        status: 'sent',
        approvedBy: delivery.approvedBy,
        approvedAt: sql`COALESCE(${schema.aiDraft.approvedAt}, ${now})`,
      })
      .where(
        and(
          eq(schema.aiDraft.id, delivery.aiDraftId),
          or(eq(schema.aiDraft.status, 'approved'), eq(schema.aiDraft.status, 'draft')),
        ),
      );
  }
  const firstResponse =
    delivery.origin === 'system_template'
      ? []
      : await tx
          .update(schema.ticket)
          .set({ firstRespondedAt: now, updatedAt: now })
          .where(
            and(
              eq(schema.ticket.id, delivery.ticketId),
              sql`${schema.ticket.firstRespondedAt} IS NULL`,
            ),
          )
          .returning({ id: schema.ticket.id });
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.outboundSent,
    targetType: 'outbound_delivery',
    targetId: delivery.id,
    metadata: {
      ticketId: delivery.ticketId,
      messageId: delivery.messageId,
      channel: delivery.channel,
      route: result.route,
      origin: delivery.origin,
      templateKey: delivery.templateKey,
      aiDraftId: delivery.aiDraftId,
      approvedBy: delivery.approvedBy,
      attempts: delivery.attempts,
      alreadyAccepted: result.alreadyAccepted,
      firstResponse: firstResponse.length > 0,
    },
  });
  const ticket = await ticketOf(tx, delivery.ticketId);
  if (ticket !== undefined) {
    // The customer's screen shows a reply only once it has reached them: tell it now.
    if (delivered !== undefined) fx.emit(messageEvent(ctx, ticket, delivered));
    fx.emit(
      ticketEvent(
        ctx,
        'ticket.updated',
        ticket,
        firstResponse.length > 0 ? ['delivery', 'sla'] : ['delivery'],
      ),
    );
  }
  return fx.result(true);
}

/**
 * The attempt did not end in a send. A retry puts the row back to `scheduled` with a later
 * `next_attempt_at` and a new trigger; a failure ends it: the message is `failed`, staff get a
 * timeline event and a realtime nudge, and an AI draft returns to waiting. False when the row is not
 * ours any more. The audit row carries the code and the counts, never the text.
 */
export async function recordFailure(
  tx: DbTransaction,
  ctx: DomainContext,
  delivery: OutboundDeliveryRow,
  decision: FailureDecision,
  extra: { readonly reason?: string } = {},
): Promise<DomainResult<boolean>> {
  const fx = new Effects();
  const now = await authorityNow(tx, ctx);
  if (decision.action === 'retry') {
    const nextAttemptAt = new Date(now.getTime() + decision.delaySeconds * 1000);
    const [back] = await tx
      .update(schema.outboundDelivery)
      .set({
        state: 'scheduled',
        nextAttemptAt,
        claimToken: null,
        leaseUntil: null,
        dispatchedAt: null,
        // The refusal that caused the retry: the database requires one before a delivery that
        // reached the provider may go back to `scheduled` (migration 0014).
        errorCode: decision.errorCode ?? 'retry_scheduled',
        updatedAt: now,
      })
      .where(owned(delivery))
      .returning({ id: schema.outboundDelivery.id });
    if (back === undefined) return fx.result(false);
    await enqueueJob(tx, ctx.config, {
      queue: QUEUE_NAMES.outbound,
      name: OUTBOUND_JOBS.dispatch,
      jobId: dispatchJobId(delivery.id, delivery.attempts),
      payload: { deliveryId: delivery.id },
      notBefore: nextAttemptAt,
      options: OUTBOUND_DISPATCH_JOB_OPTIONS,
    });
    return fx.result(true);
  }

  const [failed] = await tx
    .update(schema.outboundDelivery)
    .set({
      state: 'failed',
      errorCode: decision.errorCode,
      outcomeUnknown: decision.outcomeUnknown,
      leaseUntil: null,
      updatedAt: now,
    })
    .where(owned(delivery))
    .returning({ id: schema.outboundDelivery.id });
  if (failed === undefined) return fx.result(false);
  await finishFailed(
    tx,
    ctx,
    fx,
    delivery,
    decision.errorCode,
    decision.outcomeUnknown,
    extra.reason,
  );
  return fx.result(true);
}

async function finishFailed(
  tx: DbTransaction,
  ctx: DomainContext,
  fx: Effects,
  delivery: OutboundDeliveryRow,
  errorCode: string,
  outcomeUnknown: boolean,
  reason: string | undefined,
): Promise<void> {
  await tx
    .update(schema.message)
    .set({ deliveryStatus: 'failed' })
    .where(eq(schema.message.id, delivery.messageId));
  await reopenDraft(tx, delivery);
  await recordTicketEvent(
    tx,
    delivery.ticketId,
    OUTBOUND_TICKET_EVENTS.messageDeliveryFailed,
    ctx.actor,
    'internal',
    {
      deliveryId: delivery.id,
      messageId: delivery.messageId,
      errorCode,
      outcomeUnknown,
      route: delivery.route,
    },
  );
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.outboundFailed,
    outcome: 'failure',
    targetType: 'outbound_delivery',
    targetId: delivery.id,
    metadata: {
      ticketId: delivery.ticketId,
      messageId: delivery.messageId,
      channel: delivery.channel,
      route: delivery.route,
      origin: delivery.origin,
      errorCode,
      outcomeUnknown,
      attempts: delivery.attempts,
      ...(reason === undefined ? {} : { reason }),
    },
  });
  const ticket = await ticketOf(tx, delivery.ticketId);
  if (ticket !== undefined) fx.emit(ticketEvent(ctx, 'ticket.updated', ticket, ['delivery']));
}

export interface SweepResult {
  /** `sending` rows whose lease ran out that provably never reached the provider: back to `scheduled`. */
  readonly released: number;
  /** `sending` rows that may have reached the provider: failed as `outcome_unknown` (a person decides). */
  readonly unknownOutcome: number;
  /** `sending` LINE pushes put back to `scheduled`: the retry key makes a repeat safe. */
  readonly retriedPush: number;
  /** Rows failed because they used `DELIVERY_MAX_ATTEMPTS` or outlived the LINE retry key (N-2). */
  readonly retryLimited: number;
  /** `scheduled` rows more than the grace period late: a new trigger was written. */
  readonly retriggered: string[];
  readonly staleReplyTokens: number;
  readonly events: DomainResult<null>['events'];
}

export interface SweepOptions {
  readonly batch?: number;
  /** The billing month of a quota counter (`line.quotaPeriod`); default: Bangkok time. */
  readonly quotaPeriodOf?: (date: Date) => string;
}

/** A `scheduled` delivery this long past its time without a claim has lost its trigger. */
export const OVERDUE_GRACE_SECONDS = 120;
/** LINE accepts a reply token for about a minute; after this nobody can use it. */
export const REPLY_TOKEN_KEEP_SECONDS = 600;

/**
 * Housekeeping (ADR-010 section 7), run every 30 s by the worker:
 *  - `sending` past its lease: back to `scheduled` if the provider was never called; otherwise
 *    `failed(outcome_unknown)`, except a LINE push, which a retry key makes safe to repeat;
 *  - a repeat is bounded (N-2): after `DELIVERY_MAX_ATTEMPTS` claims, or once the retry key may have
 *    been forgotten by LINE (`retryKeyMaxAgeSeconds`), the row is `failed` instead (`outcome_unknown`
 *    when a push was ever attempted). A push that goes back gives its quota reservation back (the
 *    next attempt reserves again); a push that fails keeps it, as LINE may have counted the message;
 *  - `scheduled` more than two minutes late: a fresh trigger (the earlier one may be dead-lettered);
 *  - reply tokens older than ten minutes are blanked.
 */
export async function sweepDeliveries(
  tx: DbTransaction,
  ctx: DomainContext,
  options: SweepOptions = {},
): Promise<SweepResult> {
  const fx = new Effects();
  // The lease was stamped by whichever worker claimed the row; the database clock judges it, so a
  // sweeper (or a worker) whose own clock is minutes off cannot fail a live send (review O-7).
  const now = await authorityNow(tx, ctx);
  const batch = options.batch ?? 50;
  const periodOf = options.quotaPeriodOf ?? billingPeriod;
  const keyMaxAge = ctx.config.retryKeyMaxAgeSeconds ?? DELIVERY_RETRY_KEY_MAX_AGE_SECONDS;
  let released = 0;
  let unknownOutcome = 0;
  let retriedPush = 0;
  let retryLimited = 0;

  const stuck = await tx
    .select()
    .from(schema.outboundDelivery)
    .where(
      and(
        eq(schema.outboundDelivery.state, 'sending'),
        lt(schema.outboundDelivery.leaseUntil, now),
      ),
    )
    .orderBy(asc(schema.outboundDelivery.leaseUntil))
    .limit(batch)
    .for('update', { skipLocked: true });
  for (const delivery of stuck) {
    const neverSent = delivery.dispatchedAt === null;
    const pinnedPush = delivery.route === 'line_push';
    const exhausted = delivery.attempts >= DELIVERY_MAX_ATTEMPTS;
    const keyExpired = pinnedPush && retryKeyExpired(delivery.createdAt, now, keyMaxAge);
    if ((neverSent || pinnedPush) && !exhausted && !keyExpired) {
      const nextAttemptAt = now;
      await tx
        .update(schema.outboundDelivery)
        .set({
          state: 'scheduled',
          nextAttemptAt,
          claimToken: null,
          leaseUntil: null,
          dispatchedAt: null,
          updatedAt: now,
        })
        .where(eq(schema.outboundDelivery.id, delivery.id));
      await enqueueJob(tx, ctx.config, {
        queue: QUEUE_NAMES.outbound,
        name: OUTBOUND_JOBS.dispatch,
        jobId: dispatchJobId(delivery.id, delivery.attempts),
        payload: { deliveryId: delivery.id },
        notBefore: nextAttemptAt,
        options: OUTBOUND_DISPATCH_JOB_OPTIONS,
      });
      if (neverSent) {
        released += 1;
      } else {
        // The attempt that was lost reserved a push; the next one reserves its own.
        await moveQuota(
          tx,
          delivery.channelAccountId,
          periodOf(delivery.dispatchedAt ?? now),
          -1,
          now,
        );
        retriedPush += 1;
      }
    } else {
      // A pinned push may have reached the customer even if the lost attempt never got to dispatch
      // (an earlier attempt's outcome was unknown), so it is unknown whenever it was ever a push.
      const outcomeUnknown = !neverSent || pinnedPush;
      const errorCode = keyExpired
        ? 'retry_key_expired'
        : exhausted
          ? 'retry_exhausted'
          : 'lease_expired';
      await tx
        .update(schema.outboundDelivery)
        .set({ state: 'failed', errorCode, outcomeUnknown, leaseUntil: null, updatedAt: now })
        .where(eq(schema.outboundDelivery.id, delivery.id));
      await finishFailed(tx, ctx, fx, delivery, errorCode, outcomeUnknown, errorCode);
      if (outcomeUnknown) unknownOutcome += 1;
      if (errorCode !== 'lease_expired') retryLimited += 1;
    }
  }

  const overdue = await tx
    .select({
      id: schema.outboundDelivery.id,
      nextAttemptAt: schema.outboundDelivery.nextAttemptAt,
    })
    .from(schema.outboundDelivery)
    .where(
      and(
        eq(schema.outboundDelivery.state, 'scheduled'),
        lt(
          schema.outboundDelivery.nextAttemptAt,
          new Date(now.getTime() - OVERDUE_GRACE_SECONDS * 1000),
        ),
      ),
    )
    .orderBy(asc(schema.outboundDelivery.nextAttemptAt))
    .limit(batch);
  const bucket = Math.floor(now.getTime() / (OVERDUE_GRACE_SECONDS * 1000));
  for (const { id, nextAttemptAt } of overdue) {
    await enqueueJob(tx, ctx.config, {
      queue: QUEUE_NAMES.outbound,
      name: OUTBOUND_JOBS.dispatch,
      // One re-trigger per delivery per two minutes, however often the sweeper runs.
      jobId: `delivery-${id}-sweep-${String(bucket)}`,
      payload: { deliveryId: id },
      // Never ahead of the delivery's own time, whichever clock judged it overdue (review O-7).
      notBefore: nextAttemptAt,
      options: OUTBOUND_DISPATCH_JOB_OPTIONS,
    });
  }

  const staleReplyTokens = await clearStaleReplyTokens(
    tx,
    new Date(now.getTime() - REPLY_TOKEN_KEEP_SECONDS * 1000),
  );
  return {
    released,
    unknownOutcome,
    retriedPush,
    retryLimited,
    retriggered: overdue.map((row) => row.id),
    staleReplyTokens,
    events: fx.events,
  };
}

/** Failed deliveries of one account since `since`: the input of the "3 failures in 15 minutes" alert. */
export async function countRecentFailures(
  db: ReadExecutor,
  channelAccountId: string,
  since: Date,
): Promise<number> {
  const rows = await db
    .select({ id: schema.outboundDelivery.id })
    .from(schema.outboundDelivery)
    .where(
      and(
        eq(schema.outboundDelivery.channelAccountId, channelAccountId),
        eq(schema.outboundDelivery.state, 'failed'),
        gte(schema.outboundDelivery.updatedAt, since),
      ),
    );
  return rows.length;
}
