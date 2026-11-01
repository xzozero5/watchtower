import {
  DevMockLlmProvider,
  createAuditedLlm,
  createRedactor,
  loadPromptCatalog,
  mockSettings,
  type AgentDeps,
  type LlmProvider,
  type PromptCatalog,
  type ProviderKind,
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

import type { WorkerConfig } from '../config.js';
import type { InboundClassifierFactory } from '../ingest/classifier.js';
import type { WorkerLogger } from '../logger.js';
import { createAiClassifierFactory } from './classifier-hook.js';

/** What a test (or a later task) may replace; production uses the defaults. */
export interface AiOverrides {
  /** Providers by kind. Tests use it to count calls or to fail on demand. */
  readonly providers?: Partial<Record<ProviderKind, LlmProvider>>;
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
    'AI_PROVIDER' | 'AI_DAILY_COST_CAP_USD' | 'AI_DAILY_TOKEN_CAP' | 'AI_BUDGET_ALERT_PERCENT'
  >,
  database: Database,
  logger: WorkerLogger,
  overrides: AiOverrides = {},
): AiRuntime | undefined {
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
  const llm = createAuditedLlm({
    settings: { load: () => Promise.resolve(mockSettings()) },
    providers: overrides.providers ?? { mock: new DevMockLlmProvider() },
    sink: createAiRunRecorder({ db: database.db }),
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
    classifierFor: createAiClassifierFactory({ agentDeps, database, logger }),
  };
}
