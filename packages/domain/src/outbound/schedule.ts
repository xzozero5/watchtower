import { schema } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  DELIVERY_CHANNELS,
  OUTBOUND_DISPATCH_JOB_OPTIONS,
  OUTBOUND_JOBS,
  QUEUE_NAMES,
  type DeliveryChannel,
} from '@watchtower/shared';
import { and, eq } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { DomainError, badRequest, conflict, notFound } from '../errors.js';
import { enqueueJob } from '../outbox.js';
import { requireCustomerSend } from '../policy.js';
import type { AiDraftRow, MessageRow, OutboundDeliveryRow, TicketRow } from '../rows.js';
import { insertMessage, lockTicketRow, ticketEvent, ticketKeysOf } from '../tickets/support.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';
import { readUndoSendSeconds } from './settings.js';
import { contentHash, dispatchJobId } from './state.js';
import { renderInputsOf, renderSystemTemplate } from './templates.js';

/**
 * Queues a message for delivery to a customer on Gmail or LINE (ADR-010 section 3). The message row
 * already exists (`delivery_status = 'scheduled'`); this binds it to an `outbound_delivery` that a
 * worker sends when the undo window ends.
 *
 * Everything that makes a send legitimate is checked here, and again by the dispatcher when it
 * claims the row (the switches may have changed during the hold):
 *  - the policy gate (N3, ADR-011) for the origin, the actor and the ticket's intent; a missing gate
 *    or a gate that throws refuses the send;
 *  - `ai_approved`: an `ai_draft` of this ticket that is still a draft, whose content hash equals
 *    the hash of the text being sent (A-2). Sending approves it: the sender is the approver;
 *  - `system_template`: the message body must be what the template key renders on the server (A-3);
 *  - `ai_auto` is refused here whatever the gate says: Phase 1 has no such path.
 */

export type ScheduleOrigin = 'human' | 'ai_approved' | 'system_template' | 'ai_auto';

export interface ScheduleSendInput {
  /** The ticket row, locked by the caller. */
  readonly ticket: TicketRow;
  /** An outbound public message with `delivery_status = 'scheduled'` on that ticket. */
  readonly message: MessageRow;
  readonly origin: ScheduleOrigin;
  /** `ai_approved`: the draft being sent. */
  readonly aiDraftId?: string | undefined;
  /** `system_template`: the key the body was rendered from. */
  readonly templateKey?: string | undefined;
}

export interface ScheduledSend {
  readonly delivery: OutboundDeliveryRow;
}

const isDeliveryChannel = (value: string): value is DeliveryChannel =>
  (DELIVERY_CHANNELS as readonly string[]).includes(value);

/** The channels whose replies go through the dispatcher; the portal is shown at once, others have no adapter. */
export function usesDispatcher(channel: string): boolean {
  return isDeliveryChannel(channel);
}

function denied(reason: string, message: string): DomainError {
  return new DomainError('policy_denied', message, { reason });
}

/**
 * The draft a reply sends, checked against the text: it exists on this ticket, is still waiting for
 * a person, and its (database-computed) hash equals the hash of the body. Locks the row.
 */
async function lockMatchingDraft(
  tx: DbTransaction,
  ticket: TicketRow,
  message: MessageRow,
  aiDraftId: string,
): Promise<AiDraftRow> {
  const [draft] = await tx
    .select()
    .from(schema.aiDraft)
    .where(eq(schema.aiDraft.id, aiDraftId))
    .for('update');
  if (draft === undefined || draft.ticketId !== ticket.id) {
    throw denied('ai_draft_not_found', 'No such AI draft on this ticket');
  }
  if (draft.status !== 'draft') {
    throw denied('ai_draft_not_pending', 'This AI draft was already approved, sent or rejected');
  }
  if (draft.contentHash !== contentHash(message.bodyText)) {
    throw denied(
      'ai_draft_content_mismatch',
      'The text being sent is not the AI draft that was approved; send your own text as a normal reply',
    );
  }
  return draft;
}

function gateRequest(ctx: DomainContext, input: ScheduleSendInput) {
  return {
    ticketId: input.ticket.id,
    channel: input.ticket.channel,
    intentId: input.ticket.intentId,
    actor: ctx.actor,
    origin: input.origin,
    templateKey: input.templateKey ?? null,
    approvedBy: input.origin === 'ai_approved' ? ctx.actor.id : null,
  } as const;
}

