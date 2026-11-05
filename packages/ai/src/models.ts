import {
  DEFAULT_AGENT_TIERS,
  type AgentName,
  type AiSettings,
  type ModelPrice,
  type ModelTier,
  type ProviderKind,
  type TokenUsage,
} from './contract.js';

export interface ResolvedModel {
  tier: ModelTier;
  provider: ProviderKind;
  model: string;
}

/**
 * Picks the model for an agent: the agent's tier (settings override, else the default), then the
 * model id that settings assign to the tier. No model name appears in code.
 */
export function resolveModel(
  settings: AiSettings,
  agent: AgentName,
  tierOverride?: ModelTier,
): ResolvedModel {
  const tier = tierOverride ?? settings.agentTiers[agent] ?? DEFAULT_AGENT_TIERS[agent];
  const ref = settings.tiers[tier];
  const direct = tierOverride === undefined ? settings.agentModels[agent] : undefined;
  if (direct !== undefined) return { tier, provider: ref.provider, model: direct };
  return { tier, provider: ref.provider, model: ref.model };
}

/** USD for one call, or null when settings hold no price for the model (unknown, not zero). */
export function estimateCostUsd(usage: TokenUsage, price: ModelPrice | undefined): number | null {
  if (price === undefined) return null;
  return (
    (usage.inputTokens * price.inputUsdPerMTok + usage.outputTokens * price.outputUsdPerMTok) /
    1_000_000
  );
}

/**
 * Settings for `AI_PROVIDER=mock` (the default): every tier maps to the mock provider, which is
 * free and offline. The ids are labels for audit rows, not real models.
 */
export function mockSettings(): AiSettings {
  return {
    tiers: {
      deep: { provider: 'mock', model: 'mock-deep' },
      standard: { provider: 'mock', model: 'mock-standard' },
      light: { provider: 'mock', model: 'mock-light' },
    },
    agentTiers: {},
    agentModels: {},
    // Fixed on purpose: the mock provider holds no real data. Real settings carry a server-side
    // value from the environment or the credential store.
    inputHashKey: 'mock-only-input-hash-value-0000000000',
    embedding: { provider: 'mock', model: 'mock-embedding', dimensions: 16 },
    prices: {
      'mock-deep': { inputUsdPerMTok: 0, outputUsdPerMTok: 0 },
      'mock-standard': { inputUsdPerMTok: 0, outputUsdPerMTok: 0 },
      'mock-light': { inputUsdPerMTok: 0, outputUsdPerMTok: 0 },
    },
  };
}

/** The slice of an app config that names the embedding model (ADR-030). */
export interface EmbeddingConfig {
  readonly EMBEDDING_PROVIDER: 'mock' | 'vertex' | 'local';
  readonly EMBEDDING_MODEL?: string | undefined;
  readonly EMBEDDING_DIMENSIONS?: number | undefined;
}

/**
 * The embedding model of settings, from the environment. `mock` keeps the offline mock. `local`
 * takes the model and size from `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` and is priced at zero
 * (it runs on this machine), so its `ai_run` rows carry `cost_usd = 0`, not null. Any other provider
 * is not wired and keeps the mock values (the boot check refuses it first).
 */
export function embeddingSettings(
  config: EmbeddingConfig,
): Pick<AiSettings, 'embedding'> & { prices: Record<string, ModelPrice> } {
  if (config.EMBEDDING_PROVIDER !== 'local')
    return { embedding: mockSettings().embedding, prices: {} };
  const model = config.EMBEDDING_MODEL?.trim();
  if (model === undefined || model === '') {
    throw new Error('EMBEDDING_MODEL is required when EMBEDDING_PROVIDER=local');
  }
  const dimensions = config.EMBEDDING_DIMENSIONS;
  if (dimensions === undefined || !Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error('EMBEDDING_DIMENSIONS is required when EMBEDDING_PROVIDER=local');
  }
  return {
    embedding: { provider: 'local', model, dimensions },
    prices: { [model]: { inputUsdPerMTok: 0, outputUsdPerMTok: 0 } },
  };
}
