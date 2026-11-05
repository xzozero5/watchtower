import {
  DevMockLlmProvider,
  MockEmbeddingProvider,
  createAuditedEmbedder,
  createAuditedLlm,
  createConcurrencyLimiter,
  createLocalEmbeddingProvider,
  parseLocalEmbeddingHosts,
  createRedactor,
  embeddingSettings,
  loadPromptCatalog,
  warnIfSingleProcessAssumptionBroken,
  applyRedactionNer,
  type AgentDeps,
  type AuditedEmbedder,
  type ConcurrencyLimiter,
  type EmbeddingProvider,
  type FetchLike,
  type LlmProvider,
  type PromptCatalog,
  type ProviderKind,
  type SettingsSource,
} from '@watchtower/ai';
import { createCredentialStore, type Database } from '@watchtower/db';
import {
  createAiGuard,
  createAiRunRecorder,
  createBudgetMonitor,
  createPolicyGate,
  instanceOrigins,
  resolveAiCaps,
  type AiCaps,
  type BudgetEventNotice,
} from '@watchtower/domain';
import { assertKbEmbeddingProvider, pickCredentialEnv } from '@watchtower/shared';
import { localKmsFromConfig } from '@watchtower/shared/credential-box';

import type { WorkerConfig } from '../config.js';
import type { InboundClassifierFactory } from '../ingest/classifier.js';
import type { WorkerLogger } from '../logger.js';
import { createAiClassifierFactory } from './classifier-hook.js';
import { createLiveProvider, type AiCredentialReader } from './live-provider.js';
import { buildAiSettings } from './settings.js';

/** Where the host-side bridge is, seen from a container on Docker Desktop (ADR-017). */
export const DEFAULT_AI_BRIDGE_URL = 'http://ai-bridge:4317';
export const DEFAULT_CLAUDE_CLI_BRIDGE_URL = 'http://host.docker.internal:4317';

/** What a test (or a later task) may replace; production uses the defaults. */
export interface AiOverrides {
  /** Providers by kind. Tests use it to count calls or to fail on demand. */
  readonly providers?: Partial<Record<ProviderKind, LlmProvider>>;
  /** Embedding providers by kind (T-107b). Tests use it to count calls or to fail on demand. */
  readonly embeddingProviders?: Partial<Record<ProviderKind, EmbeddingProvider>>;
  /** Replaces the provider and model settings (tests change the embedding model with it). */
  readonly settings?: SettingsSource;
  /** Where the `ai` credentials come from. Default: the credential store (environment wins, ADR-012). */
  readonly credentials?: AiCredentialReader;
  /** The network access of a real provider. Default: the process `fetch`. Never used by mock. */
  readonly fetch?: FetchLike;
  /** Vertex only: an OAuth access token source. There is no default (see `createLiveProvider`). */
  readonly vertexAccessToken?: () => Promise<string>;
  readonly now?: () => Date;
}

/** Whether the selected provider can be called now, and if not, why (no values, safe to log). */
export interface AiReadiness {
  readonly ready: boolean;
  readonly problems: readonly string[];
}

/**
 * The AI layer as the worker uses it (T-106e): the audited LLM wired to the `ai_run` recorder, the
 * guard (kill switch through the policy gate, daily budget) and the prompt catalog. Built once at
 * boot. The redactor is built per ticket (`agentDeps`), because its name dictionary is the people
 * of that ticket.
 */
export interface AiRuntime {
  /** The LLM adapter `AI_PROVIDER` selected. Embeddings have their own setting and stay mock. */
  readonly provider: ProviderKind;
  readonly caps: AiCaps;
  /** Agent dependencies whose redactor knows the names of the people in one ticket. */
  agentDeps(names: readonly string[], options?: { dictionaryIncomplete?: boolean }): AgentDeps;
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
  /**
   * The slots of the live provider (`WORKER_AI_MAX_CONCURRENCY`, shared limiter of `@watchtower/ai`): background
   * work that must never wait (the insight tick, T-418) asks `tryAcquire()` before it calls. `null` on the mock and
   * on providers a test passes in: nothing is capped there.
   */
  readonly limiter: ConcurrencyLimiter | null;
  /** Can the selected LLM provider be called right now? Reads the credentials; never returns a value. */
  readiness(): Promise<AiReadiness>;
}

/** The `ai` integration of the credential store: environment first, then the database (ADR-012). */
function storeCredentials(config: WorkerConfig, database: Database): AiCredentialReader {
  const store = createCredentialStore({
    database,
    kms: localKmsFromConfig(config),
    env: pickCredentialEnv(config),
  });
  return {
    read: async () => {
      const fields = await store.resolve('ai');
      const text = (name: string): string | undefined => {
        const value = fields[name]?.value.trim();
        return value === undefined || value === '' ? undefined : value;
      };
      return {
        anthropicApiKey: text('anthropicApiKey'),
        vertexProjectId: text('vertexProjectId'),
        vertexLocation: text('vertexLocation'),
      };
    },
  };
}

/**
 * `AI_PROVIDER` picks the LLM adapter (T-132). `mock` (the default) runs the whole pipeline on the
 * offline dev mock and never touches the network. `anthropic` and `vertex` use the real adapters of
 * `@watchtower/ai` through the same audited path (redaction, `ai_run`, daily caps, kill switch).
 *
 * A selected provider that is not fully set up (no key, no model, no price) is never swapped for the
 * mock: its calls fail with `ProviderUnavailableError`, which is audited as an error row, shown on
 * the ticket's AI brief, retried by the brief job, and leaves ingestion on the header rules.
 *
 * Embeddings (T-107b): `mock` or `local` (ADR-030); `EMBEDDING_PROVIDER` other than a wired one stops the boot,
 * and the embedder goes through the same guard, redactor and `ai_run` recorder as the LLM.
 */