export async function scheduleCustomerSend(
  tx: DbTransaction,
  ctx: DomainContext,
  input: ScheduleSendInput,
): Promise<DomainResult<ScheduledSend>> {
  const fx = new Effects();
  const { ticket, message, origin } = input;

  if (message.ticketId !== ticket.id) throw notFound('No such message on this ticket');
  if (
    message.direction !== 'outbound' ||
    message.visibility !== 'public' ||
    message.deliveryStatus !== 'scheduled'
  ) {
    throw badRequest('Only a public outbound message waiting for delivery can be scheduled');
  }
  if (!isDeliveryChannel(ticket.channel)) {
    throw badRequest(`The ${ticket.channel} channel has no outbound dispatcher`);
  }
  const channel = ticket.channel;
  const accountId = ticket.channelAccountId;
  const [account] =
    accountId === null
      ? []
      : await tx
          .select({ id: schema.channelAccount.id, type: schema.channelAccount.type })
          .from(schema.channelAccount)
          .where(eq(schema.channelAccount.id, accountId))
          .limit(1);
  if (account === undefined || account.type !== channel) {
    throw badRequest(`This ticket has no ${channel} channel account to send through`);
  }

  // Origin-specific proof first: it is data we can check, and a refusal needs no gate lookups.
  let draft: AiDraftRow | undefined;
  if (origin === 'ai_approved') {
    if (input.aiDraftId === undefined) throw denied('approval_missing', 'No AI draft is named');
    draft = await lockMatchingDraft(tx, ticket, message, input.aiDraftId);
  } else if (input.aiDraftId !== undefined) {
    throw badRequest('aiDraftId is only for an AI draft sent by a person');
  }
  let templateKey: string | null = null;
  let renderInputs: Record<string, string | null> | null = null;
  if (origin === 'system_template') {
    if (input.templateKey === undefined) throw denied('template_missing', 'No template key');
    const vars = {
      ticketKey: ticketKeysOf(ctx).format(ticket.number),
      portalUrl: ctx.config.portalUrl ?? null,
      firstResponseDueAt: ticket.firstResponseDueAt,
    };
    renderInputs = renderInputsOf(vars);
    const rendered = renderSystemTemplate(input.templateKey, vars);
    if (rendered === null || rendered !== message.bodyText) {
      throw denied(
        'template_body_mismatch',
        'The body is not what this template renders; an automatic message cannot carry other text',
      );
    }
    templateKey = input.templateKey;
  } else if (input.templateKey !== undefined) {
    throw badRequest('templateKey is only for an automatic acknowledgment');
  }

  // The gate (N3). Throws a DomainError(policy_denied) on a denial, on no gate, and on a gate error.
  await requireCustomerSend(ctx, gateRequest(ctx, input));
  // Whatever a gate says, there is no stage-3 path in Phase 1 (the table refuses the origin too).
  if (origin === 'ai_auto') throw denied('ai_auto_send_disabled_phase1', 'AI auto-send is off');

  const now = ctx.now();
  if (draft !== undefined) {
    const actorId = ctx.actor.id;
    if (actorId === null) throw denied('approval_missing', 'An AI draft needs a person to send it');
    const approved = await tx
      .update(schema.aiDraft)
      .set({
        status: 'approved',
        approvedBy: actorId,
        approvedAt: now,
        disposition: 'approved',
        editDistance: 0,
        resolvedBy: actorId,
        resolvedAt: now,
      })
      .where(and(eq(schema.aiDraft.id, draft.id), eq(schema.aiDraft.status, 'draft')))
      .returning({ id: schema.aiDraft.id });
    if (approved.length === 0) throw conflict('This AI draft was just used');
  }

  // A reply written by a person waits so it can be undone; an automatic acknowledgment does not.
  const holdSeconds = origin === 'system_template' ? 0 : await readUndoSendSeconds(tx);
  const nextAttemptAt = new Date(now.getTime() + holdSeconds * 1000);
  const hash = contentHash(message.bodyText);
  // A unique index allows one active delivery per message and one per draft; a second is a conflict.
  const [delivery] = await tx
    .insert(schema.outboundDelivery)
    .values({
      ticketId: ticket.id,
      messageId: message.id,
      channelAccountId: account.id,
      channel,
      origin,
      templateKey,
      renderInputs,
      aiDraftId: draft?.id ?? null,
      contentHash: hash,
      approvedBy: draft === undefined ? null : ctx.actor.id,
      holdSeconds,
      nextAttemptAt,
      createdBy: origin === 'system_template' ? null : ctx.actor.id,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (delivery === undefined) throw conflict('This message already has a delivery in progress');

  // The outbox row is only a nudge, held back until the window ends; the delivery row decides.
  await enqueueJob(tx, ctx.config, {
    queue: QUEUE_NAMES.outbound,
    name: OUTBOUND_JOBS.dispatch,
    jobId: dispatchJobId(delivery.id, 0),
    payload: { deliveryId: delivery.id },
    notBefore: nextAttemptAt,
    options: OUTBOUND_DISPATCH_JOB_OPTIONS,
  });

  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.outboundScheduled,
    targetType: 'outbound_delivery',
    targetId: delivery.id,
    metadata: {
      ticketId: ticket.id,
      messageId: message.id,
      channel,
      origin,
      templateKey,
      aiDraftId: draft?.id ?? null,
      approvedBy: delivery.approvedBy,
      holdSeconds,
    },
  });
  fx.emit(ticketEvent(ctx, 'ticket.updated', ticket, ['delivery']));
  return fx.result({ delivery });
}

