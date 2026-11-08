import { Inject, Injectable } from '@nestjs/common';
import { schema, withReadOnlyConnections, type Database } from '@watchtower/db';
import {
  evaluateBudget,
  factsFingerprint,
  readAiUsage,
  readSwitchState,
  resolveAiCaps,
} from '@watchtower/domain';
import {
  INSIGHTS_BUILDER_CONCURRENCY,
  INSIGHTS_FACTS_CACHE_SECONDS,
  INSIGHTS_REQUESTS_PER_MINUTE,
  INSIGHT_ELEMENTS,
  insightStateLabel,
  insightStoredClaimsSchema,
  isInsightElementKey,
  selectInsightState,
  type Claim,
  type InsightElementKey,
  type InsightFactsResult,
  type InsightItem,
  type InsightLocale,
  type InsightState,
  type InsightStoredClaim,
  type InsightsQuery,
  type InsightsResponse,
} from '@watchtower/shared';
import { and, eq, gte, sql } from 'drizzle-orm';

import { AiStatusService } from '../ai/ai-status.service.js';
import { AuditService } from '../audit/audit.service.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import type { Principal } from '../auth/principal.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';
import { InsightAccess, insightRuleAllows } from './insight-access.js';
import { builderFor } from './insight-builders.js';
import {
  factViews,
  refsOf,
  restoreNarration,
  templateClaims,
  type ResolvedRef,
} from './insight-claims.js';
import { dirtyKey, InsightMarks, userDirtyKey } from './insight-marks.js';
import { resolveRefs } from './insight-refs.js';
import { periodFor, scopeKeyFor } from './insight-scope.js';
import { SingleFlightCache } from './single-flight.js';

/** What the request knows of the caller's connection, for the audit row of a read of personal data. */
export interface InsightRequestMeta {
  readonly ip: string | null;
  readonly requestId: string | null;
}

interface Candidate {
  readonly key: InsightElementKey;
  /** The element whose facts and stored narration this one uses (`home.team` is `shift.overview`). */
  readonly source: InsightElementKey;
  readonly scopeKey: string;
  readonly period: string;
}

interface StoredNarration {
  readonly id?: string | undefined;
  readonly claims: unknown;
  readonly fingerprint: string;
  readonly generatedAt: Date;
  readonly expiresAt: Date;
  readonly mock: boolean;
}

interface Standing {
  readonly paused: boolean;
  readonly budgetOpen: boolean;
}

/** Runs `work` over `items` with at most `limit` running at once; the results keep the order of `items`. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await work(item);
    }
  });
  await Promise.all(lanes);
  return results;
}

/**
 * `GET /v1/insights` (T-416, ADR-029 section 9.3). For each element asked for: the viewer satisfies its rule (the
 * evaluator of the GET route) and the scope resolver and the period spec; facts are computed live by the T-415
 * builders inside the read-only scope; the sentences of mode F are templates in the viewer's language; the stored
 * narration (written earlier by the worker) is attached when the state allows it, with placeholders and links
 * restored under the viewer's rights. Reading never calls a model and never creates an `ai_run`: the only writes are
 * the viewed and dirty marks in Redis, and the `pii.read` audit row when the facts name people.
 */
