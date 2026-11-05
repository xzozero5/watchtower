import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  INSIGHT_ELEMENTS,
  isInsightElementKey,
  type AssistantEntityKind,
  type AssistantFeedback,
  type AssistantFeedbackRequest,
} from '@watchtower/shared';
import { and, eq } from 'drizzle-orm';

import { AuditScope } from '../audit/audit-scope.js';
import { notFound } from '../auth/http-errors.js';
import { evaluatePermissionRule, type PermissionRule } from '../auth/permission-check.js';
import type { Principal } from '../auth/principal.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { DATABASE } from '../database/database.module.js';
import { ContextResolver } from './context-resolver.js';

/** Ratings one person may send in an hour. `[ASSUMED]` generous: a person rates what they read, nothing more. */
const FEEDBACK_PER_HOUR = 120;

/** The scope keys of `ai_element_insight` that name a thing with an owner, and the chip kind that reads it. */
const SCOPE_KINDS: Readonly<Record<string, AssistantEntityKind>> = {
  org: 'org',
  intent: 'intent',
  incident: 'incident',
  service: 'service',
};

/**
 * Thumbs-up and thumbs-down on an answer of the assistant or on an embedded insight (ADR-029 sections 5 and 9.6).
 * What the person may rate is what they may see, and a target they may not see is a 404, the same as one that does not
 * exist, so the endpoint cannot be used to find out which insights exist (T-400 C-18): an `ai_element_insight` row is
 * rated only when the person passes the permission rule of its element (the evaluator of the GET route) and, for a
 * scoped element, the reader of the scope's own module accepts them. One row per person and target; pressing again
 * replaces the earlier rating.
 */
@Injectable()
export class AssistantFeedbackService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(ContextResolver) private readonly contexts: ContextResolver,
  ) {}

  async rate(principal: Principal, input: AssistantFeedbackRequest): Promise<AssistantFeedback> {
    await this.limiter.enforce('assistant-feedback', principal.userId, FEEDBACK_PER_HOUR, 3600);
    const element =
      input.target.kind === 'message'
        ? await this.checkMessage(principal, input.target.id)
        : await this.checkInsight(principal, input.target.id);

    const { assistantFeedback: table } = schema;
    const now = new Date();
    const [row] = await this.database.db
      .insert(table)
      .values({
        userId: principal.userId,
        targetKind: input.target.kind,
        targetId: input.target.id,
        element,
        rating: input.rating,
        reason: input.reason ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [table.userId, table.targetKind, table.targetId],
        set: { rating: input.rating, reason: input.reason ?? null, updatedAt: now, element },
      })
      .returning();
    if (row === undefined) throw new Error('feedback not stored');
    AuditScope.set({
      targetType: input.target.kind === 'message' ? 'assistant_message' : 'ai_element_insight',
      targetId: input.target.id,
      // A rating and a code: no text, and for an insight only its element key.
      metadata: {
        targetKind: input.target.kind,
        rating: input.rating,
        reason: input.reason ?? null,
        element,
      },
    });
    return {
      id: row.id,
      target: input.target,
      rating: input.rating,
      reason: input.reason ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** An answer of the assistant to this person. */
  private async checkMessage(principal: Principal, id: string): Promise<null> {
    const { assistantMessage: table } = schema;
    const [found] = await this.database.db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, id), eq(table.userId, principal.userId), eq(table.role, 'assistant')))
      .limit(1);
    if (found === undefined) throw notFound('No such answer');
    return null;
  }

  /** Section 9.3: the person must be able to see the element and its scope. Returns the element key. */
  private async checkInsight(principal: Principal, id: string): Promise<string> {
    const { aiElementInsight: table } = schema;
    const [row] = await this.database.db
      .select({ element: table.element, scopeKey: table.scopeKey })
      .from(table)
      .where(eq(table.id, id))
      .limit(1);
    if (row === undefined || !isInsightElementKey(row.element)) throw notFound('No such insight');
    const definition = INSIGHT_ELEMENTS[row.element];
    // An element with no rule is not shown to anyone (mode X): nobody has anything to rate.
    if (definition.rule === null) throw notFound('No such insight');
    const rule: PermissionRule = definition.rule;
    if (!evaluatePermissionRule(principal, rule)) throw notFound('No such insight');
    if (!(await this.mayReadScope(principal, row.scopeKey))) throw notFound('No such insight');
    return row.element;
  }

  /**
   * `instance` is for everyone who passes the rule. `org:<id>`, `intent:<id>`, `incident:<id>` and `service:<id>` are
   * read with the reader of that module under the person's own access (the chip resolver); a kind with no reader
   * yet (`service`) is refused, never allowed (fail closed). Anything else is not a scope the person was shown.
   */
  private async mayReadScope(principal: Principal, scopeKey: string): Promise<boolean> {
    if (scopeKey === 'instance') return true;
    const [head, ...rest] = scopeKey.split(':');
    const kind = head === undefined ? undefined : SCOPE_KINDS[head];
    if (kind === undefined || rest.length !== 1 || rest[0] === undefined) return false;
    const resolved = await this.contexts.resolve({ entity: { kind, ref: rest[0] } }, principal);
    return resolved.entity !== null;
  }
}
