import { schema } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  TICKET_EVENT_TYPES,
  TICKET_REFERENCE_LINK_KINDS,
  type CreateTicketReference,
} from '@watchtower/shared';
import { and, eq, inArray } from 'drizzle-orm';

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

export interface ReleaseDevOwnerInput extends DevOwnerInput {
  /**
   * The caller may let go of anyone's pick-up (a lead or a head freeing a ticket from a developer who is
   * away). The caller decides from the permission; without it only the owner can.
   */
  readonly anyOwner?: boolean | undefined;
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

/** The dev owner lets the ticket go. Only the owner can, unless the caller may free any ticket (`anyOwner`). */
export async function releaseTicketAsDev(
  tx: DbTransaction,
  ctx: DomainContext,
  input: ReleaseDevOwnerInput,
): Promise<DomainResult<TicketRow>> {
  const fx = new Effects();
  const userId = actorUserId(ctx);
  const before = await lockOpenTicket(tx, ctx, input.ref);
  if (before.devOwnerId === null) return fx.result(before);
  if (before.devOwnerId !== userId && input.anyOwner !== true) {
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
    previousDevOwnerId: before.devOwnerId,
  });
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.ticketDevRelease,
    targetType: 'ticket',
    targetId: after.id,
    metadata: { devOwnerId: before.devOwnerId, releasedBy: userId },
  });
  fx.emit(ticketEvent(ctx, 'ticket.updated', after, ['devOwner']));
  return fx.result(after);
}

export interface AddTicketReferenceInput extends DevOwnerInput {
  readonly reference: CreateTicketReference;
}

/**
 * Links the ticket to an incident or a deploy that already exists (a `ticket_link` row of kind `incident` or
 * `deploy`). A dev cannot create either; the link is a reference and changes nothing on the incident.
 * Linking twice is not an error.
 */
export async function addTicketReference(
  tx: DbTransaction,
  ctx: DomainContext,
  input: AddTicketReferenceInput,
): Promise<DomainResult<{ ticket: TicketRow; linkId: string; created: boolean }>> {
  const fx = new Effects();
  const userId = actorUserId(ctx);
  const ticket = await lockOpenTicket(tx, ctx, input.ref);
  const { kind, targetId } = input.reference;
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
      kind,
      fromTicketId: ticket.id,
      toTicketId: null,
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
          eq(schema.ticketLink.fromTicketId, ticket.id),
          kind === 'incident'
            ? eq(schema.ticketLink.incidentId, targetId)
            : eq(schema.ticketLink.deployId, targetId),
        ),
      )
      .limit(1);
    if (!existing) throw new Error('ticket link vanished');
    return fx.result({ ticket, linkId: existing.id, created: false });
  }
  await recordTicketEvent(tx, ticket.id, TICKET_EVENT_TYPES.referenceAdded, ctx.actor, 'internal', {
    kind,
    targetId,
  });
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.ticketReferenceAdd,
    targetType: 'ticket',
    targetId: ticket.id,
    metadata: { kind, linkTargetId: targetId },
  });
  fx.emit(ticketEvent(ctx, 'ticket.updated', ticket, ['references']));
  return fx.result({ ticket, linkId: created.id, created: true });
}

export interface RemoveTicketReferenceInput extends DevOwnerInput {
  readonly linkId: string;
}

export async function removeTicketReference(
  tx: DbTransaction,
  ctx: DomainContext,
  input: RemoveTicketReferenceInput,
): Promise<DomainResult<TicketRow>> {
  const fx = new Effects();
  actorUserId(ctx);
  const ticket = await lockOpenTicket(tx, ctx, input.ref);
  // Only the two reference kinds: a link between two tickets is removed by its own route.
  const [removed] = await tx
    .delete(schema.ticketLink)
    .where(
      and(
        eq(schema.ticketLink.id, input.linkId),
        eq(schema.ticketLink.fromTicketId, ticket.id),
        inArray(schema.ticketLink.kind, [...TICKET_REFERENCE_LINK_KINDS]),
      ),
    )
    .returning();
  if (!removed) throw notFound('No such link on this ticket');
  const targetId = removed.incidentId ?? removed.deployId;
  await recordTicketEvent(
    tx,
    ticket.id,
    TICKET_EVENT_TYPES.referenceRemoved,
    ctx.actor,
    'internal',
    {
      kind: removed.kind,
      targetId,
    },
  );
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.ticketReferenceRemove,
    targetType: 'ticket',
    targetId: ticket.id,
    metadata: { kind: removed.kind, linkTargetId: targetId },
  });
  fx.emit(ticketEvent(ctx, 'ticket.updated', ticket, ['references']));
  return fx.result(ticket);
}
