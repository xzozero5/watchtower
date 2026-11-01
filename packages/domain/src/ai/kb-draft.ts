import { schema, type Database } from '@watchtower/db';
import { AUDIT_ACTIONS, detectLanguage } from '@watchtower/shared';
import { and, eq, sql } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { createKbArticle, transitionKbArticle, type KbWriteResult } from '../kb/articles.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';

/**
 * The knowledge-base author's side of the domain (T-108e, AC-4, PRD section 6.2): decide whether a
 * resolved ticket is a gap, and turn the AI's text into a draft article that waits for a person.
 */

export type KbGapVerdict =
  | { readonly needed: true }
  | {
      readonly needed: false;
      readonly reason: 'not_resolved' | 'cited_kb' | 'already_drafted' | 'no_answer';
    };

/**
 * A resolved ticket is a gap when nothing it used was a knowledge-base article: no AI draft that a
 * person approved or edited cited one. It also needs an answer to learn from (a public reply from
 * staff), is skipped when it was reopened since the job was queued, and is done once per ticket
 * (an article already points at the ticket as its source).
 */
export async function ticketKbGap(
  db: Pick<Database['db'], 'select'>,
  ticketId: string,
): Promise<KbGapVerdict> {
  const [ticket] = await db
    .select({ status: schema.ticket.status })
    .from(schema.ticket)
    .where(eq(schema.ticket.id, ticketId))
    .limit(1);
  if (ticket === undefined || (ticket.status !== 'resolved' && ticket.status !== 'closed')) {
    return { needed: false, reason: 'not_resolved' };
  }

  const [cited] = await db
    .select({ id: schema.aiDraft.id })
    .from(schema.aiDraft)
    .where(
      and(
        eq(schema.aiDraft.ticketId, ticketId),
        sql`${schema.aiDraft.disposition} IN ('approved', 'edited')`,
        sql`jsonb_path_exists(${schema.aiDraft.citations}, '$[*] ? (@.kind == "kb")')`,
      ),
    )
    .limit(1);
  if (cited !== undefined) return { needed: false, reason: 'cited_kb' };

  const [existing] = await db
    .select({ id: schema.kbArticle.id })
    .from(schema.kbArticle)
    .where(
      sql`${schema.kbArticle.sources} @> ${JSON.stringify([{ type: 'ticket', ref: ticketId }])}::jsonb`,
    )
    .limit(1);
  if (existing !== undefined) return { needed: false, reason: 'already_drafted' };

  const [answer] = await db
    .select({ id: schema.message.id })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.ticketId, ticketId),
        eq(schema.message.direction, 'outbound'),
        eq(schema.message.visibility, 'public'),
      ),
    )
    .limit(1);
  if (answer === undefined) return { needed: false, reason: 'no_answer' };
  return { needed: true };
}

export interface AiKbDraftInput {
  readonly ticketId: string;
  readonly title: string;
  readonly bodyMd: string;
  readonly intentTags: readonly string[];
  readonly kind: 'article' | 'runbook';
}

/**
 * Creates the article as `internal` and moves it to `in_review`. The version is marked
 * `authored_by_machine` and carries `requested_by` (`ctx.onBehalfOf`): publishing needs a person who
 * did not write it and did not ask for it, and break-glass cannot put it live (po decision 27).
 * Run it with an `ai` actor. Nothing is searchable or visible to a customer until a person publishes.
 */
export async function createAiKbDraft(
  tx: DbTransaction,
  ctx: DomainContext,
  input: AiKbDraftInput,
): Promise<DomainResult<KbWriteResult>> {
  const fx = new Effects();
  const created = await createKbArticle(tx, ctx, {
    slug: `ai-draft-${input.ticketId.slice(0, 8)}-${input.ticketId.slice(-4)}`,
    title: input.title,
    bodyMd: input.bodyMd,
    kind: input.kind,
    lang: detectLanguage(input.bodyMd),
    visibility: 'internal',
    orgIds: [],
    intentTags: [...input.intentTags],
    sources: [{ type: 'ticket', ref: input.ticketId }],
    changeNote: 'Drafted by the AI from a resolved ticket that cited no article',
  });
  fx.events.push(...created.events);
  const moved = await transitionKbArticle(tx, ctx, {
    articleId: created.value.articleId,
    to: 'in_review',
    reason: 'AI draft from a resolved ticket',
  });
  fx.events.push(...moved.events);
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.aiKbDraft,
    targetType: 'kb_article',
    targetId: created.value.articleId,
    metadata: { ticketId: input.ticketId, requestedBy: ctx.onBehalfOf ?? null },
  });
  return fx.result(created.value);
}
