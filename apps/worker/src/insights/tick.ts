import {
  ELEMENT_INSIGHT_PROMPT_ID,
  narrateElements,
  type AgentDeps,
  type InsightNarrationBatch,
  type InsightNarrationElement,
} from '@watchtower/ai';
import { schema, withReadOnlyConnections, type Database } from '@watchtower/db';
import { factsFingerprint } from '@watchtower/domain';
import {
  AUDIT_ACTIONS,
  INSIGHT_ELEMENTS,
  type InsightElement,
  type InsightLocale,
  type InsightRule,
} from '@watchtower/shared';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import type { AiRuntime } from '../ai/runtime.js';
import type { WorkerConfig } from '../config.js';
import type { WorkerLogger } from '../logger.js';
import {
  checkFeedbackGate,
  checkInsightSpecificBudget,
  checkStanding,
  checkUserAuthorizedForMyWork,
  checkUserScopedBudget,
} from './gate.js';
import { buildFactsForElement } from './facts.js';
import { clearDirty, getViewedStats, listDirtyCandidates, type DirtyCandidate } from './marks.js';

export interface TickOptions {
  readonly database: Database;
  readonly redis: Redis;
  readonly config: WorkerConfig;
  readonly logger: WorkerLogger;
  readonly ai: AiRuntime | undefined;
  /** Queue `ai` handle to check waiting count so background insights never block main AI jobs. */
  readonly aiQueue?: Pick<Queue, 'getWaitingCount'>;
  readonly now?: () => Date;
}

export interface TickResult {
  readonly processedCandidates: number;
  readonly narratedBatches: number;
  readonly generatedElements: number;
  readonly skippedReason?: string;
}

function canonicalRule(rule: InsightRule | null): string {
  if (rule === null) return 'null';
  if ('all' in rule) return `all:${[...rule.all].sort().join(',')}`;
  return `anyOf:${[...rule.anyOf].sort().join(',')}`;
}

/**
 * Runs one tick of embedded insights (T-418, ADR-029 section 9.4).
 * Idempotent, safe to repeat, uses fakeable clock.
 */