/**
 * A person sends an AI draft on a channel that shows the message at once (the portal): there is no
 * delivery to wait for, but the draft is bound to the text and to the approver exactly as above.
 */
export async function approveAiDraftSent(
  tx: DbTransaction,
  ctx: DomainContext,
  input: { ticket: TicketRow; message: MessageRow; aiDraftId: string },
): Promise<DomainResult<{ draftId: string }>> {
  const fx = new Effects();
  const { ticket, message } = input;
  const draft = await lockMatchingDraft(tx, ticket, message, input.aiDraftId);
  await requireCustomerSend(ctx, {
    ticketId: ticket.id,
    channel: ticket.channel,
    intentId: ticket.intentId,
    actor: ctx.actor,
    origin: 'ai_approved',
    approvedBy: ctx.actor.id,
  });
  const actorId = ctx.actor.id;
  if (actorId === null) throw denied('approval_missing', 'An AI draft needs a person to send it');
  const now = ctx.now();
  await tx
    .update(schema.aiDraft)
    .set({
      status: 'sent',
      approvedBy: actorId,
      approvedAt: now,
      disposition: 'approved',
      editDistance: 0,
      resolvedBy: actorId,
      resolvedAt: now,
    })
    .where(eq(schema.aiDraft.id, draft.id));
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.outboundSent,
    targetType: 'ticket',
    targetId: ticket.id,
    metadata: {
      messageId: message.id,
      channel: ticket.channel,
      origin: 'ai_approved',
      aiDraftId: draft.id,
      approvedBy: actorId,
    },
  });
  return fx.result({ draftId: draft.id });
}

export interface TemplateAckInput {
  /** A ticket id or key. */
  readonly ref: string;
  /** A key on the safe list with a renderer (`SAFE_AUTO_ACK_TEMPLATES`). */
  readonly templateKey: string;
}

/**
 * An automatic acknowledgment (AC-2): renders the text from the template key on the server, saves
 * it as the ticket's outbound message and schedules it with no hold. The caller never supplies the
 * words (A-3). Run it as `{ type: 'system', id: null }`.
 */
export async function scheduleTemplateAck(
  tx: DbTransaction,
  ctx: DomainContext,
  input: TemplateAckInput,
): Promise<DomainResult<ScheduledSend & { message: MessageRow }>> {
  const ticket = await lockTicketRow(tx, ctx, input.ref);
  const body = renderSystemTemplate(input.templateKey, {
    ticketKey: ticketKeysOf(ctx).format(ticket.number),
    portalUrl: ctx.config.portalUrl ?? null,
    firstResponseDueAt: ticket.firstResponseDueAt,
  });
  if (body === null) throw denied('template_not_allowlisted', 'No such automatic message');
  const now = ctx.now();
  const { message } = await insertMessage(
    tx,
    {
      ticketId: ticket.id,
      channelAccountId: ticket.channelAccountId,
      direction: 'outbound',
      bodyText: body,
      visibility: 'public',
      deliveryStatus: 'scheduled',
      createdAt: now,
    },
    { updatedAt: now },
  );
  const scheduled = await scheduleCustomerSend(tx, ctx, {
    ticket,
    message,
    origin: 'system_template',
    templateKey: input.templateKey,
  });
  return {
    value: { delivery: scheduled.value.delivery, message },
    events: scheduled.events,
    audited: scheduled.audited,
  };
}
