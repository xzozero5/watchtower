import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  ASSISTANT_MEMORY_LIMITS,
  AUDIT_ACTIONS,
  assistantEntityKindSchema,
  type AssistantMemory,
  type AssistantMemoryList,
  type CreateAssistantMemory,
} from '@watchtower/shared';
import { and, desc, eq, gt, sql } from 'drizzle-orm';

import { AuditScope } from '../audit/audit-scope.js';
import { ApiHttpError, notFound } from '../auth/http-errors.js';
import type { Principal } from '../auth/principal.js';
import { AssistantHistoryAuthorization, storedAuthorization } from './assistant-context-history.js';
import { DATABASE } from '../database/database.module.js';

const DAY_MS = 86_400_000;

/** A reply that said nothing is stored as `[reason]` (see `AssistantService`); there is nothing in it to pin. */
const NO_ANSWER = /^\[[a-z_]+\]$/;

/**
 * Cuts to the limit without leaving half a placeholder (`[PERSON_` ...) at the end, which would read as damage
 * and could be mistaken for a token of another session.
 */
export function clipMemoryBody(text: string): string {
  const max = ASSISTANT_MEMORY_LIMITS.maxBodyChars;
  const flat = text.trim();
  if (flat.length <= max) return flat;
  return flat
    .slice(0, max)
    .replace(/\[[A-Za-z_0-9]*$/, '')
    .trimEnd();
}

const toMemory = (
  row: typeof schema.assistantMemory.$inferSelect,
  available = true,
): AssistantMemory => ({
  available,
  id: row.id,
  body: available ? row.body : '',
  refs: (available ? row.refs : [])
    .filter((ref) => assistantEntityKindSchema.safeParse(ref.kind).success)
    .map((ref) => ({
      kind: assistantEntityKindSchema.parse(ref.kind),
      id: ref.id,
    })),
  sourceMessageId: available ? row.sourceMessageId : null,
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
});

/**
 * What a person pinned for the assistant to remember (ADR-029 section 3, T-400 C-7). Created one way only: the
 * person presses "remember" on one sentence of an answer, and the server takes the text from the REDACTED text it
 * stored for that turn, never from what the screen shows and never from the request, so a name or an address that
 * the redactor took out stays out. Up to 20 per person, 90 days from the day it was made (use does not extend it).
 * Another person's rows do not exist: every lookup is by `user_id` and a miss is a 404.
 */
@Injectable()
export class AssistantMemoryService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AssistantHistoryAuthorization)
    private readonly authorization: AssistantHistoryAuthorization,
  ) {}

  async list(principal: Principal, now: Date = new Date()): Promise<AssistantMemoryList> {
    const { assistantMemory: table } = schema;
    const rows = await this.database.db
      .select()
      .from(table)
      .where(and(eq(table.userId, principal.userId), gt(table.expiresAt, now)))
      .orderBy(desc(table.createdAt))
      .limit(ASSISTANT_MEMORY_LIMITS.maxPerUser);
    const items: AssistantMemory[] = [];
    for (const row of rows)
      items.push(
        toMemory(row, (await this.authorization.authorize(principal, row.authorization)) !== null),
      );
    return { items };
  }

  async create(
    principal: Principal,
    input: CreateAssistantMemory,
    now: Date = new Date(),
  ): Promise<AssistantMemory> {
    const { assistantMessage: messages, assistantMemory: table } = schema;
    // The message must be an answer of the assistant to this person: someone else's id is no message at all.
    const [message] = await this.database.db
      .select({ body: messages.body, evidence: messages.evidence, context: messages.context })
      .from(messages)
      .where(
        and(
          eq(messages.id, input.messageId),
          eq(messages.userId, principal.userId),
          eq(messages.role, 'assistant'),
        ),
      )
      .limit(1);
    if (message === undefined) throw notFound('No such answer');
    const authorization = await this.authorization.authorize(
      principal,
      storedAuthorization(message.context),
    );
    if (authorization === null) throw notFound('No such answer');
    if (NO_ANSWER.test(message.body.trim())) {
      throw new ApiHttpError(
        HttpStatus.CONFLICT,
        'assistant_nothing_to_remember',
        'That answer has no sentence to remember',
      );
    }
    // One claim per line (the assistant stores them that way); the web sends the 0-based index it shows.
    const claim = message.body.split('\n')[input.claim];
    if (claim === undefined) throw notFound('No such sentence in that answer');
    const body = clipMemoryBody(claim);
    if (body === '') throw notFound('No such sentence in that answer');
    const refs = message.evidence
      .filter((ref) => ref.claim === input.claim)
      .slice(0, ASSISTANT_MEMORY_LIMITS.maxRefs)
      .map((ref) => ({ kind: ref.kind, id: ref.id }));

    const created = await this.database.db.transaction(async (tx) => {
      // The count and the insert are one decision: two presses at once cannot both take the last place.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`assistant_memory:${principal.userId}`}))`,
      );
      const live = and(eq(table.userId, principal.userId), gt(table.expiresAt, now));
      const [same] = await tx
        .select()
        .from(table)
        .where(and(live, eq(table.body, body)))
        .limit(1);
      // Pressing again on the same sentence changes nothing (and does not renew it).
      if (same !== undefined) {
        if ((await this.authorization.authorize(principal, same.authorization)) === null)
          throw notFound('No such memory');
        return { row: same, fresh: false };
      }
      const [held] = await tx
        .select({ n: sql<string>`count(*)` })
        .from(table)
        .where(live);
      if (Number(held?.n ?? 0) >= ASSISTANT_MEMORY_LIMITS.maxPerUser) {
        throw new ApiHttpError(
          HttpStatus.CONFLICT,
          'assistant_memory_full',
          `You can keep ${String(ASSISTANT_MEMORY_LIMITS.maxPerUser)} remembered facts; remove one first`,
        );
      }
      const [row] = await tx
        .insert(table)
        .values({
          userId: principal.userId,
          body,
          refs,
          sourceMessageId: input.messageId,
          authorization,
          createdAt: now,
          lastUsedAt: now,
          // From the day it was made: using it does not move this (T-400 C-7).
          expiresAt: new Date(now.getTime() + ASSISTANT_MEMORY_LIMITS.ttlDays * DAY_MS),
        })
        .returning();
      if (row === undefined) throw new Error('memory not stored');
      return { row, fresh: true };
    });
    AuditScope.set({
      targetType: 'assistant_memory',
      targetId: created.row.id,
      // Ids and counts only: the text of a memory never goes to the log.
      metadata: {
        messageId: input.messageId,
        claim: input.claim,
        refs: created.row.refs.length,
        chars: created.row.body.length,
        fresh: created.fresh,
      },
    });
    return toMemory(created.row);
  }

  async remove(principal: Principal, id: string): Promise<void> {
    const { assistantMemory: table } = schema;
    const gone = await this.database.db
      .delete(table)
      .where(and(eq(table.id, id), eq(table.userId, principal.userId)))
      .returning({ id: table.id });
    if (gone.length === 0) throw notFound('No such memory');
    AuditScope.set({
      action: AUDIT_ACTIONS.assistantMemoryDelete,
      targetType: 'assistant_memory',
      targetId: id,
      metadata: { count: 1 },
    });
  }

  /** All of the person's own, expired or not. */
  async clear(principal: Principal): Promise<number> {
    const { assistantMemory: table } = schema;
    const gone = await this.database.db
      .delete(table)
      .where(eq(table.userId, principal.userId))
      .returning({ id: table.id });
    AuditScope.set({
      action: AUDIT_ACTIONS.assistantMemoryDelete,
      targetType: 'assistant_memory',
      targetId: null,
      metadata: { count: gone.length, all: true },
    });
    return gone.length;
  }
}
