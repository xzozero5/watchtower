import { schema } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  TICKET_EVENT_TYPES,
  type CreateTicketLink,
  type TicketLinkKind,
} from '@watchtower/shared';
import { and, eq } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { badRequest, conflict, forbidden, notFound, ticketNotOpen } from '../errors.js';
import type { TicketRow } from '../rows.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';
import { lockTicketRow, recordTicketEvent, ticketEvent } from './support.js';

/**
 * The developer's part of a ticket (T-137): picking it up for themselves and linking an incident or a
 * deploy. Nothing here touches `assignee_id`, the queue or the status: the agent stays accountable (AC-7)
 * and the SLA clock is not affected.
 */

export interface DevOwnerInput {
  /** A ticket id or key (`OPS-12`). */
  readonly ref: string;
}

function actorUserId(ctx: DomainContext): string {
  if (ctx.actor.type !== 'user' || ctx.actor.id === null) {
    throw forbidden('Only a person can pick up a ticket');
  }
  return ctx.actor.id;
}

async function lockOpenTicket(
  tx: DbTransaction,
  ctx: DomainContext,
  ref: string,
): Promise<TicketRow> {
  const ticket = await lockTicketRow(tx, ctx, ref);
  if (ticket.status === 'merged') {
    throw ticketNotOpen('This ticket was merged into another; work on that one');
  }
  return ticket;
}

/**
 * The caller becomes the dev owner. Only themselves: there is no input to name someone else. Picking up
 * what is already theirs changes nothing; a ticket another developer holds is a conflict (they let it go
 * first).
 */
export async function pickUpTicketAsDev(
  tx: DbTransaction,
  ctx: DomainContext,
  input: DevOwnerInput,
): Promise<DomainResult<TicketRow>> {
  const fx = new Effects();
  const userId = actorUserId(ctx);
  const before = await lockOpenTicket(tx, ctx, input.ref);
  if (before.devOwnerId === userId) return fx.result(before);
  if (before.devOwnerId !== null) {
    throw conflict('Another developer already picked this ticket up');
  }
  const [after] = await tx
    .update(schema.ticket)
    .set({ devOwnerId: userId, updatedAt: ctx.now() })
    .where(eq(schema.ticket.id, before.id))
    .returning();
  if (!after) throw notFound('No such ticket');
  await recordTicketEvent(tx, after.id, TICKET_EVENT_TYPES.devPickedUp, ctx.actor, 'internal', {
    devOwnerId: userId,
  });
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.ticketDevPickup,
    targetType: 'ticket',
    targetId: after.id,
    metadata: { devOwnerId: userId },
  });
  fx.emit(ticketEvent(ctx, 'ticket.updated', after, ['devOwner']));
  return fx.result(after);
}

/** The dev owner lets the ticket go. Only the owner can: nobody releases someone else's pick-up. */
export async function releaseTicketAsDev(
  tx: DbTransaction,
  ctx: DomainContext,
  input: DevOwnerInput,
): Promise<DomainResult<TicketRow>> {
  const fx = new Effects();
  const userId = actorUserId(ctx);
  const before = await lockOpenTicket(tx, ctx, input.ref);
  if (before.devOwnerId === null) return fx.result(before);
  if (before.devOwnerId !== userId) {
    throw forbidden('Only the developer who picked this ticket up can let it go');
  }
  const [after] = await tx
    .update(schema.ticket)
    .set({ devOwnerId: null, updatedAt: ctx.now() })
    .where(eq(schema.ticket.id, before.id))
    .returning();
  if (!after) throw notFound('No such ticket');
  await recordTicketEvent(tx, after.id, TICKET_EVENT_TYPES.devReleased, ctx.actor, 'internal', {
    devOwnerId: null,
  });
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.ticketDevRelease,
    targetType: 'ticket',
    targetId: after.id,
    metadata: { devOwnerId: userId },
  });
  fx.emit(ticketEvent(ctx, 'ticket.updated', after, ['devOwner']));
  return fx.result(after);
}

