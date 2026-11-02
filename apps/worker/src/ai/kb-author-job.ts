import { authorKbDraft, type TicketTurn } from '@watchtower/ai';
import { schema, type Database } from '@watchtower/db';
import { createAiKbDraft, ticketKbGap, type Domain } from '@watchtower/domain';
import type { AiInsightReason } from '@watchtower/shared';
import { asc, eq } from 'drizzle-orm';

import type { WorkerLogger } from '../logger.js';
import { ticketPeopleNames } from './people-names.js';
import type { AiRuntime } from './runtime.js';

const MAX_MESSAGES = 60;

export interface KbAuthorDeps {
  readonly database: Database;
  readonly domain: Domain;
  readonly ai: AiRuntime | undefined;
  readonly logger: WorkerLogger;
}

export interface KbAuthorResult {
  readonly status: 'drafted' | 'skipped' | 'failed' | 'missing';
  readonly reason?: string;
  readonly articleId?: string;
}

class KbAuthorFailedError extends Error {
  constructor(reason: AiInsightReason) {
    super(`The KB author failed (${reason})`);
    this.name = 'KbAuthorFailedError';
  }
}

/**
 * AC-4, second half (T-108e): a ticket was resolved and nothing it used was a knowledge base article,
 * so the AI drafts an article and puts it `in_review`. It is created by an `ai` actor on behalf of
 * the person who resolved the ticket: the version is marked as machine-written, carries
 * `requested_by`, and cannot be published by that person or by break-glass. Only a person publishes.
 * No model call is made when there is no gap, the AI is off, or the guard says no.
 */
export async function runKbAuthor(
  deps: KbAuthorDeps,
  job: { readonly ticketId: string; readonly requestedBy: string | null },
): Promise<KbAuthorResult> {
  const db = deps.database.db;
  const [ticket] = await db
    .select({
      id: schema.ticket.id,
      subject: schema.ticket.subject,
      orgId: schema.ticket.orgId,
      intentId: schema.ticket.intentId,
      requesterContactId: schema.ticket.requesterContactId,
    })
    .from(schema.ticket)
    .where(eq(schema.ticket.id, job.ticketId))
    .limit(1);
  if (ticket === undefined) return { status: 'missing' };

  const gap = await ticketKbGap(db, ticket.id);
  if (!gap.needed) return { status: 'skipped', reason: gap.reason };
  const runtime = deps.ai;
  if (runtime === undefined) return { status: 'skipped', reason: 'provider_unavailable' };

  const [messages, contacts, intents] = await Promise.all([
    db
      .select({
        direction: schema.message.direction,
        visibility: schema.message.visibility,
        text: schema.message.bodyText,
      })
      .from(schema.message)
      .where(eq(schema.message.ticketId, ticket.id))
      .orderBy(asc(schema.message.createdAt))
      .limit(MAX_MESSAGES),
    ticketPeopleNames(db, ticket),
    db
      .select({ id: schema.intent.id, key: schema.intent.key })
      .from(schema.intent)
      .where(eq(schema.intent.isActive, true)),
  ]);
  const turns: TicketTurn[] = messages.map((message) => ({
    from:
      message.visibility === 'internal'
        ? 'note'
        : message.direction === 'inbound'
          ? 'customer'
          : 'staff',
    text: message.text,
  }));

  const agents = runtime.agentDeps(contacts);
  const outcome = await authorKbDraft(agents, {
    ticketId: ticket.id,
    subject: ticket.subject,
    turns,
    intentKey: intents.find((intent) => intent.id === ticket.intentId)?.key ?? null,
    knownIntents: intents.map((intent) => intent.key),
  });
  if (outcome.status === 'skipped') return { status: 'skipped', reason: outcome.reason };
  if (outcome.status === 'failed') throw new KbAuthorFailedError(outcome.reason);
  if (outcome.value === null) return { status: 'skipped', reason: 'nothing_to_write' };

  const draft = outcome.value;
  const ctx = deps.domain.context({
    actor: { type: 'ai', id: null },
    onBehalfOf: job.requestedBy,
  });
  const created = await db.transaction((tx) =>
    createAiKbDraft(tx, ctx, {
      ticketId: ticket.id,
      title: draft.title,
      bodyMd: draft.bodyMd,
      intentTags: draft.intentTags,
      kind: draft.kind,
    }),
  );
  return { status: 'drafted', articleId: created.value.articleId };
}
