import {
  DevMockLlmProvider,
  buildAiSettings,
  createAuditedLlm,
  createLiveProvider,
  createRedactor,
  loadPromptCatalog,
  applyRedactionNer,
  type AiCredentialReader,
  type AssistantDeps,
  type FetchLike,
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
import { isAssistantRequest, limitConcurrency } from './concurrency-limit.js';

/** DI token of the AI layer as the api uses it (T-134, ADR-023). */
export const AI_RUNTIME = Symbol('AI_RUNTIME');
/** The model provider of the api: `null` when none is wired (a test replaces it to count or fail). */
export const API_LLM = Symbol('API_LLM');

/** Where the compose `claude-bridge` service is (ADR-019). */
export const DEFAULT_CLAUDE_CLI_BRIDGE_URL = 'http://claude-bridge:4317';

/**
 * The AI layer of the api: the audited LLM wired to the `ai_run` recorder, the guard (kill switch
 * through the policy gate, daily budget), the prompt catalog and a redactor. The worker has its own
 * (`apps/worker/src/ai/runtime.ts`); the api serves the assistant and the AI summaries with the same
 * live provider factory (`createLiveProvider`, `buildAiSettings` of `@watchtower/ai`; ADR-023 "Live
 * provider"). A real `AI_PROVIDER` that is not fully set up (no model, price or bridge secret) is
 * not ready and answers `provider_unavailable`: never a made-up answer and never a silent fallback
 * to the mock (N5). The api's calls are capped (`AI_API_MAX_CONCURRENCY`) so they cannot take every
 * slot of the bridge from the worker.
 */
export interface AiRuntime {
  readonly provider: ProviderKind;
  /** True when a model can be called now. */
  readonly ready: boolean;
  /** Why not, as a stable code. */
  readonly notReadyReason: 'provider_unavailable' | null;
  /** Plain-language reasons a live provider is not ready (no values), for the boot log. */
  readonly problems: readonly string[];
  readonly deps: AssistantDeps;
}

export interface AiRuntimeOptions {
  readonly config: Pick<
    ApiConfig,
    | 'AI_PROVIDER'
    | 'REDACTION_NER'
    | 'AI_DAILY_COST_CAP_USD'
    | 'AI_DAILY_TOKEN_CAP'
    | 'EMBEDDING_DAILY_TOKEN_CAP'
    | 'AI_BUDGET_ALERT_PERCENT'
    | 'AI_MODEL_DEEP'
    | 'AI_MODEL_STANDARD'
    | 'AI_MODEL_LIGHT'
    | 'AI_MODEL_PRICES'
    | 'APP_ENCRYPTION_KEY'
    | 'AI_API_MAX_CONCURRENCY'
    | 'CLAUDE_CLI_BRIDGE_URL'
    | 'CLAUDE_CLI_BRIDGE_TOKEN'
  >;
  readonly database: Database;
  readonly logger: AppLogger;
  /** Replaces the provider (tests count or fail calls with it). Absent: the mock for `mock`, the live adapter otherwise. */
  readonly llm?: LlmProvider | null | undefined;
  /** Where the `anthropic` key comes from (the credential store). Absent: those calls are refused. */
  readonly credentials?: AiCredentialReader | undefined;
  /** Network access of a live provider. Default: the process `fetch`. Never used by mock. */
  readonly fetch?: FetchLike | undefined;
  readonly now?: () => Date;
}

export function createApiAiRuntime(options: AiRuntimeOptions): AiRuntime {
  const { config, database, logger } = options;
  applyRedactionNer(config.REDACTION_NER);
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
    caps,
  });

  const kind = config.AI_PROVIDER;
  const built = buildAiSettings(config);
  const settings = built.settings;
  const problems = [...built.problems];
  if (kind === 'claude-cli' && (config.CLAUDE_CLI_BRIDGE_TOKEN ?? '').trim() === '') {
    problems.push('the bridge secret (CLAUDE_CLI_BRIDGE_TOKEN) is not set');
  }
  if (kind === 'vertex') problems.push('no Vertex access token source is wired in the api');

  let provider: LlmProvider | null;
  if (options.llm !== undefined && options.llm !== null) {
    provider = options.llm;
  } else if (kind === 'mock') {
    provider = new DevMockLlmProvider();
  } else if (problems.length > 0) {
    provider = null;
  } else {
    provider = limitConcurrency(
      createLiveProvider({
        kind,
        settings,
        credentials: options.credentials ?? { read: () => Promise.resolve({}) },
        claudeCli: {
          bridgeUrl: config.CLAUDE_CLI_BRIDGE_URL ?? DEFAULT_CLAUDE_CLI_BRIDGE_URL,
          token: config.CLAUDE_CLI_BRIDGE_TOKEN,
        },
        fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
        logger,
        now: () => now().getTime(),
      }),
      {
        maxConcurrent: config.AI_API_MAX_CONCURRENCY,
        // One slot is always left for the AI summaries of the screens: the assistant cannot use it (T-155a C-4).
        reservedSlots: 1,
        isLowPriority: isAssistantRequest,
      },
    );
  }
  if (kind !== 'mock' && problems.length > 0) {
    logger.error(
      { provider: kind, problems },
      'AI provider is selected but not fully set up: the assistant answers unavailable',
    );
  }
  const llm = createAuditedLlm({
    guard,
    settings: { load: () => Promise.resolve(settings) },
    providers: provider === null ? {} : { [kind]: provider },
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
    problems,
    deps,
  };
}
