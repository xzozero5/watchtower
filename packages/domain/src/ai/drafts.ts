import { schema, type Database } from '@watchtower/db';
import { AUDIT_ACTIONS, editDistance, type RejectAiDraft } from '@watchtower/shared';
import { and, eq, sql } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { DomainError, conflict, notFound } from '../errors.js';
import { lockTicketRow, ticketEvent } from '../tickets/support.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';

/**
 * AI drafts (T-108c, PRD section 6.5 step 1): what the drafter wrote, and what a person did with it.
 * Approving goes through the outbound path (`schedule.ts`, bound to the text by hash and to the
 * approver, T-122d); this file holds the other two outcomes (edited and sent, rejected) and the
 * write of a new draft. Nothing here sends anything (N3).
 */

export interface NewAiDraft {
  readonly ticketId: string;
  readonly body: string;
  readonly aiRunId: string | null;
  readonly language: string;
  readonly customerLanguage: string;
  /** Which evidence supports which sentence; `kind` is the evidence kind, so a later check can ask "did it cite a KB article". */
  readonly citations: readonly {
    readonly evidenceId: string;
    readonly sentence: number;
    readonly kind?: string;
  }[];
  readonly uncitedClaims: number;
  readonly promptId: string;
  readonly promptVersion: number;
  readonly disclosureLevel: 'verified' | 'restricted';
  readonly disclosureRemoved: number;
  readonly needsReview: boolean;
  readonly requestedBy: string | null;
}

/**
 * Saves a new draft and retires the one that was waiting (at most one draft waits for a person per
 * ticket, kept by this function under a lock on the ticket). A draft that is already approved (its send is in the undo
 * window) is left alone.
 */
export async function saveAiDraft(
  db: Pick<Database['db'], 'transaction'>,
  input: NewAiDraft,
): Promise<{ id: string; superseded: number }> {
  return db.transaction(async (tx) => {
    // One writer per ticket: two jobs cannot both leave a draft waiting.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.ticketId}, 1))`);
    const old = await tx
      .update(schema.aiDraft)
      .set({ status: 'superseded' })
      .where(and(eq(schema.aiDraft.ticketId, input.ticketId), eq(schema.aiDraft.status, 'draft')))
      .returning({ id: schema.aiDraft.id });
    const [created] = await tx
      .insert(schema.aiDraft)
      .values({
        ticketId: input.ticketId,
        bodyText: input.body,
        aiRunId: input.aiRunId,
        language: input.language,
        customerLanguage: input.customerLanguage,
        citations: [...input.citations],
        uncitedClaims: input.uncitedClaims,
        promptId: input.promptId,
        promptVersion: input.promptVersion,
        disclosureLevel: input.disclosureLevel,
        disclosureRemoved: input.disclosureRemoved,
        needsReview: input.needsReview,
        requestedBy: input.requestedBy,
      })
      .returning({ id: schema.aiDraft.id });
    if (created === undefined) throw new Error('ai_draft insert returned no row');
    return { id: created.id, superseded: old.length };
  });
}

/**
 * Keeps the ticket's AI brief in step with its draft when the outbound path moves it: `classified`
 * once a person approved it (nothing waits any more), `draft_ready` again when the send is undone or
 * did not happen. Only touches a brief that still points at this draft.
 */