export interface AddTicketLinkInput extends DevOwnerInput {
  readonly link: CreateTicketLink;
}

/**
 * Links the ticket to an incident or a deploy that already exists. A dev cannot create either; the link
 * is a reference and changes nothing on the incident. Linking twice is not an error.
 */
export async function addTicketLink(
  tx: DbTransaction,
  ctx: DomainContext,
  input: AddTicketLinkInput,
): Promise<DomainResult<{ ticket: TicketRow; linkId: string; created: boolean }>> {
  const fx = new Effects();
  const userId = actorUserId(ctx);
  const ticket = await lockOpenTicket(tx, ctx, input.ref);
  const { kind, targetId } = input.link;
  if (kind === 'incident') {
    const [found] = await tx
      .select({ id: schema.incident.id })
      .from(schema.incident)
      .where(eq(schema.incident.id, targetId))
      .limit(1);
    if (!found) throw badRequest('targetId does not refer to an incident');
  } else {
    const [found] = await tx
      .select({ id: schema.deploy.id })
      .from(schema.deploy)
      .where(eq(schema.deploy.id, targetId))
      .limit(1);
    if (!found) throw badRequest('targetId does not refer to a deploy');
  }
  const [created] = await tx
    .insert(schema.ticketLink)
    .values({
      ticketId: ticket.id,
      kind,
      incidentId: kind === 'incident' ? targetId : null,
      deployId: kind === 'deploy' ? targetId : null,
      createdBy: userId,
    })
    .onConflictDoNothing()
    .returning({ id: schema.ticketLink.id });
  if (!created) {
    const [existing] = await tx
      .select({ id: schema.ticketLink.id })
      .from(schema.ticketLink)
      .where(
        and(
          eq(schema.ticketLink.ticketId, ticket.id),
          kind === 'incident'
            ? eq(schema.ticketLink.incidentId, targetId)
            : eq(schema.ticketLink.deployId, targetId),
        ),
      )
      .limit(1);
    if (!existing) throw new Error('ticket link vanished');
    return fx.result({ ticket, linkId: existing.id, created: false });
  }
  await recordTicketEvent(tx, ticket.id, TICKET_EVENT_TYPES.linkAdded, ctx.actor, 'internal', {
    kind,
    targetId,
  });
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.ticketLinkAdd,
    targetType: 'ticket',
    targetId: ticket.id,
    metadata: { kind, linkTargetId: targetId },
  });
  fx.emit(ticketEvent(ctx, 'ticket.updated', ticket, ['links']));
  return fx.result({ ticket, linkId: created.id, created: true });
}

export interface RemoveTicketLinkInput extends DevOwnerInput {
  readonly linkId: string;
}

export async function removeTicketLink(
  tx: DbTransaction,
  ctx: DomainContext,
  input: RemoveTicketLinkInput,
): Promise<DomainResult<TicketRow>> {
  const fx = new Effects();
  actorUserId(ctx);
  const ticket = await lockOpenTicket(tx, ctx, input.ref);
  const [removed] = await tx
    .delete(schema.ticketLink)
    .where(and(eq(schema.ticketLink.id, input.linkId), eq(schema.ticketLink.ticketId, ticket.id)))
    .returning();
  if (!removed) throw notFound('No such link on this ticket');
  const kind = removed.kind as TicketLinkKind;
  await recordTicketEvent(tx, ticket.id, TICKET_EVENT_TYPES.linkRemoved, ctx.actor, 'internal', {
    kind,
    targetId: removed.incidentId ?? removed.deployId,
  });
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.ticketLinkRemove,
    targetType: 'ticket',
    targetId: ticket.id,
    metadata: { kind, linkTargetId: removed.incidentId ?? removed.deployId },
  });
  fx.emit(ticketEvent(ctx, 'ticket.updated', ticket, ['links']));
  return fx.result(ticket);
}
