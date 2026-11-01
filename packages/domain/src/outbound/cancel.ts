import { schema } from '@watchtower/db';
import { AUDIT_ACTIONS, OUTBOUND_TICKET_EVENTS } from '@watchtower/shared';
import { and, eq, gt } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { conflict, forbidden, notFound } from '../errors.js';
import type { OutboundDeliveryRow } from '../rows.js';
import { recordTicketEvent, ticketEvent, ticketIdOf } from '../tickets/support.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';

export interface CancelSendInput {
  /** The ticket id or key from the URL; the delivery must belong to it. */
  readonly ref: string;
  readonly deliveryId: string;
  /** A lead or the head may undo a colleague's send; anyone else only their own. The api decides from the role. */
  readonly canCancelAny: boolean;
}

/**
 * Undo send (ADR-010 section 4, UI spec 17 Q1). Works only while the delivery is still `scheduled`
 * and the hold has not ended: one compare-and-set UPDATE, so it cannot race with the dispatcher's
 * claim (whichever commits first wins; the loser sees 0 rows). After the window the answer is a 409
 * and the message goes out. Asking again for a delivery that is already cancelled succeeds.
 *
 * The status a reply set (for example `waiting_on_customer`) stays; only the message is undone
 * `[ASSUMED]`, `po` confirms. An AI draft that was approved by this send returns to `draft`, so the
 * person can edit and send it again.
 */
export async function cancelSend(
  tx: DbTransaction,
  ctx: DomainContext,
  input: CancelSendInput,
): Promise<DomainResult<OutboundDeliveryRow>> {
  const fx = new Effects();
  const ticketId = await ticketIdOf(tx, ctx, input.ref);
  // The delivery row is locked first and the ticket is only read: the dispatcher takes them in the
  // same order when it records a result, so the two cannot deadlock.
  const [delivery] = await tx
    .select()
    .from(schema.outboundDelivery)
    .where(eq(schema.outboundDelivery.id, input.deliveryId))
    .for('update');
  if (delivery === undefined || delivery.ticketId !== ticketId) {
    throw notFound('No such delivery on this ticket');
  }
  const actorId = ctx.actor.id;
  if (!input.canCancelAny && (actorId === null || delivery.createdBy !== actorId)) {
    throw forbidden('Only the sender, a lead or the head can undo this send');
  }
  if (delivery.state === 'cancelled') return fx.result(delivery);

  const now = ctx.now();
  const [cancelled] = await tx
    .update(schema.outboundDelivery)
    .set({ state: 'cancelled', cancelledBy: actorId, cancelledAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.outboundDelivery.id, delivery.id),
        eq(schema.outboundDelivery.state, 'scheduled'),
        gt(schema.outboundDelivery.nextAttemptAt, now),
      ),
    )
    .returning();
  if (cancelled === undefined) {
    throw conflict(
      delivery.state === 'scheduled'
        ? 'The undo window has ended; the message is being sent'
        : `The message is already ${delivery.state === 'sending' ? 'being sent' : delivery.state}; it can no longer be undone`,
    );
  }

  await tx
    .update(schema.message)
    .set({ deliveryStatus: 'cancelled' })
    .where(eq(schema.message.id, delivery.messageId));
  if (delivery.aiDraftId !== null) {
    // The approval belonged to this send; the draft is waiting for a person again.
    await tx
      .update(schema.aiDraft)
      .set({ status: 'draft', approvedBy: null, approvedAt: null })
      .where(and(eq(schema.aiDraft.id, delivery.aiDraftId), eq(schema.aiDraft.status, 'approved')));
  }
  const [ticket] = await tx
    .select()
    .from(schema.ticket)
    .where(eq(schema.ticket.id, ticketId))
    .limit(1);
  if (ticket === undefined) throw notFound('No such ticket');
  await recordTicketEvent(
    tx,
    ticket.id,
    OUTBOUND_TICKET_EVENTS.messageSendCancelled,
    ctx.actor,
    'internal',
    {
      deliveryId: delivery.id,
      messageId: delivery.messageId,
    },
  );
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.outboundCancelled,
    targetType: 'outbound_delivery',
    targetId: delivery.id,
    metadata: {
      ticketId: ticket.id,
      messageId: delivery.messageId,
      channel: delivery.channel,
      origin: delivery.origin,
    },
  });
  fx.emit(ticketEvent(ctx, 'ticket.updated', ticket, ['delivery']));
  return fx.result(cancelled);
}
