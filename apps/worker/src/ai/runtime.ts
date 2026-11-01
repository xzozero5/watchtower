import {
  DevMockLlmProvider,
  MockEmbeddingProvider,
  createAuditedEmbedder,
  createAuditedLlm,
  createRedactor,
  loadPromptCatalog,
  mockSettings,
  type AgentDeps,
  type AuditedEmbedder,
  type EmbeddingProvider,
  type LlmProvider,
  type PromptCatalog,
  type ProviderKind,
  type SettingsSource,
} from '@watchtower/ai';
import type { Database } from '@watchtower/db';
import {
  createAiGuard,
  createAiRunRecorder,
  createBudgetMonitor,
  createPolicyGate,
  resolveAiCaps,
  type AiCaps,
  type BudgetEventNotice,
} from '@watchtower/domain';
import { assertKbEmbeddingProvider } from '@watchtower/shared';

import type { WorkerConfig } from '../config.js';
import type { InboundClassifierFactory } from '../ingest/classifier.js';
import type { WorkerLogger } from '../logger.js';
import { createAiClassifierFactory } from './classifier-hook.js';

/** What a test (or a later task) may replace; production uses the defaults. */
export interface AiOverrides {
  /** Providers by kind. Tests use it to count calls or to fail on demand. */
  readonly providers?: Partial<Record<ProviderKind, LlmProvider>>;
  /** Embedding providers by kind (T-107b). Tests use it to count calls or to fail on demand. */
  readonly embeddingProviders?: Partial<Record<ProviderKind, EmbeddingProvider>>;
  /** Replaces the provider and model settings (tests change the embedding model with it). */
  readonly settings?: SettingsSource;
  readonly now?: () => Date;
}

/**
 * The AI layer as the worker uses it (T-106e): the audited LLM wired to the `ai_run` recorder, the
 * guard (kill switch through the policy gate, daily budget) and the prompt catalog. Built once at
 * boot. The redactor is built per ticket (`agentDeps`), because its name dictionary is the people
 * of that ticket.
 */
export interface AiRuntime {
  readonly provider: ProviderKind;
  readonly caps: AiCaps;
  /** Agent dependencies whose redactor knows the names of the people in one ticket. */
  agentDeps(names: readonly string[]): AgentDeps;
  /** The ingest classifier hook factory (ADR-009 step 4). */
  readonly classifierFor: InboundClassifierFactory;
  readonly prompts: PromptCatalog;
  /**
   * Embeddings for the knowledge base (T-107b): guarded like every model call, redacted before the
   * provider sees any text (N4), and metered as `ai_run` rows of the `embedder` agent.
   */
  readonly embedder: AuditedEmbedder;
  /** The provider and model settings in force (PRD section 6.7), for the embedding model among them. */
  readonly settings: SettingsSource;
}

/**
 * `AI_PROVIDER=mock` (the default) runs the whole pipeline on the offline dev mock. `anthropic` and
 * `vertex` need credentials and provider settings from the admin store (T-116, `[ASK-HUMAN]`), which
 * are not wired in the worker yet: the runtime is then absent, ingestion classifies by rules and a
 * ticket's AI brief says "needs a person" (fail closed to rules, never a silent mock).
 */
export function createAiRuntime(
  config: Pick<
    WorkerConfig,
    | 'AI_PROVIDER'
    | 'EMBEDDING_PROVIDER'
    | 'AI_DAILY_COST_CAP_USD'
    | 'AI_DAILY_TOKEN_CAP'
    | 'AI_BUDGET_ALERT_PERCENT'
  >,
  database: Database,
  logger: WorkerLogger,
  overrides: AiOverrides = {},
): AiRuntime | undefined {
  // A provider that is not wired stops the boot: it is never ignored in silence (N5).
  assertKbEmbeddingProvider(config.EMBEDDING_PROVIDER);
  if (config.AI_PROVIDER !== 'mock') {
    logger.error(
      { provider: config.AI_PROVIDER },
      'AI provider is not wired in the worker yet: AI stays off, ingestion uses rules',
    );
    return undefined;
  }

  const caps = resolveAiCaps(config);
  const prompts = loadPromptCatalog();
  const now = overrides.now ?? ((): Date => new Date());
  const budget = createBudgetMonitor({
    db: database.db,
    caps,
    now,
    onEvent: (notice: BudgetEventNotice) => {
      const fields = { dimension: notice.dimension, spent: notice.spent, cap: notice.cap };
      if (notice.level === 'stop') logger.error(fields, 'AI daily budget reached: AI stopped');
      else logger.warn(fields, 'AI daily budget alert');
    },
  });
  const guard = createAiGuard({
    policyGate: createPolicyGate({ db: database.db }),
    db: database.db,
    budget,
  });
  const settings: SettingsSource = overrides.settings ?? {
    load: () => Promise.resolve(mockSettings()),
  };
  const llm = createAuditedLlm({
    settings,
    providers: overrides.providers ?? { mock: new DevMockLlmProvider() },
    sink: createAiRunRecorder({ db: database.db }),
    now: () => now().getTime(),
  });

  const sink = createAiRunRecorder({ db: database.db });
  const embedder = createAuditedEmbedder({
    settings,
    providers: overrides.embeddingProviders ?? { mock: new MockEmbeddingProvider() },
    sink,
    // No name dictionary: knowledge base articles are written by staff, not by a ticket's people.
    redactor: createRedactor(),
    guard,
    now: () => now().getTime(),
  });

  const agentDeps = (names: readonly string[]): AgentDeps => ({
    llm,
    redactor: createRedactor({ names: () => names }),
    prompts,
    guard,
  });
  return {
    provider: config.AI_PROVIDER,
    caps,
    prompts,
    agentDeps,
    embedder,
    settings,
    classifierFor: createAiClassifierFactory({ agentDeps, database, logger }),
  };
}
