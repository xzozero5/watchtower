import { schema } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  DELIVERY_CHANNELS,
  OUTBOUND_DISPATCH_JOB_OPTIONS,
  OUTBOUND_JOBS,
  QUEUE_NAMES,
  type DeliveryChannel,
} from '@watchtower/shared';
import { and, eq, ne } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { authorityNow } from '../clock.js';
import { DomainError, badRequest, conflict, notFound } from '../errors.js';
import { enqueueJob } from '../outbox.js';
import { syncInsightForDraft } from '../ai/drafts.js';
import { requireCustomerSend } from '../policy.js';
import type { AiDraftRow, MessageRow, OutboundDeliveryRow, TicketRow } from '../rows.js';
import { insertMessage, lockTicketRow, ticketEvent, ticketKeysOf } from '../tickets/support.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';
import { AUTOSEND_HOLD_SECONDS } from '../autonomy/decide.js';
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
 *  - `ai_auto` (ADR-025): a draft that is still waiting, a pre-send grade of exactly this text, and the gate's
 *    twelve conditions (it loads the facts itself). The draft becomes `auto_approved` (the database checks
 *    the grade again), the message has no author, and the send waits `AUTOSEND_HOLD_SECONDS` so a person
 *    can step in. Only Gmail and the portal.
 */

export type ScheduleOrigin = 'human' | 'ai_approved' | 'system_template' | 'ai_auto';

export interface ScheduleSendInput {
  /** The ticket row, locked by the caller. */
  readonly ticket: TicketRow;
  /** An outbound public message with `delivery_status = 'scheduled'` on that ticket. */
  readonly message: MessageRow;
  readonly origin: ScheduleOrigin;
  /** `ai_approved` and `ai_auto`: the draft being sent. */
  readonly aiDraftId?: string | undefined;
  /** `ai_auto`: the pre-send grade of exactly this text. */
  readonly aiGradeId?: string | undefined;
  /** `system_template`: the key the body was rendered from. */
  readonly templateKey?: string | undefined;
  /**
   * Send through this account instead of the ticket's own channel. For a ticket filed by hand (phone,
   * walk-in...) that has no channel account: the confirmation email goes out through the Gmail account
   * (T-136). The message must already belong to that account.
   */
  readonly via?: { readonly accountId: string; readonly channel: DeliveryChannel } | undefined;
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

/**
 * The draft an automatic send is about: on this ticket and still waiting. The text it sends is the draft plus
 * the notice, so no hash of the draft is compared here: the gate compares the hash of the grade with the text.
 */
async function lockDraftForAuto(
  tx: DbTransaction,
  ticket: TicketRow,
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
  return draft;
}

/**
 * T-122f (N-1): a person's own reply cannot be the text of an AI draft nobody sent. That text would go out
 * as `human` and skip the policy gate that judges `ai_approved`; the person sends the draft as the draft,
 * or edits it first and the edit is theirs. (The database refuses it too.)
 */
async function refuseUnsentAiDraftText(
  tx: DbTransaction,
  ticket: TicketRow,
  message: MessageRow,
): Promise<void> {
  const [same] = await tx
    .select({ id: schema.aiDraft.id })
    .from(schema.aiDraft)
    .where(
      and(
        eq(schema.aiDraft.ticketId, ticket.id),
        eq(schema.aiDraft.contentHash, contentHash(message.bodyText)),
        ne(schema.aiDraft.status, 'sent'),
      ),
    )
    .limit(1);
  if (same !== undefined) {
    throw denied(
      'ai_draft_text_as_human',
      'This is the text of an AI draft; send the draft itself, or change the text first',
    );
  }
}

function gateRequest(ctx: DomainContext, input: ScheduleSendInput) {
  const { message } = input;
  return {
    autoSend:
      input.origin === 'ai_auto' && input.aiDraftId !== undefined && input.aiGradeId !== undefined
        ? {
            aiDraftId: input.aiDraftId,
            aiGradeId: input.aiGradeId,
            text: message.bodyText,
            attachmentCount: Array.isArray(message.attachments) ? message.attachments.length : 0,
            hasHtml: message.bodyHtml !== null,
          }
        : undefined,
    ticketId: input.ticket.id,
    channel: input.via?.channel ?? input.ticket.channel,
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
  const viaChannel: string = input.via?.channel ?? ticket.channel;
  // The portal shows a message at once for a person's reply; an automatic one is held like the others, so it
  // goes through a delivery too (migration 0106 lets the table carry it).
  if (!isDeliveryChannel(viaChannel) && !(origin === 'ai_auto' && viaChannel === 'portal')) {
    throw badRequest(`The ${ticket.channel} channel has no outbound dispatcher`);
  }
  const channel = viaChannel;
  const accountId = input.via?.accountId ?? ticket.channelAccountId;
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
  } else if (origin === 'ai_auto') {
    if (input.aiDraftId === undefined || input.aiGradeId === undefined) {
      throw denied('approval_missing', 'An automatic send names its draft and its grade');
    }
    draft = await lockDraftForAuto(tx, ticket, input.aiDraftId);
  } else if (input.aiDraftId !== undefined) {
    throw badRequest('aiDraftId is only for an AI draft sent by a person');
  }
  if (origin !== 'ai_auto' && input.aiGradeId !== undefined) {
    throw badRequest('aiGradeId is only for an automatic send');
  }
  if (origin === 'human') await refuseUnsentAiDraftText(tx, ticket, message);
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

  // The hold is stamped by the clock the worker's claim and the cancel also read (review O-7).
  const now = await authorityNow(tx, ctx);
  if (draft !== undefined && origin === 'ai_auto') {
    // The database asks again: a fresh passing independent grade, a stage 3 intent, both switches off.
    const auto = await tx
      .update(schema.aiDraft)
      .set({ status: 'auto_approved', autoApprovedAt: now })
      .where(and(eq(schema.aiDraft.id, draft.id), eq(schema.aiDraft.status, 'draft')))
      .returning({ id: schema.aiDraft.id });
    if (auto.length === 0) throw conflict('This AI draft was just used');
    await syncInsightForDraft(tx, draft.id, 'classified');
  } else if (draft !== undefined) {
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
    await syncInsightForDraft(tx, draft.id, 'classified');
  }

  // A reply written by a person waits so it can be undone; an automatic acknowledgment does not.
  const holdSeconds =
    origin === 'system_template'
      ? 0
      : origin === 'ai_auto'
        ? AUTOSEND_HOLD_SECONDS
        : await readUndoSendSeconds(tx);
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
      aiGradeId: origin === 'ai_auto' ? (input.aiGradeId ?? null) : null,
      contentHash: hash,
      approvedBy: draft === undefined || origin === 'ai_auto' ? null : ctx.actor.id,
      holdSeconds,
      nextAttemptAt,
      createdBy: origin === 'system_template' || origin === 'ai_auto' ? null : ctx.actor.id,
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
      aiGradeId: delivery.aiGradeId,
      approvedBy: delivery.approvedBy,
      holdSeconds,
    },
  });
  if (origin === 'ai_auto') {
    await recordAuditInTx(tx, ctx, fx, {
      action: AUDIT_ACTIONS.autonomyAutosendScheduled,
      targetType: 'outbound_delivery',
      targetId: delivery.id,
      metadata: {
        ticketId: ticket.id,
        intentId: ticket.intentId,
        aiDraftId: draft?.id ?? null,
        aiGradeId: delivery.aiGradeId,
        channel,
        holdSeconds,
      },
    });
  }
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
  await syncInsightForDraft(tx, draft.id, 'classified');
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
  /** Send through this account rather than the ticket's channel (see `ScheduleSendInput.via`). */
  readonly via?: { readonly accountId: string; readonly channel: DeliveryChannel } | undefined;
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
      channelAccountId: input.via?.accountId ?? ticket.channelAccountId,
      direction: 'outbound',
      bodyText: body,
      visibility: 'public',
      deliveryStatus: 'scheduled',
    },
    { updatedAt: now },
  );
  const scheduled = await scheduleCustomerSend(tx, ctx, {
    ticket,
    message,
    origin: 'system_template',
    templateKey: input.templateKey,
    via: input.via,
  });
  return {
    value: { delivery: scheduled.value.delivery, message },
    events: scheduled.events,
    audited: scheduled.audited,
  };
}

