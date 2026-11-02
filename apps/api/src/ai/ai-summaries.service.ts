import { Inject, Injectable } from '@nestjs/common';
import { hashJson, summarizeClaims, type ClaimFact } from '@watchtower/ai';
import { schema, type Database } from '@watchtower/db';
import {
  claimSchema,
  type AiClaimsBlock,
  type AssistantLocale,
  type Claim,
} from '@watchtower/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { RateLimiter } from '../auth/rate-limiter.js';
import { DATABASE } from '../database/database.module.js';
import { AI_RUNTIME, type AiRuntime } from './ai-runtime.js';
import { StaffNames } from './staff-names.service.js';

export type SummaryKind = 'brief' | 'handoff';

export interface SummaryRequest {
  readonly kind: SummaryKind;
  readonly userId: string;
  readonly locale: AssistantLocale;
  /** In a few English words for the prompt. */
  readonly subject: string;
  /** Read with the viewer's own access, most urgent first. A fact the viewer may not open is not here. */
  readonly facts: readonly ClaimFact[];
  readonly dataAsOf: Date;
  readonly maxClaims: number;
}

/** After a failed attempt the same person and screen wait this long before the model is asked again. */
const RETRY_AFTER_MS = 60_000;
/** `[ASSUMED]` Model calls for summaries a person may cause in an hour, whatever the screen or language. */
export const SUMMARIES_PER_USER_PER_HOUR = 12;

/**
 * AI summaries of a screen as claims with evidence (T-135, ADR-017 section 9), cached per person, screen
 * and language against a keyed fingerprint of the facts: the same facts cost no second model call, and
 * flipping the language of the screen back and forth finds each language in the cache. A new model call
 * (the facts changed, or a language not seen yet) is limited per person and hour, so reloading the page
 * or switching language cannot make the model run without bound. Never throws and never blocks the
 * screen: with the AI off, over budget, failing, limited, or with nothing to say, the answer is `null`
 * and the screen shows what the code made.
 */
@Injectable()
export class AiSummaries {
  private readonly failedAt = new Map<string, number>();

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AI_RUNTIME) private readonly runtime: AiRuntime,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(StaffNames) private readonly staff: StaffNames,
  ) {}

  async claims(request: SummaryRequest): Promise<AiClaimsBlock | null> {
    if (request.facts.length === 0 || !this.runtime.ready) return null;
    const fingerprint = hashJson(
      request.facts.map((fact) => [fact.kind, fact.label, fact.href ?? null, fact.text]),
    );
    const db = this.database.db;
    const key = `${request.kind}:${request.userId}:${request.locale}`;
    try {
      const [cached] = await db
        .select()
        .from(schema.aiSummary)
        .where(
          and(
            eq(schema.aiSummary.kind, request.kind),
            eq(schema.aiSummary.userId, request.userId),
            eq(schema.aiSummary.locale, request.locale),
          ),
        )
        .limit(1);
      if (cached?.fingerprint === fingerprint) {
        const claims = z.array(claimSchema).safeParse(cached.claims);
        if (claims.success && claims.data.length > 0) {
          return {
            claims: claims.data,
            generatedAt: cached.generatedAt.toISOString(),
            dataAsOf: cached.dataAsOf.toISOString(),
            aiRunId: cached.aiRunId ?? '',
            mock: cached.mock,
          };
        }
      }
      const failed = this.failedAt.get(key);
      if (failed !== undefined && Date.now() - failed < RETRY_AFTER_MS) return null;
      // A call to the model from here on: count it against the person.
      const turn = await this.limiter.hit(
        'ai-summary',
        request.userId,
        SUMMARIES_PER_USER_PER_HOUR,
        3600,
      );
      if (!turn.allowed) return null;

      // The colleagues' names are part of the dictionary; without the whole list nothing is sent (N4).
      const staff = await this.staff.list();
      if (!staff.complete) return null;
      const outcome = await summarizeClaims(this.runtime.deps, {
        scope: key,
        subject: request.subject,
        locale: request.locale,
        facts: request.facts,
        maxClaims: request.maxClaims,
        names: staff.names,
      });
      if (outcome.status !== 'ok') {
        // A refusal (kill switch, budget) is not retried for a minute; a failure neither.
        this.failedAt.set(key, Date.now());
        return null;
      }
      this.failedAt.delete(key);
      if (outcome.claims.length === 0) return null;
      const generatedAt = new Date();
      await db
        .insert(schema.aiSummary)
        .values({
          kind: request.kind,
          userId: request.userId,
          locale: request.locale,
          fingerprint,
          claims: outcome.claims,
          aiRunId: outcome.runId,
          mock: outcome.mock,
          dataAsOf: request.dataAsOf,
          generatedAt,
        })
        .onConflictDoUpdate({
          target: [schema.aiSummary.kind, schema.aiSummary.userId, schema.aiSummary.locale],
          set: {
            fingerprint,
            claims: outcome.claims,
            aiRunId: outcome.runId,
            mock: outcome.mock,
            dataAsOf: request.dataAsOf,
            generatedAt,
          },
        });
      return {
        claims: outcome.claims,
        generatedAt: generatedAt.toISOString(),
        dataAsOf: request.dataAsOf.toISOString(),
        aiRunId: outcome.runId ?? '',
        mock: outcome.mock,
      };
    } catch {
      // The screen must not depend on the AI (AC-7): any trouble reads as "no summary".
      this.failedAt.set(key, Date.now());
      return null;
    }
  }
}

/** The claims joined as lines, for the screens that show one paragraph or a text box. */
export function joinClaims(claims: readonly Claim[]): string {
  return claims.map((claim) => claim.text).join('\n');
}