@Injectable()
export class InsightsService {
  private readonly facts = new SingleFlightCache<InsightFactsResult>(
    INSIGHTS_FACTS_CACHE_SECONDS * 1000,
  );

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(InsightAccess) private readonly access: InsightAccess,
    @Inject(InsightMarks) private readonly marks: InsightMarks,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AiStatusService) private readonly aiStatus: AiStatusService,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  /** How many times the facts were really computed (single-flight and the 30 s cache keep it low); for tests. */
  get computations(): number {
    return this.facts.computations;
  }

  async read(
    principal: Principal,
    query: InsightsQuery,
    meta: InsightRequestMeta,
  ): Promise<InsightsResponse> {
    await this.limiter.enforce('insights', principal.userId, INSIGHTS_REQUESTS_PER_MINUTE, 60);
    const locale: InsightLocale = query.locale ?? 'en';
    const now = new Date();

    const candidates = await this.candidates(principal, query, now);
    if (candidates.length === 0) return { items: [] };

    const view = principal.permissions.has('ticket.read') ? 'full' : 'masked';
    const built = await mapLimit(candidates, INSIGHTS_BUILDER_CONCURRENCY, async (candidate) => {
      try {
        return await this.buildFacts(principal, candidate, view);
      } catch (error) {
        // One card failing must not take the others (or the screen) with it; it is simply not shown.
        this.logger.warn({ err: error, element: candidate.key }, 'insight facts failed');
        return null;
      }
    });
    const ready = candidates.flatMap((candidate, index) => {
      const result = built[index];
      return result === null || result === undefined ? [] : [{ candidate, result }];
    });
    if (ready.length === 0) return { items: [] };

    const needsStanding = ready.some(
      ({ candidate }) =>
        INSIGHT_ELEMENTS[candidate.key].mode === 'N' ||
        (candidate.key === 'home.my_work' && this.config.INSIGHT_PERSON_NARRATION_ENABLED),
    );
    const standing: Standing = needsStanding
      ? await this.standing()
      : { paused: false, budgetOpen: true };

    const stored = await Promise.all(
      ready.map(({ candidate }) => this.storedNarration(principal, candidate, locale)),
    );
    const feedbackPausedList = await Promise.all(
      ready.map(({ candidate }) => this.isFeedbackPaused(candidate)),
    );
    const storedClaims = stored.map((row) => {
      const parsed = insightStoredClaimsSchema.safeParse(row?.claims);
      return parsed.success ? parsed.data : [];
    });

    const refs = ready.flatMap(({ result }, index) =>
      refsOf(result.facts, storedClaims[index] ?? []),
    );
    const resolved = await resolveRefs(this.database, principal, refs, locale);

    const items: InsightItem[] = [];
    const piiKinds = new Map<string, InsightElementKey[]>();
    for (const [index, { candidate, result }] of ready.entries()) {
      const element = INSIGHT_ELEMENTS[candidate.key];
      const row = stored[index] ?? null;
      const elementFeedbackPaused = feedbackPausedList[index] ?? false;
      const item = this.compose({
        candidate,
        facts: result,
        row,
        storedClaims: storedClaims[index] ?? [],
        locale,
        resolved,
        masked: view === 'masked',
        standing,
        elementFeedbackPaused,
        now,
      });
      items.push(item.item);
      const allowPersonNarration =
        this.config.INSIGHT_PERSON_NARRATION_ENABLED || element.personRefs === 'none';
      if (
        allowPersonNarration &&
        (element.mode === 'N' ||
          (candidate.key === 'home.my_work' && this.config.INSIGHT_PERSON_NARRATION_ENABLED))
      ) {
        await this.leaveMarks(principal, candidate, locale, item.state);
      }
      if (element.piiKind !== undefined && result.facts.some((fact) => fact.ref?.kind === 'user')) {
        piiKinds.set(element.piiKind, [...(piiKinds.get(element.piiKind) ?? []), candidate.key]);
      }
    }

    for (const [kind, elements] of piiKinds) {
      await this.audit.recordPiiRead({
        actor: { type: 'user', id: principal.userId },
        targetType: kind,
        ip: meta.ip,
        requestId: meta.requestId,
        metadata: { via: 'insights', elements },
      });
    }
    return { items };
  }

  // --- which elements are served ------------------------------------------------------------------------

  /**
   * The elements the viewer may read, in the order asked: rule, scope kind, period spec, a builder, then the scope
   * resolver. Anything else is left out, silently and in the same way (no data, no right and not built look alike).
   */
  private async candidates(
    principal: Principal,
    query: InsightsQuery,
    now: Date,
  ): Promise<Candidate[]> {
    const out: Candidate[] = [];
    for (const key of query.elements) {
      if (!isInsightElementKey(key)) continue;
      const element = INSIGHT_ELEMENTS[key];
      if (element.mode === 'X' || !insightRuleAllows(principal, element)) continue;
      const scopeKey = scopeKeyFor(element, query.scope);
      const period = periodFor(element, query.period, now);
      const source = element.aliasOf ?? key;
      if (scopeKey === null || period === null || builderFor(source) === undefined) continue;
      if (!(await this.access.canReadScope(principal, scopeKey))) continue;
      out.push({ key, source, scopeKey, period });
    }
    return out;
  }

  // --- facts ---------------------------------------------------------------------------------------------

  private buildFacts(
    principal: Principal,
    candidate: Candidate,
    view: 'full' | 'masked',
  ): Promise<InsightFactsResult> {
    const element = INSIGHT_ELEMENTS[candidate.source];
    const builder = builderFor(candidate.source);
    if (builder === undefined) return Promise.reject(new Error('no builder'));
    // A person's own facts are not shared with anybody else.
    const owner = element.scope === 'user' ? principal.userId : '';
    const key = [candidate.source, candidate.scopeKey, candidate.period, view, owner].join('|');
    return this.facts.get(key, () =>
      withReadOnlyConnections(() =>
        builder({
          executor: this.database.db,
          view,
          period: candidate.period,
          subjectUserId: principal.userId,
          scopeKey: candidate.scopeKey,
          orgScope: principal.orgScope,
        }),
      ),
    );
  }

  // --- narration -----------------------------------------------------------------------------------------

  private async storedNarration(
    principal: Principal,
    candidate: Candidate,
    locale: InsightLocale,
  ): Promise<StoredNarration | null> {
    const element = INSIGHT_ELEMENTS[candidate.key];
    if (element.mode !== 'N' && candidate.key !== 'home.my_work') return null;
    if (!this.config.INSIGHT_PERSON_NARRATION_ENABLED && element.personRefs !== 'none') {
      return null;
    }
    if (element.scope === 'user') {
      // `home.my_work`: the viewer's own row of `ai_summary`; nobody else's is ever read.
      const [row] = await withReadOnlyConnections(() =>
        this.database.db
          .select()
          .from(schema.aiSummary)
          .where(
            and(
              eq(schema.aiSummary.kind, 'my_work'),
              eq(schema.aiSummary.userId, principal.userId),
              eq(schema.aiSummary.locale, locale),
            ),
          )
          .limit(1),
      );
      if (row === undefined) return null;
      return {
        claims: row.claims,
        fingerprint: row.fingerprint,
        generatedAt: row.generatedAt,
        expiresAt: new Date(
          row.generatedAt.getTime() + this.config.INSIGHT_NARRATION_TTL_HOURS * 3_600_000,
        ),
        mock: row.mock,
      };
    }
    const [row] = await withReadOnlyConnections(() =>
      this.database.db
        .select()
        .from(schema.aiElementInsight)
        .where(
          and(
            eq(schema.aiElementInsight.element, candidate.source),
            eq(schema.aiElementInsight.scopeKey, candidate.scopeKey),
            eq(schema.aiElementInsight.period, candidate.period),
            eq(schema.aiElementInsight.locale, locale),
          ),
        )
        .limit(1),
    );
    return row === undefined
      ? null
      : {
          id: row.id,
          claims: row.claims,
          fingerprint: row.factsFingerprint,
          generatedAt: row.generatedAt,
          expiresAt: row.expiresAt,
          mock: row.mock,
        };
  }

  /** AC-J21 (R-1): 7-day negative feedback check querying assistant_feedback directly on updatedAt. */
  private async isFeedbackPaused(candidate: Candidate): Promise<boolean> {
    if (candidate.key === 'home.my_work') return false;
    const [stats] = await withReadOnlyConnections(() =>
      this.database.db
        .select({
          total: sql<number>`count(*)::int`,
          down: sql<number>`count(*) filter (where ${schema.assistantFeedback.rating} = 'down')::int`,
        })
        .from(schema.assistantFeedback)
        .where(
          and(
            eq(schema.assistantFeedback.targetKind, 'insight'),
            eq(schema.assistantFeedback.element, candidate.source),
            gte(schema.assistantFeedback.updatedAt, sql`clock_timestamp() - interval '7 days'`),
          ),
        ),
    );
    const total = stats?.total ?? 0;
    const down = stats?.down ?? 0;
    return total >= 20 && down / total > 0.5;
  }

  /**
   * 2-Layer Insight Narrator Budget Gate (R-2, ADR-029 section 9.4):
   * Layer 1 (App-wide): total app usage must not reach daily cap or stop level, and < INSIGHT_STOP_AT_DAILY_PERCENT.
   * Layer 2 (Narrator-specific): insight_narrator agent usage today <= 30% of caps and INSIGHT_DAILY_TOKENS.
   */
  private async standing(): Promise<Standing> {
    const db = this.database.db;
    const switches = await readSwitchState(db);
    const offline =
      this.config.AI_PROVIDER !== 'mock' && (await this.aiStatus.status()).status === 'offline';
    const caps = resolveAiCaps(this.config);
    const now = new Date();
    const startOfDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );

    // Layer 1: App-wide daily cap (INSIGHT_STOP_AT_DAILY_PERCENT, default 60%)
    const appUsage = await readAiUsage(db, now);
    const appPercent = this.config.INSIGHT_STOP_AT_DAILY_PERCENT / 100;
    const appCapTokens = Math.floor(caps.dailyTokens * appPercent);
    const appCapCostUsd = caps.dailyCostUsd * appPercent;
    const appBudgetOpen =
      evaluateBudget(caps, appUsage).level !== 'stop' &&
      appUsage.tokens < appCapTokens &&
      appUsage.costUsd < appCapCostUsd;

    // Layer 2: agent-specific cap (<= 30% of caps and INSIGHT_DAILY_TOKENS)
    const [narratorDaily] = await db
      .select({
        tokens: sql<number>`coalesce(sum(${schema.aiRun.inputTokens} + ${schema.aiRun.outputTokens}), 0)::int`,
        cost: sql<string | null>`coalesce(sum(${schema.aiRun.costUsd}), 0)::numeric(10, 4)`,
      })
      .from(schema.aiRun)
      .where(
        and(eq(schema.aiRun.agent, 'insight_narrator'), gte(schema.aiRun.createdAt, startOfDay)),
      );

    const narratorTokens = narratorDaily?.tokens ?? 0;
    const narratorCostUsd = Number(narratorDaily?.cost ?? 0);
    const narratorCapTokens = Math.min(
      this.config.INSIGHT_DAILY_TOKENS,
      Math.floor(caps.dailyTokens * 0.3),
    );
    const narratorCapCostUsd = caps.dailyCostUsd * 0.3;
    const narratorBudgetOpen =
      narratorTokens < narratorCapTokens && narratorCostUsd < narratorCapCostUsd;

    const budgetOpen = appBudgetOpen && narratorBudgetOpen;
    return { paused: switches.killSwitch || offline, budgetOpen };
  }

  // --- one item --------------------------------------------------------------------------------------------

  private compose(input: {
    readonly candidate: Candidate;
    readonly facts: InsightFactsResult;
    readonly row: StoredNarration | null;
    readonly storedClaims: readonly InsightStoredClaim[];
    readonly locale: InsightLocale;
    readonly resolved: ReadonlyMap<string, ResolvedRef>;
    readonly masked: boolean;
    readonly standing: Standing;
    readonly elementFeedbackPaused: boolean;
    readonly now: Date;
  }): { readonly item: InsightItem; readonly state: InsightState } {
    const { candidate, facts, row, locale, resolved, now } = input;
    const element = INSIGHT_ELEMENTS[candidate.key];
    const source = INSIGHT_ELEMENTS[candidate.source];
    const fingerprintMatches =
      row !== null && row.fingerprint === factsFingerprint(facts.facts, source.materiality);

    let narrationClaims: Claim[] = [];
    if (row !== null) {
      narrationClaims = restoreNarration(row.claims, {
        facts: facts.facts,
        locale,
        resolved,
        masked: input.masked,
      });
    }
    // A developer whose stored claims all named a customer or a number the masked facts lack reads the facts only.
    const maskedNoClaims = input.masked && row !== null && narrationClaims.length === 0;

    const allowPersonNarration =
      this.config.INSIGHT_PERSON_NARRATION_ENABLED || element.personRefs === 'none';
    let effectiveMode = element.mode;
    if (!allowPersonNarration) {
      effectiveMode = 'F';
    } else if (candidate.key === 'home.my_work' && row !== null) {
      effectiveMode = 'N';
    }
    const paused = input.standing.paused || input.elementFeedbackPaused;
    const state = selectInsightState({
      mode: effectiveMode,
      maskedNoClaims,
      paused,
      narration: row === null ? null : { expiresAt: row.expiresAt, fingerprintMatches },
      budgetOpen: input.standing.budgetOpen,
      now,
    });
    const shown = (state === 'fresh' || state === 'stale') && row !== null;
    const generatedAt = shown ? row.generatedAt : null;
    return {
      state,
      item: {
        element: candidate.key,
        scope: candidate.scopeKey,
        period: candidate.period,
        mode: effectiveMode,
        state,
        stateLabel: insightStateLabel(state, locale, generatedAt ?? undefined, now),
        asOf: facts.asOf,
        facts: factViews(facts.facts, locale, resolved),
        claims: templateClaims(candidate.source, facts.facts, locale, resolved),
        narration:
          shown && narrationClaims.length > 0
            ? {
                claims: narrationClaims,
                generatedAt: row.generatedAt.toISOString(),
                mock: row.mock,
                ...(row.id === undefined ? {} : { id: row.id }),
              }
            : null,
      },
    };
  }

  // --- marks -----------------------------------------------------------------------------------------------

  /** Viewed always; dirty only when there is something for the worker to do (no usable narration, or it is stale). */
  private async leaveMarks(
    principal: Principal,
    candidate: Candidate,
    locale: InsightLocale,
    state: InsightState,
  ): Promise<void> {
    const element = INSIGHT_ELEMENTS[candidate.key];
    try {
      const viewScope = element.scope === 'user' ? `user:${principal.userId}` : candidate.scopeKey;
      await this.marks.markViewed(
        principal.userId,
        locale,
        candidate.source,
        viewScope,
        candidate.period,
      );
      if (state === 'none' || state === 'stale') {
        await this.marks.markDirty(
          element.scope === 'user'
            ? userDirtyKey(principal.userId, candidate.key)
            : dirtyKey(candidate.source, candidate.scopeKey, candidate.period),
        );
      }
    } catch (error) {
      // The marks only tell the worker where to look; a Redis hiccup must not hide the card.
      this.logger.warn({ err: error, element: candidate.key }, 'insight marks failed');
    }
  }
}
