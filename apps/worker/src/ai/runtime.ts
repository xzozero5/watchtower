import {
  DevMockLlmProvider,
  createAuditedLlm,
  createRedactor,
  loadPromptCatalog,
  type AgentDeps,
  type FetchLike,
  type LlmProvider,
  type PromptCatalog,
  type ProviderKind,
} from '@watchtower/ai';
import { createCredentialStore, type Database } from '@watchtower/db';
import {
  createAiGuard,
  createAiRunRecorder,
  createBudgetMonitor,
  createPolicyGate,
  resolveAiCaps,
  type AiCaps,
  type BudgetEventNotice,
} from '@watchtower/domain';
import { pickCredentialEnv } from '@watchtower/shared';
import { localKmsFromConfig } from '@watchtower/shared/credential-box';

import type { WorkerConfig } from '../config.js';
import type { InboundClassifierFactory } from '../ingest/classifier.js';
import type { WorkerLogger } from '../logger.js';
import { createAiClassifierFactory } from './classifier-hook.js';
import { createLiveProvider, type AiCredentialReader } from './live-provider.js';
import { buildAiSettings } from './settings.js';

/** What a test (or a later task) may replace; production uses the defaults. */
export interface AiOverrides {
  /** Providers by kind. Tests use it to count calls or to fail on demand. */
  readonly providers?: Partial<Record<ProviderKind, LlmProvider>>;
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
  readonly provider: ProviderKind;
  readonly caps: AiCaps;
  /** Agent dependencies whose redactor knows the names of the people in one ticket. */
  agentDeps(names: readonly string[]): AgentDeps;
  /** The ingest classifier hook factory (ADR-009 step 4). */
  readonly classifierFor: InboundClassifierFactory;
  readonly prompts: PromptCatalog;
  /** Can the selected provider be called right now? Reads the credentials; never returns a value. */
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
 * `AI_PROVIDER` picks the adapter (T-132). `mock` (the default) runs the whole pipeline on the
 * offline dev mock and never touches the network. `anthropic` and `vertex` use the real adapters of
 * `@watchtower/ai` through the same audited path (redaction, `ai_run`, daily caps, kill switch).
 *
 * A selected provider that is not fully set up (no key, no model, no price) is never swapped for the
 * mock: its calls fail with `ProviderUnavailableError`, which is audited as an error row, shown on
 * the ticket's AI brief, retried by the brief job, and leaves ingestion on the header rules.
 */
export function createAiRuntime(
  config: WorkerConfig,
  database: Database,
  logger: WorkerLogger,
  overrides: AiOverrides = {},
): AiRuntime {
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

  const { settings, problems } = buildAiSettings(config);
  const credentials = overrides.credentials ?? storeCredentials(config, database);
  const kind = config.AI_PROVIDER;
  const providers: Partial<Record<ProviderKind, LlmProvider>> =
    overrides.providers ??
    (kind === 'mock'
      ? { mock: new DevMockLlmProvider() }
      : {
          [kind]: createLiveProvider({
            kind,
            settings,
            credentials,
            fetch: overrides.fetch ?? ((input, init) => globalThis.fetch(input, init)),
            ...(overrides.vertexAccessToken === undefined
              ? {}
              : { vertexAccessToken: overrides.vertexAccessToken }),
            logger,
            now: () => now().getTime(),
          }),
        });
  const llm = createAuditedLlm({
    settings: { load: () => Promise.resolve(settings) },
    providers,
    sink: createAiRunRecorder({ db: database.db }),
    now: () => now().getTime(),
  });

  const readiness = async (): Promise<AiReadiness> => {
    if (kind === 'mock') return { ready: true, problems: [] };
    const found = [...problems];
    try {
      const held = await credentials.read();
      if (kind === 'anthropic' && held.anthropicApiKey === undefined) {
        found.push('no Anthropic API key (ANTHROPIC_API_KEY or the credential store)');
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

  const agentDeps = (names: readonly string[]): AgentDeps => ({
    llm,
    redactor: createRedactor({ names: () => names }),
    prompts,
    guard,
  });
  return {
    provider: kind,
    caps,
    prompts,
    agentDeps,
    classifierFor: createAiClassifierFactory({ agentDeps, database, logger }),
    readiness,
  };
}
