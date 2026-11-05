import { schema } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  TICKET_EVENT_TYPES,
  type TicketPriority,
  type UpdateTicket,
} from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { notFound, ticketNotOpen } from '../errors.js';
import { resolveIntent } from '../intents.js';
import { notifyTicketP1 } from '../notifications.js';
import type { IntentRow, TicketRow } from '../rows.js';
import { recomputeSla, resolveSlaPolicy } from '../sla.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';
import {
  lockTicketRow,
  recordTicketEvent,
  resolveQueue,
  ticketEvent,
  ticketSnapshot,
} from './support.js';

export interface UpdateTicketInput {
  /** A ticket id or key (`OPS-12`). */
  readonly ref: string;
  readonly patch: UpdateTicket;
  /** Set when the edit is a suggestion of the AI that a person accepted (T-175a): kept in the audit row, not on the ticket. */
  readonly origin?: { readonly source: string; readonly aiRunId?: string | undefined } | undefined;
}

/**
 * Edits subject, intent, queue, tags, custom fields and priority. A new priority, or a new intent
 * that brings a different SLA policy, means new targets: the dates are recomputed from the creation
 * time with the pauses that already ended applied again, so time spent waiting on the customer is
 * not counted as elapsed. A pause that is still running keeps its `slaPausedAt`: resuming shifts
 * the new dates by the whole pause. A patch that changes nothing writes nothing.
 */
export async function updateTicket(
  tx: DbTransaction,
  ctx: DomainContext,
  input: UpdateTicketInput,
): Promise<DomainResult<TicketRow>> {
  const fx = new Effects();
  const { patch } = input;
  const before = await lockTicketRow(tx, ctx, input.ref);
  if (before.status === 'merged') {
    throw ticketNotOpen('This ticket was merged into another; edit that one');
  }

  const changed: string[] = [];
  const set: Partial<typeof schema.ticket.$inferInsert> = {};
  if (patch.subject !== undefined && patch.subject !== before.subject) {
    set.subject = patch.subject;
    changed.push('subject');
  }
  let intent: IntentRow | null | undefined;
  if (patch.intentId !== undefined && patch.intentId !== before.intentId) {
    intent = patch.intentId === null ? null : await resolveIntent(tx, { intentId: patch.intentId });
    set.intentId = intent?.id ?? null;
    changed.push('intent');
  }
  if (patch.queueId !== undefined && patch.queueId !== before.queueId) {
    if (patch.queueId !== null) await resolveQueue(tx, patch.queueId);
    set.queueId = patch.queueId;
    changed.push('queue');
  }
  if (patch.tags !== undefined && JSON.stringify(patch.tags) !== JSON.stringify(before.tags)) {
    set.tags = [...patch.tags];
    changed.push('tags');
  }
  if (patch.customFields !== undefined) {
    // T-306k C-16: `customFields.portal` belongs to the portal (it holds `requesterVerified`, which the automatic
    // send trusts). A person's edit replaces the other keys but never writes, changes or removes that one.
    const next: Record<string, unknown> = { ...patch.customFields };
    delete next.portal;
    const kept = before.customFields as Record<string, unknown>;
    if ('portal' in kept) next.portal = kept.portal;
    if (JSON.stringify(next) !== JSON.stringify(before.customFields)) {
      set.customFields = next;
      changed.push('customFields');
    }
  }
  const priorityChanged = patch.priority !== undefined && patch.priority !== before.priority;
  if (priorityChanged) {
    set.priority = patch.priority;
    changed.push('priority');
  }

  const open = !['resolved', 'closed'].includes(before.status);
  let slaRecalculation: Record<string, unknown> | undefined;
  if (open && (priorityChanged || intent !== undefined)) {
    const priority = (patch.priority ?? before.priority) as TicketPriority;
    let policyId = before.slaPolicyId;
    if (intent !== undefined) {
      const [org] = await tx
        .select({ tier: schema.organization.tier, slaPolicyId: schema.organization.slaPolicyId })
        .from(schema.organization)
        .where(eq(schema.organization.id, before.orgId))
        .limit(1);
      if (org) {
        policyId =
          (await resolveSlaPolicy(tx, org, intent ? { slaPolicyId: intent.slaPolicyId } : null))
            ?.id ?? null;
      }
    }
    const policyChanged = policyId !== before.slaPolicyId;
    if (priorityChanged || policyChanged) {
      const due = await recomputeSla(tx, before, policyId, priority);
      if (policyChanged) set.slaPolicyId = policyId;
      if (before.firstRespondedAt === null) set.firstResponseDueAt = due.firstResponseDueAt;
      set.resolutionDueAt = due.resolutionDueAt;
      changed.push('sla');
      slaRecalculation = {
        reason: [...(priorityChanged ? ['priority'] : []), ...(policyChanged ? ['policy'] : [])],
        ...(priorityChanged ? { priority: { from: before.priority, to: priority } } : {}),
        ...(policyChanged ? { policyId: { from: before.slaPolicyId, to: policyId } } : {}),
        paused: before.slaPausedAt !== null,
        firstResponseDueAt: {
          from: before.firstResponseDueAt?.toISOString() ?? null,
          to: (set.firstResponseDueAt ?? before.firstResponseDueAt)?.toISOString() ?? null,
        },
        resolutionDueAt: {
          from: before.resolutionDueAt?.toISOString() ?? null,
          to: due.resolutionDueAt?.toISOString() ?? null,
        },
      };
    }
  }

  if (changed.length === 0) return fx.result(before);
  const [after] = await tx
    .update(schema.ticket)
    .set({ ...set, updatedAt: ctx.now() })
    .where(eq(schema.ticket.id, before.id))
    .returning();
  if (!after) throw notFound('No such ticket');

  await recordTicketEvent(tx, after.id, TICKET_EVENT_TYPES.updated, ctx.actor, 'internal', {
    changed,
    ...(priorityChanged ? { priority: { from: before.priority, to: after.priority } } : {}),
  });
  if (slaRecalculation) {
    await recordTicketEvent(
      tx,
      after.id,
      TICKET_EVENT_TYPES.slaRecalculated,
      ctx.actor,
      'internal',
      slaRecalculation,
    );
  }
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.ticketUpdate,
    targetType: 'ticket',
    targetId: after.id,
    before: ticketSnapshot(before),
    after: ticketSnapshot(after),
    metadata: {
      changed,
      ...(input.origin === undefined
        ? {}
        : {
            source: input.origin.source,
            ...(input.origin.aiRunId === undefined ? {} : { aiRunId: input.origin.aiRunId }),
          }),
    },
  });
  fx.emit(ticketEvent(ctx, 'ticket.updated', after, changed));
  // Raised to P1 (T-105): the queue and the leads are told, once per ticket.
  if (priorityChanged && after.priority === 'P1') await notifyTicketP1(tx, ctx, fx, after);
  return fx.result(after);
}
