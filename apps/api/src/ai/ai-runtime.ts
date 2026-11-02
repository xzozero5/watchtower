import {
  DevMockLlmProvider,
  createAuditedLlm,
  createRedactor,
  loadPromptCatalog,
  mockSettings,
  type AssistantDeps,
  type LlmProvider,
  type ProviderKind,
} from '@watchtower/ai';
import type { Database } from '@watchtower/db';
import {
  createAiGuard,
  createAiRunRecorder,
  createBudgetMonitor,
  createPolicyGate,
  resolveAiCaps,
  type BudgetEventNotice,
} from '@watchtower/domain';

import type { ApiConfig } from '../config/config.js';
import type { AppLogger } from '../logging/logger.js';

/** DI token of the AI layer as the api uses it (T-134, ADR-017). */
export const AI_RUNTIME = Symbol('AI_RUNTIME');
/** The model provider of the api: `null` when none is wired (a test replaces it to count or fail). */
export const API_LLM = Symbol('API_LLM');

/**
 * The AI layer of the api: the audited LLM wired to the `ai_run` recorder, the guard (kill switch
 * through the policy gate, daily budget), the prompt catalog and a redactor. The worker has its own
 * (`apps/worker/src/ai/runtime.ts`) with live providers; the api serves the assistant and the AI
 * summaries and, until the owner approves a key and a live wiring (`[ASK-HUMAN]`), only the mock
 * provider is wired here: a real `AI_PROVIDER` answers `provider_unavailable`, never a made-up
 * answer and never a silent fallback to the mock (N5).
 */
export interface AiRuntime {
  readonly provider: ProviderKind;
  /** True when a model can be called now. */
  readonly ready: boolean;
  /** Why not, as a stable code. */
  readonly notReadyReason: 'provider_unavailable' | null;
  readonly deps: AssistantDeps;
}

export interface AiRuntimeOptions {
  readonly config: Pick<
    ApiConfig,
    'AI_PROVIDER' | 'AI_DAILY_COST_CAP_USD' | 'AI_DAILY_TOKEN_CAP' | 'AI_BUDGET_ALERT_PERCENT'
  >;
  readonly database: Database;
  readonly logger: AppLogger;
  /** Absent or null with `AI_PROVIDER=mock`: the dev mock. Null otherwise: not ready. */
  readonly llm?: LlmProvider | null | undefined;
  readonly now?: () => Date;
}

export function createApiAiRuntime(options: AiRuntimeOptions): AiRuntime {
  const { config, database, logger } = options;
  const now = options.now ?? ((): Date => new Date());
  const caps = resolveAiCaps(config);
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

  const kind = config.AI_PROVIDER;
  const provider = kind === 'mock' ? (options.llm ?? new DevMockLlmProvider()) : null;
  const settings = mockSettings();
  const llm = createAuditedLlm({
    settings: { load: () => Promise.resolve(settings) },
    providers: provider === null ? {} : { mock: provider },
    sink: createAiRunRecorder({ db: database.db }),
    now: () => now().getTime(),
  });
  const deps: AssistantDeps = {
    llm,
    redactor: createRedactor(),
    prompts: loadPromptCatalog(),
    guard,
    redactorFor: (names) => createRedactor({ names: () => names }),
  };
  return {
    provider: kind,
    ready: provider !== null,
    notReadyReason: provider === null ? 'provider_unavailable' : null,
    deps,
  };
}
