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