export async function runInsightTick(options: TickOptions): Promise<TickResult> {
  const { database, redis, config, logger, ai, aiQueue } = options;
  const now = options.now ? options.now() : new Date();
  const nowMs = now.getTime();

  // 1. Instance-wide gate check (kill switch and 60% daily AI cap: AC-J10, AC-J22)
  const standing = await checkStanding(database, config, now);
  if (!standing.allowed) {
    logger.info({ reason: standing.reason }, 'insight tick: standing check paused narration');
    return {
      processedCandidates: 0,
      narratedBatches: 0,
      generatedElements: 0,
      skippedReason: standing.reason,
    };
  }

  // 2. Insight-specific budget check (calls/hour, calls/day, daily tokens)
  const specificBudget = await checkInsightSpecificBudget(database, config, now);
  if (!specificBudget.allowed) {
    logger.info({ reason: specificBudget.reason }, 'insight tick: insight specific budget reached');
    return {
      processedCandidates: 0,
      narratedBatches: 0,
      generatedElements: 0,
      skippedReason: specificBudget.reason,
    };
  }

  // 3. Collect dirty marks from Redis
  const allDirty = await listDirtyCandidates(redis);
  if (allDirty.length === 0) {
    return { processedCandidates: 0, narratedBatches: 0, generatedElements: 0 };
  }

  // 4. Debounce and max-wait filter (AC-J20)
  const debounceMs = config.INSIGHT_DEBOUNCE_MINUTES * 60_000;
  const maxWaitMs = config.INSIGHT_MAX_WAIT_MINUTES * 60_000;

  const dueCandidates = allDirty.filter((candidate) => {
    const debounced = nowMs - candidate.lastAt >= debounceMs;
    const maxWaited = nowMs - candidate.firstAt >= maxWaitMs;
    return debounced || maxWaited;
  });

  if (dueCandidates.length === 0) {
    return { processedCandidates: 0, narratedBatches: 0, generatedElements: 0 };
  }

  // 5. Check active viewers in 24h and gather viewer stats (AC-J16)
  const viewedWindowHours = config.INSIGHT_VIEWED_WITHIN_HOURS;
  interface CandidateWithStats extends DirtyCandidate {
    readonly uniqueUsers: number;
    readonly locales: readonly InsightLocale[];
  }

  const viewedCandidates: CandidateWithStats[] = [];

  for (const candidate of dueCandidates) {
    const stats = await getViewedStats(
      redis,
      candidate.element,
      candidate.scopeKey,
      candidate.period,
      viewedWindowHours,
      nowMs,
    );

    if (stats.total === 0) {
      // Nobody viewed in 24h -> clear dirty mark and do 0 LLM calls (AC-J16)
      await clearDirty(redis, candidate.dirtyKey);
      continue;
    }

    viewedCandidates.push({
      ...candidate,
      uniqueUsers: stats.uniqueUsers,
      locales: stats.locales.length > 0 ? stats.locales : ['en'],
    });
  }

  if (viewedCandidates.length === 0) {
    return { processedCandidates: 0, narratedBatches: 0, generatedElements: 0 };
  }

  // 6. Sort and cap builders per tick (C-11)
  // Shared scope before user scope; higher viewer count first
  viewedCandidates.sort((a, b) => {
    if (a.isUserScoped !== b.isUserScoped) {
      return a.isUserScoped ? 1 : -1;
    }
    return b.uniqueUsers - a.uniqueUsers;
  });

  const buildersCap = config.INSIGHT_BUILDERS_PER_TICK;
  const cappedCandidates = viewedCandidates.slice(0, buildersCap);

  // 7. Facts computation & fingerprint / materiality check
  interface PreparedNarrationItem {
    readonly candidate: CandidateWithStats;
    readonly elementDef: InsightElement;
    readonly facts: Awaited<ReturnType<typeof buildFactsForElement>>;
    readonly fingerprint: string;
  }

  const prepared: PreparedNarrationItem[] = [];
  const minIntervalMs = config.INSIGHT_MIN_INTERVAL_MINUTES * 60_000;
  const ttlHours = config.INSIGHT_NARRATION_TTL_HOURS;

  for (const candidate of cappedCandidates) {
    const elementDef = INSIGHT_ELEMENTS[candidate.element];
    if (elementDef.mode === 'X') {
      await clearDirty(redis, candidate.dirtyKey);
      continue;
    }

    // Element mode F does not call LLM
    if (elementDef.mode !== 'N' && candidate.element !== 'home.my_work') {
      await clearDirty(redis, candidate.dirtyKey);
      continue;
    }

    // Person narration disabled by default until Golden §9.9 passes (DoD C-25 / ADR-029 §9.9)
    if (!config.INSIGHT_PERSON_NARRATION_ENABLED && elementDef.personRefs !== 'none') {
      await clearDirty(redis, candidate.dirtyKey);
      continue;
    }

    // Feedback gate check (AC-J21): check BEFORE building facts to avoid 2-min free compute!
    const feedback = await checkFeedbackGate(database, candidate.element, now);
    if (feedback.paused) {
      logger.warn(
        { element: candidate.element, downRate: feedback.downRate, total: feedback.total },
        'insight narration auto-paused due to >50% negative feedback (AC-J21)',
      );
      await clearDirty(redis, candidate.dirtyKey);
      continue;
    }
    if (feedback.warning) {
      logger.warn(
        { element: candidate.element, downRate: feedback.downRate, total: feedback.total },
        'insight narration >30% negative feedback warning (AC-J21)',
      );
    }

    // User scope authorization & budget check
    if (candidate.isUserScoped && candidate.subjectUserId) {
      const authorized = await checkUserAuthorizedForMyWork(database, candidate.subjectUserId, now);
      if (!authorized) {
        // Strip permissions: delete existing narration and mark
        await database.db
          .delete(schema.aiSummary)
          .where(
            and(
              eq(schema.aiSummary.kind, 'my_work'),
              eq(schema.aiSummary.userId, candidate.subjectUserId),
            ),
          );
        await clearDirty(redis, candidate.dirtyKey);
        continue;
      }

      const userBudget = await checkUserScopedBudget(
        database,
        config,
        candidate.subjectUserId,
        now,
      );
      if (!userBudget.allowed) {
        logger.info(
          { userId: candidate.subjectUserId, reason: userBudget.reason },
          'user-scoped budget blocked',
        );
        continue;
      }
    }

    // Build facts in read-only connections scope (R-3, ADR-029 section 9.4)
    const factsResult = await withReadOnlyConnections(() =>
      buildFactsForElement({
        executor: database.db,
        element: candidate.element,
        period: candidate.period,
        view: 'full',
        subjectUserId: candidate.subjectUserId,
        scopeKey: candidate.scopeKey,
      }),
    );

    const fingerprint = factsFingerprint(factsResult.facts, elementDef.materiality);

    // Check existing stored narration
    if (candidate.isUserScoped && candidate.subjectUserId) {
      const [existing] = await database.db
        .select({
          fingerprint: schema.aiSummary.fingerprint,
          generatedAt: schema.aiSummary.generatedAt,
        })
        .from(schema.aiSummary)
        .where(
          and(
            eq(schema.aiSummary.kind, 'my_work'),
            eq(schema.aiSummary.userId, candidate.subjectUserId),
          ),
        )
        .limit(1);

      if (existing) {
        if (existing.fingerprint === fingerprint) {
          // Unchanged fingerprint = 0 LLM calls! (AC-J16)
          await database.db
            .update(schema.aiSummary)
            .set({ dataAsOf: new Date(factsResult.asOf) })
            .where(
              and(
                eq(schema.aiSummary.kind, 'my_work'),
                eq(schema.aiSummary.userId, candidate.subjectUserId),
              ),
            );
          await clearDirty(redis, candidate.dirtyKey);
          continue;
        }

        const userMinIntervalMs = config.INSIGHT_USER_SCOPED_MIN_INTERVAL_MINUTES * 60_000;
        if (nowMs - new Date(existing.generatedAt).getTime() < userMinIntervalMs) {
          // Regenerated recently, wait
          continue;
        }
      }
    } else {
      const [existing] = await database.db
        .select({
          factsFingerprint: schema.aiElementInsight.factsFingerprint,
          generatedAt: schema.aiElementInsight.generatedAt,
        })
        .from(schema.aiElementInsight)
        .where(
          and(
            eq(schema.aiElementInsight.element, candidate.element),
            eq(schema.aiElementInsight.scopeKey, candidate.scopeKey),
            eq(schema.aiElementInsight.period, candidate.period),
          ),
        )
        .limit(1);

      if (existing) {
        if (existing.factsFingerprint === fingerprint) {
          // Unchanged fingerprint = 0 LLM calls! (AC-J16)
          const newExpires = new Date(nowMs + ttlHours * 3600_000);
          await database.db
            .update(schema.aiElementInsight)
            .set({ expiresAt: newExpires })
            .where(
              and(
                eq(schema.aiElementInsight.element, candidate.element),
                eq(schema.aiElementInsight.scopeKey, candidate.scopeKey),
                eq(schema.aiElementInsight.period, candidate.period),
              ),
            );
          await clearDirty(redis, candidate.dirtyKey);
          continue;
        }

        if (nowMs - new Date(existing.generatedAt).getTime() < minIntervalMs) {
          // Generated recently, keep dirty and wait for interval
          continue;
        }
      }
    }

    prepared.push({
      candidate,
      elementDef,
      facts: factsResult,
      fingerprint,
    });
  }

  if (prepared.length === 0) {
    return {
      processedCandidates: cappedCandidates.length,
      narratedBatches: 0,
      generatedElements: 0,
    };
  }

  // 8. Batch Isolation (AC-J19)
  // Group by: rule + scopeKey. Max 4 elements per batch.
  const maxBatchSize = config.INSIGHT_MAX_BATCH_ELEMENTS;
  const batchGroups = new Map<string, PreparedNarrationItem[]>();

  for (const item of prepared) {
    const groupKey = `${canonicalRule(item.elementDef.rule)}|${item.candidate.scopeKey}`;
    const list = batchGroups.get(groupKey) ?? [];
    list.push(item);
    batchGroups.set(groupKey, list);
  }

  const batches: PreparedNarrationItem[][] = [];
  for (const group of batchGroups.values()) {
    for (let i = 0; i < group.length; i += maxBatchSize) {
      batches.push(group.slice(i, i + maxBatchSize));
    }
  }

  // 9. Process batches with queue priority and slot concurrency
  let narratedBatches = 0;
  let generatedElements = 0;

  for (const batchItems of batches) {
    const firstItem = batchItems[0];
    if (!firstItem) continue;

    // Re-check standing & budget before running each batch
    const currentStanding = await checkStanding(database, config, now);
    if (!currentStanding.allowed) {
      logger.info(
        { reason: currentStanding.reason },
        'insight tick: standing paused narration before batch',
      );
      break;
    }
    const currentBudget = await checkInsightSpecificBudget(database, config, now);
    if (!currentBudget.allowed) {
      logger.info(
        { reason: currentBudget.reason },
        'insight tick: insight specific budget reached before batch',
      );
      break;
    }
    const userItem = batchItems.find(
      (item) => item.candidate.isUserScoped && item.candidate.subjectUserId,
    );
    if (userItem?.candidate.subjectUserId) {
      const userBudget = await checkUserScopedBudget(
        database,
        config,
        userItem.candidate.subjectUserId,
        now,
      );
      if (!userBudget.allowed) {
        logger.info(
          { userId: userItem.candidate.subjectUserId, reason: userBudget.reason },
          'user-scoped budget blocked before batch',
        );
        break;
      }
    }

    // Check main AI queue waiting count: background insight must yield to main AI queue!
    if (aiQueue) {
      const waiting = await aiQueue.getWaitingCount();
      if (waiting > 0) {
        logger.info(
          { waiting },
          'ai queue has waiting jobs; deferring insight narration to avoid competing',
        );
        break;
      }
    }

    // Try acquire slot from limiter (ADR-029 section 4 & 9.4)
    let releaseLimiter: (() => void) | null = null;
    if (ai?.limiter) {
      releaseLimiter = ai.limiter.tryAcquire();
      if (!releaseLimiter) {
        logger.info('no free worker AI slot for insight narration; deferring to next tick');
        break;
      }
    }

    try {
      // Determine combined locales
      const localesSet = new Set<InsightLocale>();
      for (const item of batchItems) {
        for (const loc of item.candidate.locales) localesSet.add(loc);
      }
      const locales: InsightLocale[] = localesSet.size > 0 ? [...localesSet] : ['en'];

      // Check if any element in batch cites people
      const hasPeople = batchItems.some((item) =>
        item.facts.facts.some((fact) => fact.ref?.kind === 'user'),
      );

      let staffNames: string[] | undefined;
      if (hasPeople) {
        const users = await database.db
          .select({ name: schema.users.name })
          .from(schema.users)
          .where(eq(schema.users.status, 'active'));
        staffNames = users.map((u) => u.name);
      }

      const narrationElements: InsightNarrationElement[] = batchItems.map((item) => ({
        key: item.candidate.element,
        scopeKey: item.candidate.scopeKey,
        facts: item.facts.facts,
      }));

      const batchPayload: InsightNarrationBatch = {
        elements: narrationElements,
        locales,
        names: staffNames,
        scope: `insight:${firstItem.candidate.scopeKey}`,
      };

      if (!ai) {
        logger.warn('insight narration skipped: AI runtime is not configured');
        break;
      }
      const deps: AgentDeps = ai.agentDeps(staffNames ?? []);

      const outcome = await narrateElements(deps, batchPayload);
      narratedBatches++;

      if (outcome.status === 'ok') {
        const expiresAt = new Date(nowMs + ttlHours * 3600_000);

        let actualModel: string = ai.provider;
        if (outcome.runId) {
          const [runRow] = await database.db
            .select({ model: schema.aiRun.model })
            .from(schema.aiRun)
            .where(eq(schema.aiRun.id, outcome.runId))
            .limit(1);
          if (runRow?.model) actualModel = runRow.model;
        }

        for (const item of batchItems) {
          const elKey = item.candidate.element;
          const elementAccepted = outcome.accepted[elKey];
          const orgId = item.candidate.scopeKey.startsWith('org:')
            ? item.candidate.scopeKey.slice('org:'.length)
            : null;

          for (const locale of locales) {
            const rawClaims = elementAccepted?.[locale];
            if (!rawClaims || rawClaims.length === 0) continue;

            // Map {person_[a-h]} in claim text to [PERSON_n] if present
            const claims = rawClaims.map((claim) => {
              const text = claim.text.replace(/\{(person_[a-h])\}/g, (_match, token: string) => {
                const code = token.charCodeAt(7) - 97;
                return `[PERSON_${String(code + 1)}]`;
              });
              return { ...claim, text };
            });

            if (item.candidate.isUserScoped && item.candidate.subjectUserId) {
              await database.db
                .insert(schema.aiSummary)
                .values({
                  kind: 'my_work',
                  userId: item.candidate.subjectUserId,
                  locale,
                  fingerprint: item.fingerprint,
                  claims,
                  aiRunId: outcome.runId ?? null,
                  mock: outcome.mock,
                  dataAsOf: new Date(item.facts.asOf),
                  generatedAt: now,
                })
                .onConflictDoUpdate({
                  target: [schema.aiSummary.kind, schema.aiSummary.userId, schema.aiSummary.locale],
                  set: {
                    fingerprint: item.fingerprint,
                    claims,
                    aiRunId: outcome.runId ?? null,
                    mock: outcome.mock,
                    dataAsOf: new Date(item.facts.asOf),
                    generatedAt: now,
                  },
                });

              // Audit row
              await database.db.insert(schema.auditLog).values({
                actorType: 'system',
                action: AUDIT_ACTIONS.insightGenerated,
                outcome: 'success',
                targetType: 'ai_summary',
                metadata: {
                  element: elKey,
                  scope: item.candidate.scopeKey,
                  userId: item.candidate.subjectUserId,
                  locale,
                  fingerprint: item.fingerprint,
                  aiRunId: outcome.runId,
                },
              });
            } else {
              // Standard element insight
              await database.db
                .insert(schema.aiElementInsight)
                .values({
                  element: elKey,
                  scopeKey: item.candidate.scopeKey,
                  period: item.candidate.period,
                  locale,
                  orgId,
                  facts: item.facts.facts,
                  factsFingerprint: item.fingerprint,
                  claims,
                  promptId: ELEMENT_INSIGHT_PROMPT_ID,
                  promptVersion: 'v1',
                  model: actualModel,
                  aiRunId: outcome.runId ?? null,
                  mock: outcome.mock,
                  generatedAt: now,
                  expiresAt,
                })
                .onConflictDoUpdate({
                  target: [
                    schema.aiElementInsight.element,
                    schema.aiElementInsight.scopeKey,
                    schema.aiElementInsight.period,
                    schema.aiElementInsight.locale,
                  ],
                  set: {
                    orgId,
                    facts: item.facts.facts,
                    factsFingerprint: item.fingerprint,
                    claims,
                    promptId: ELEMENT_INSIGHT_PROMPT_ID,
                    promptVersion: 'v1',
                    model: actualModel,
                    aiRunId: outcome.runId ?? null,
                    mock: outcome.mock,
                    generatedAt: now,
                    expiresAt,
                  },
                });

              // Audit row
              await database.db.insert(schema.auditLog).values({
                actorType: 'system',
                action: AUDIT_ACTIONS.insightGenerated,
                outcome: 'success',
                targetType: 'ai_element_insight',
                metadata: {
                  element: elKey,
                  scope: item.candidate.scopeKey,
                  period: item.candidate.period,
                  locale,
                  orgId: orgId ?? undefined,
                  fingerprint: item.fingerprint,
                  aiRunId: outcome.runId,
                },
              });
            }

            generatedElements++;
          }

          // Clear dirty mark for processed candidate
          await clearDirty(redis, item.candidate.dirtyKey);
        }

        // Record audit for any rejected claims (N4, section 9.5)
        for (const rej of outcome.rejected) {
          await database.db.insert(schema.auditLog).values({
            actorType: 'system',
            action: AUDIT_ACTIONS.insightNarrationRejected,
            outcome: 'failure',
            targetType: 'ai_element_insight',
            metadata: {
              element: rej.elementKey,
              locale: rej.locale,
              reason: rej.reason,
              detail: rej.detail,
            },
          });
        }
      } else {
        logger.warn(
          { status: outcome.status, reason: outcome.reason },
          'insight narration skipped or failed',
        );
      }
    } finally {
      if (releaseLimiter) {
        releaseLimiter();
      }
    }
  }

  return {
    processedCandidates: cappedCandidates.length,
    narratedBatches,
    generatedElements,
  };
}