export function createAiRuntime(
  config: WorkerConfig,
  database: Database,
  logger: WorkerLogger,
  overrides: AiOverrides = {},
): AiRuntime {
  // A provider that is not wired stops the boot: it is never ignored in silence (N5).
  assertKbEmbeddingProvider(config.EMBEDDING_PROVIDER);
  applyRedactionNer(config.REDACTION_NER);

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
    policyGate: createPolicyGate({
      db: database.db,
      autosendEnabled: config.AI_AUTOSEND_ENABLED,
      aiCaps: caps,
      linkOrigins: instanceOrigins(config.APP_URL),
    }),
    db: database.db,
    budget,
    caps,
  });

  const built = buildAiSettings(config);
  // The embedding model comes from EMBEDDING_* (ADR-030); the LLM tiers from AI_*.
  const embeddingModel = embeddingSettings(config);
  const settings: SettingsSource = overrides.settings ?? {
    load: () =>
      Promise.resolve({
        ...built.settings,
        embedding: embeddingModel.embedding,
        prices: { ...built.settings.prices, ...embeddingModel.prices },
      }),
  };
  const credentials = overrides.credentials ?? storeCredentials(config, database);
  const kind = config.AI_PROVIDER;
  // The worker's own share of the bridge (api 2 + worker 2 = 4). No reserved slot: every job here is the same class.
  const limiter =
    overrides.providers === undefined && kind !== 'mock'
      ? createConcurrencyLimiter({ maxConcurrent: config.WORKER_AI_MAX_CONCURRENCY })
      : null;
  if (limiter !== null) {
    warnIfSingleProcessAssumptionBroken('worker', config.WORKER_REPLICAS, (fields, message) => {
      logger.warn(fields, message);
    });
  }
  const liveProvider = (live: Exclude<ProviderKind, 'mock' | 'local'>): LlmProvider => {
    const adapter = createLiveProvider({
      kind: live,
      settings: built.settings,
      credentials,
      aiBridge: {
        bridgeUrl:
          config.AI_BRIDGE_URL ??
          config.CLAUDE_CLI_BRIDGE_URL ??
          (kind === 'ai-cli' ? DEFAULT_AI_BRIDGE_URL : DEFAULT_CLAUDE_CLI_BRIDGE_URL),
        token: config.AI_BRIDGE_TOKEN ?? config.CLAUDE_CLI_BRIDGE_TOKEN,
      },
      fetch: overrides.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      ...(overrides.vertexAccessToken === undefined
        ? {}
        : { vertexAccessToken: overrides.vertexAccessToken }),
      logger,
      now: () => now().getTime(),
    });
    return limiter === null ? adapter : limiter.limit(adapter);
  };
  const providers: Partial<Record<ProviderKind, LlmProvider>> =
    overrides.providers ??
    (kind === 'mock' ? { mock: new DevMockLlmProvider() } : { [kind]: liveProvider(kind) });
  const sink = createAiRunRecorder({ db: database.db });
  const llm = createAuditedLlm({
    guard,
    settings,
    providers,
    sink,
    now: () => now().getTime(),
  });
  const embedder = createAuditedEmbedder({
    settings,
    providers: overrides.embeddingProviders ?? {
      mock: new MockEmbeddingProvider(),
      // Indexing waits longer per call than a search does: a cold model takes a while to load.
      ...(config.EMBEDDING_PROVIDER === 'local'
        ? {
            local: createLocalEmbeddingProvider({
              url: config.EMBEDDING_LOCAL_URL,
              allowedHosts: parseLocalEmbeddingHosts(config.EMBEDDING_LOCAL_HOSTS),
              fetch: overrides.fetch ?? ((input, init) => globalThis.fetch(input, init)),
              timeoutMs: 120_000,
            }),
          }
        : {}),
    },
    sink,
    // No name dictionary: knowledge base articles are written by staff, not by a ticket's people.
    redactor: createRedactor(),
    guard,
    now: () => now().getTime(),
  });

  const readiness = async (): Promise<AiReadiness> => {
    if (kind === 'mock') return { ready: true, problems: [] };
    const found = [...built.problems];
    try {
      const held = await credentials.read();
      if (kind === 'anthropic' && held.anthropicApiKey === undefined) {
        found.push('no Anthropic API key (ANTHROPIC_API_KEY or the credential store)');
      }
      if (
        (kind === 'claude-cli' || kind === 'ai-cli') &&
        (config.AI_BRIDGE_TOKEN ?? config.CLAUDE_CLI_BRIDGE_TOKEN ?? '').trim() === ''
      ) {
        found.push(
          'AI_BRIDGE_TOKEN or CLAUDE_CLI_BRIDGE_TOKEN is not set (the bridge requires it)',
        );
      }
      if (kind === 'vertex') {
        if (held.vertexProjectId === undefined) found.push('no Vertex project id');
        if (held.vertexLocation === undefined) found.push('no Vertex location');
        if (overrides.vertexAccessToken === undefined) {
          found.push('no Vertex access token source is wired in the worker');
        }
      }
    } catch {
      found.push('the credential store could not be read');
    }
    return { ready: found.length === 0, problems: found };
  };

  const agentDeps = (
    names: readonly string[],
    options: { dictionaryIncomplete?: boolean } = {},
  ): AgentDeps => ({
    llm,
    redactor: createRedactor({
      names: () => names,
      ...(options.dictionaryIncomplete === true ? { dictionaryIncomplete: true } : {}),
    }),
    prompts,
    guard,
  });
  return {
    provider: kind,
    caps,
    prompts,
    agentDeps,
    embedder,
    settings,
    limiter,
    classifierFor: createAiClassifierFactory({ agentDeps, database, logger }),
    readiness,
  };
}