export interface AutoSendInput {
  /** A ticket id or key. */
  readonly ref: string;
  readonly aiDraftId: string;
  /** The pre-send grade of exactly `text`. */
  readonly aiGradeId: string;
  /** The text to send: the draft plus the notice that it is automatic. */
  readonly text: string;
}

/** Statuses where an automatic reply still makes sense: the customer is waiting for an answer. */
const AUTO_SEND_OPEN_STATUSES = ['new', 'triage', 'open', 'waiting_on_customer'] as const;

/**
 * An automatic reply (ADR-025): saves the text as the ticket's outbound message (no author, no HTML, no
 * file) and schedules it as `ai_auto`. Everything is judged by `scheduleCustomerSend` and the gate; a denial
 * is a `DomainError('policy_denied')` and the transaction the caller opened is rolled back. Run it as
 * `{ type: 'ai', id: null }`.
 */
export async function scheduleAutoSend(
  tx: DbTransaction,
  ctx: DomainContext,
  input: AutoSendInput,
): Promise<DomainResult<ScheduledSend & { message: MessageRow }>> {
  if (ctx.actor.type !== 'ai') {
    throw denied('actor_origin_mismatch', 'Only the AI actor sends an automatic reply');
  }
  const ticket = await lockTicketRow(tx, ctx, input.ref);
  if (!(AUTO_SEND_OPEN_STATUSES as readonly string[]).includes(ticket.status)) {
    throw denied('ticket_not_open', 'The ticket is no longer waiting for an answer');
  }
  const now = ctx.now();
  const { message } = await insertMessage(
    tx,
    {
      ticketId: ticket.id,
      channelAccountId: ticket.channelAccountId,
      direction: 'outbound',
      bodyText: input.text,
      visibility: 'public',
      deliveryStatus: 'scheduled',
    },
    { updatedAt: now },
  );
  const scheduled = await scheduleCustomerSend(tx, ctx, {
    ticket,
    message,
    origin: 'ai_auto',
    aiDraftId: input.aiDraftId,
    aiGradeId: input.aiGradeId,
  });
  return {
    value: { delivery: scheduled.value.delivery, message },
    events: scheduled.events,
    audited: scheduled.audited,
  };
}