export async function syncInsightForDraft(
  tx: Pick<DbTransaction, 'update'>,
  draftId: string,
  state: 'classified' | 'draft_ready',
): Promise<void> {
  await tx
    .update(schema.aiTicketInsight)
    .set({
      state,
      ...(state === 'draft_ready'
        ? { nextStepKind: 'approve_draft', nextStepLabel: 'Review the draft reply' }
        : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(schema.aiTicketInsight.draftId, draftId));
}

export interface RejectAiDraftInput {
  /** A ticket id or key. */
  readonly ref: string;
  readonly draftId: string;
  readonly rejection: RejectAiDraft;
}

/**
 * A person discards an AI draft with one of the nine reason codes (UI spec section 6.3). The reason
 * is data for the learning loop, not a free text the model sees: the comment is stored for staff.
 * The brief goes back to "write it yourself" so the ticket does not keep pointing at a dead draft.
 */
export async function rejectAiDraft(
  tx: DbTransaction,
  ctx: DomainContext,
  input: RejectAiDraftInput,
): Promise<DomainResult<{ draftId: string }>> {
  const fx = new Effects();
  const actorId = ctx.actor.id;
  if (ctx.actor.type !== 'user' || actorId === null) {
    throw new DomainError('policy_denied', 'Only a person can reject an AI draft', {
      reason: 'ai_draft_reviewer_not_human',
    });
  }
  const ticket = await lockTicketRow(tx, ctx, input.ref);
  const [draft] = await tx
    .select()
    .from(schema.aiDraft)
    .where(eq(schema.aiDraft.id, input.draftId))
    .for('update');
  if (draft?.ticketId !== ticket.id) throw notFound('No such AI draft on this ticket');
  if (draft.status !== 'draft') {
    throw conflict('This AI draft was already approved, sent, rejected or replaced');
  }
  const now = ctx.now();
  const comment = input.rejection.comment?.trim() ?? '';
  await tx
    .update(schema.aiDraft)
    .set({
      status: 'rejected',
      disposition: 'rejected',
      rejectReason: input.rejection.reason,
      rejectComment: comment === '' ? null : comment,
      resolvedBy: actorId,
      resolvedAt: now,
    })
    .where(eq(schema.aiDraft.id, draft.id));
  await tx
    .update(schema.aiTicketInsight)
    .set({
      draftId: null,
      state: 'needs_human',
      reasonCode: null,
      nextStepKind: 'reply',
      nextStepLabel: 'Write the reply yourself',
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(schema.aiTicketInsight.ticketId, ticket.id),
        eq(schema.aiTicketInsight.draftId, draft.id),
      ),
    );
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.aiDraftReject,
    targetType: 'ticket',
    targetId: ticket.id,
    metadata: { aiDraftId: draft.id, reason: input.rejection.reason, hasComment: comment !== '' },
  });
  fx.emit(ticketEvent(ctx, 'ticket.updated', ticket, ['ai']));
  return fx.result({ draftId: draft.id });
}

export interface EditedDraftInput {
  readonly ticketId: string;
  readonly messageId: string;
  readonly bodyText: string;
  readonly draftId: string;
}

/**
 * A person started from an AI draft, changed it and sent their own text (UI spec section 6.3,
 * "Edit"). The reply goes out as the person's own (origin `human`); this records the draft as
 * `edited` with the distance between the two texts, which is what the stage-2 gate measures
 * ("at most 20% edit", PRD section 6.4). Called inside the reply's transaction.
 */
export async function recordDraftEdited(
  tx: DbTransaction,
  ctx: DomainContext,
  fx: Effects,
  input: EditedDraftInput,
): Promise<void> {
  const actorId = ctx.actor.id;
  if (ctx.actor.type !== 'user' || actorId === null) {
    throw new DomainError('policy_denied', 'Only a person can send an edited AI draft', {
      reason: 'ai_draft_reviewer_not_human',
    });
  }
  const [draft] = await tx
    .select()
    .from(schema.aiDraft)
    .where(eq(schema.aiDraft.id, input.draftId))
    .for('update');
  if (draft?.ticketId !== input.ticketId) throw notFound('No such AI draft on this ticket');
  if (draft.status !== 'draft') {
    throw conflict('This AI draft was already approved, sent, rejected or replaced');
  }
  const distance = editDistance(draft.bodyText, input.bodyText);
  const now = ctx.now();
  await tx
    .update(schema.aiDraft)
    .set({
      status: 'sent',
      approvedBy: actorId,
      approvedAt: now,
      disposition: 'edited',
      editDistance: distance,
      resolvedBy: actorId,
      resolvedAt: now,
      finalMessageId: input.messageId,
    })
    .where(eq(schema.aiDraft.id, draft.id));
  await tx
    .update(schema.aiTicketInsight)
    .set({ draftId: null, state: 'classified', updatedAt: sql`now()` })
    .where(
      and(
        eq(schema.aiTicketInsight.ticketId, input.ticketId),
        eq(schema.aiTicketInsight.draftId, draft.id),
      ),
    );
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.aiDraftEdited,
    targetType: 'ticket',
    targetId: input.ticketId,
    metadata: { aiDraftId: draft.id, messageId: input.messageId, editDistance: distance },
  });
}
