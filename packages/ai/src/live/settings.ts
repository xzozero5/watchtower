import {
  AGENT_NAMES,
  MODEL_TIERS,
  type AgentName,
  modelPriceSchema,
  type AiSettings,
  type ModelPrice,
  type ModelTier,
  type ProviderKind,
} from '../contract.js';
import { mockSettings } from '../models.js';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';
import { z } from 'zod';

/**
 * The model id written to an `ai_run` row when a tier has no model configured. It is a label, not a
 * model: the live provider refuses to call anything with it (see `createLiveProvider`).
 */
export const UNCONFIGURED_MODEL = 'unconfigured';

const TIER_VARIABLES: Readonly<Record<ModelTier, string>> = {
  deep: 'AI_MODEL_DEEP',
  standard: 'AI_MODEL_STANDARD',
  light: 'AI_MODEL_LIGHT',
};

/** Agents whose model can be chosen by environment (the embedder has its own provider setting). */
export const CONFIGURABLE_AGENTS = AGENT_NAMES.filter(
  (name): name is Exclude<AgentName, 'embedder'> => name !== 'embedder',
);

/** `AI_AGENT_MODEL_GRADER` for `grader`, `AI_AGENT_MODEL_KB_AUTHOR` for `kb_author`. */
export function agentModelVariable(agent: AgentName): string {
  return `AI_AGENT_MODEL_${agent.toUpperCase()}`;
}

const pricesSchema = z.record(z.string().min(1), modelPriceSchema);

export interface BuiltAiSettings {
  readonly settings: AiSettings;
  /** Plain-language reasons the provider cannot be called yet. Never holds a value from the config. */
  readonly problems: readonly string[];
}

/** The slice of an app config the settings read (the worker and the api both satisfy it). */
export interface AiSettingsConfig {
  readonly AI_PROVIDER: 'mock' | ProviderKind;
  readonly AI_MODEL_DEEP?: string | undefined;
  readonly AI_MODEL_STANDARD?: string | undefined;
  readonly AI_MODEL_LIGHT?: string | undefined;
  readonly AI_MODEL_PRICES?: string | undefined;
  /** `AI_AGENT_MODEL_<AGENT>`: a tier name or a model alias for one agent (T-301c). */
  readonly AI_AGENT_MODEL_CLASSIFIER?: string | undefined;
  readonly AI_AGENT_MODEL_INVESTIGATOR?: string | undefined;
  readonly AI_AGENT_MODEL_DRAFTER?: string | undefined;
  readonly AI_AGENT_MODEL_SUMMARIZER?: string | undefined;
  readonly AI_AGENT_MODEL_GRADER?: string | undefined;
  readonly AI_AGENT_MODEL_KB_AUTHOR?: string | undefined;
  readonly AI_AGENT_MODEL_ROSTER_PLANNER?: string | undefined;
  readonly AI_AGENT_MODEL_PERSONAL_ASSISTANT?: string | undefined;
  readonly APP_ENCRYPTION_KEY: string;
}
type SettingsConfig = AiSettingsConfig;

function parsePrices(text: string | undefined): {
  prices: Record<string, ModelPrice>;
  problem?: string;
} {
  if (text === undefined) return { prices: {} };
  try {
    const parsed = pricesSchema.safeParse(JSON.parse(text));
    if (parsed.success) return { prices: parsed.data };
  } catch {
    // fall through to the same message
  }
  return { prices: {}, problem: 'AI_MODEL_PRICES is not a JSON object of model id to price' };
}

/**
 * `AiSettings` for the selected provider. `mock` gives the offline mock settings. A real provider
 * takes the model of each tier and the price of each model from the environment (ADR-008: model ids
 * are settings, never code; the admin screen for them is T-106f). A tier without a model, or a
 * model without a price, is reported in `problems` and the live provider then refuses its calls.
 */
export function buildAiSettings(config: SettingsConfig): BuiltAiSettings {
  if (config.AI_PROVIDER === 'mock') return { settings: mockSettings(), problems: [] };
  const provider: ProviderKind = config.AI_PROVIDER;
  const problems: string[] = [];
  const configured: Record<ModelTier, string | undefined> = {
    deep: config.AI_MODEL_DEEP,
    standard: config.AI_MODEL_STANDARD,
    light: config.AI_MODEL_LIGHT,
  };
  const { prices, problem } = parsePrices(config.AI_MODEL_PRICES);
  if (problem !== undefined) problems.push(problem);

  const ref = (tier: ModelTier) => ({
    provider,
    model: configured[tier] ?? UNCONFIGURED_MODEL,
  });
  for (const tier of MODEL_TIERS) {
    const model = configured[tier];
    if (model === undefined) {
      problems.push(`${TIER_VARIABLES[tier]} is not set`);
    } else if (!Object.hasOwn(prices, model)) {
      problems.push(`AI_MODEL_PRICES has no price for the ${tier} model`);
    }
  }

  // Per-agent choice (T-301c): a tier name moves the agent to that tier, anything else is a model
  // alias of the selected provider and needs a price like a tier model does.
  const agentTiers: Partial<Record<AgentName, ModelTier>> = {};
  const agentModels: Partial<Record<AgentName, string>> = {};
  const raw = config as unknown as Readonly<Record<string, string | undefined>>;
  for (const agent of CONFIGURABLE_AGENTS) {
    const variable = agentModelVariable(agent);
    const value = raw[variable]?.trim();
    if (value === undefined || value === '') continue;
    const tier = MODEL_TIERS.find((candidate) => candidate === value);
    if (tier !== undefined) {
      agentTiers[agent] = tier;
    } else {
      agentModels[agent] = value;
      if (!Object.hasOwn(prices, value))
        problems.push(`AI_MODEL_PRICES has no price for ${variable}`);
    }
  }
  return {
    problems,
    settings: {
      tiers: { deep: ref('deep'), standard: ref('standard'), light: ref('light') },
      agentTiers,
      agentModels,
      // Server-side HMAC key of `ai_run.input_hash`: derived from the root key, never logged.
      inputHashKey: deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.aiInputHash).toString('hex'),
      // Only the LLM path runs in the worker; embeddings (T-107) have their own provider setting.
      embedding: mockSettings().embedding,
      prices,
    },
  };
}
