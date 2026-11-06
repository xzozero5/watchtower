import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import { ASSISTANT_LIMITS } from '@watchtower/shared';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Principal } from '../auth/principal.js';
import { DATABASE } from '../database/database.module.js';
import { AuditService } from '../audit/audit.service.js';
import { ContextResolver } from './context-resolver.js';
import { toolsFor } from './assistant-access.js';
import { inReadOnlyScope } from './read-only.js';
import {
  assistantContextSchema,
  assistantEntitySchema,
  type AssistantEntity,
} from '@watchtower/shared';
import { PII_KINDS } from './assistant-access.js';

/** A source read without a visible chip still needs the same pre-reply personal-data audit. */
export function trackAssistantPiiRead(
  ref: { kind: string; id: string },
  tickets: Map<string, string>,
  others: Map<string, { readonly kind: string; readonly id: string }>,
): void {
  if (ref.kind === 'ticket') tickets.set(ref.id, tickets.get(ref.id) ?? '');
  else if (ref.kind === 'handoff' || PII_KINDS.some((kind) => kind === ref.kind))
    others.set(`${ref.kind}:${ref.id}`, ref);
}

/** Extract every stable ref; re-resolution and dictionary reads happen under the current principal. */
export function conversationRefs(
  rows: readonly { context: unknown; evidence: readonly { kind: string; id: string }[] }[],
): AssistantEntity[] {
  const wanted = new Map<string, AssistantEntity>();
  const add = (candidate: unknown): void => {
    const ref = assistantEntitySchema.safeParse(candidate);
    if (ref.success) wanted.set(`${ref.data.kind}:${ref.data.ref}`, ref.data);
  };
  for (const row of rows) {
    // `readRefs` is server-only storage, intentionally absent from the public request schema.
    const stored =
      typeof row.context === 'object' && row.context !== null && 'readRefs' in row.context
        ? row.context.readRefs
        : undefined;
    if (Array.isArray(stored)) for (const ref of stored) add(ref);
    const context = assistantContextSchema.safeParse(row.context);
    if (context.success) {
      add(context.data.entity);
      if (context.data.ticket !== undefined) add({ kind: 'ticket', ref: context.data.ticket });
      for (const ref of context.data.selection?.refs ?? [])
        add({ kind: context.data.selection?.kind, ref });
    }
    for (const evidence of row.evidence)
      add({ kind: evidence.kind === 'kb' ? 'kb_article' : evidence.kind, ref: evidence.id });
  }
  return [...wanted.values()];
}

/** Private provenance only: never spread request context into this snapshot. */
const authorizationSchema = z.strictObject({
  version: z.literal(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  refs: z.array(assistantEntitySchema).max(400),
  tools: z.array(z.string().min(1).max(64)).max(40),
});
export type AssistantAuthorization = z.infer<typeof authorizationSchema>;

export function authorizationFingerprint(principal: Principal): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        userId: principal.userId,
        role: principal.role,
        permissions: [...principal.permissions].sort(),
        orgId: principal.orgId,
        orgScope:
          principal.orgScope.kind === 'all'
            ? { kind: 'all' }
            : { kind: 'org', orgId: principal.orgScope.orgId },
      }),
    )
    .digest('hex');
}

export function makeAssistantAuthorization(
  principal: Principal,
  refs: readonly AssistantEntity[],
  tools: readonly string[],
): AssistantAuthorization | null {
  const parsed = authorizationSchema.safeParse({
    version: 1,
    fingerprint: authorizationFingerprint(principal),
    refs: [...new Map(refs.map((ref) => [`${ref.kind}:${ref.ref}`, ref])).values()],
    tools: [...new Set(tools)].sort(),
  });
  return parsed.success ? parsed.data : null;
}

export function storedAuthorization(context: unknown): unknown {
  return typeof context === 'object' && context !== null && 'authorization' in context
    ? context.authorization
    : undefined;
}

@Injectable()
export class AssistantHistoryAuthorization {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(ContextResolver) private readonly contexts: Pick<ContextResolver, 'resolve'>,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Missing, malformed, revoked or unreadable provenance cannot authorize old business content. */
  async authorize(principal: Principal, value: unknown): Promise<AssistantAuthorization | null> {
    const parsed = authorizationSchema.safeParse(value);
    if (!parsed.success || parsed.data.fingerprint !== authorizationFingerprint(principal))
      return null;
    const allowed = new Set<string>(toolsFor(principal));
    if (parsed.data.tools.some((tool) => !allowed.has(tool))) return null;
    try {
      for (const entity of parsed.data.refs) {
        const resolved = await inReadOnlyScope(() => this.contexts.resolve({ entity }, principal));
        if (resolved.refs.length !== 1 || resolved.dropped.length !== 0) return null;
        const ref = resolved.refs[0];
        if (ref === undefined) return null;
        if (
          ref.kind === 'ticket' ||
          ref.kind === 'handoff' ||
          PII_KINDS.some((kind) => kind === ref.kind)
        ) {
          await this.audit.recordPiiRead({
            actor: { type: 'user', id: principal.userId },
            targetType: ref.kind === 'conversation' ? 'inbound_message' : ref.kind,
            targetId: ref.id,
            metadata: { via: 'assistant', purpose: 'reauthorization' },
          });
        }
      }
      return parsed.data;
    } catch {
      return null;
    }
  }

  async history(
    principal: Principal,
    conversationId: string,
  ): Promise<{
    turns: { role: 'user' | 'assistant'; text: string }[];
    refs: AssistantEntity[];
    tools: string[];
  }> {
    const table = schema.assistantMessage;
    const rows = await this.database.db
      .select({ role: table.role, text: table.body, context: table.context })
      .from(table)
      .where(and(eq(table.conversationId, conversationId), eq(table.userId, principal.userId)))
      .orderBy(desc(table.createdAt))
      .limit(ASSISTANT_LIMITS.historyTurns);
    const result: {
      turns: { role: 'user' | 'assistant'; text: string }[];
      refs: AssistantEntity[];
      tools: string[];
    } = { turns: [], refs: [], tools: [] };
    for (const row of rows.reverse()) {
      const authorization = await this.authorize(principal, storedAuthorization(row.context));
      if (authorization === null) continue;
      result.turns.push({ role: row.role, text: row.text });
      result.refs.push(...authorization.refs);
      result.tools.push(...authorization.tools);
    }
    return result;
  }
}
