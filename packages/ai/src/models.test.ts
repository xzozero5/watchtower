import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { aiSettingsSchema, DEFAULT_AGENT_TIERS, MODEL_TIERS, type AiSettings } from './contract.js';
import { estimateCostUsd, mockSettings, resolveModel } from './models.js';

const settings: AiSettings = aiSettingsSchema.parse({
  tiers: {
    deep: { provider: 'anthropic', model: 'fixture-deep' },
    standard: { provider: 'vertex', model: 'fixture-standard' },
    light: { provider: 'vertex', model: 'fixture-light' },
  },
  agentTiers: { classifier: 'standard' },
  inputHashKey: 'x'.repeat(32),
  embedding: { provider: 'vertex', model: 'fixture-embedding', dimensions: 768 },
  prices: { 'fixture-deep': { inputUsdPerMTok: 15, outputUsdPerMTok: 75 } },
});

describe('model selection by tier', () => {
  it('uses the agent default tier and the model that settings assign to it', () => {
    expect(resolveModel(settings, 'investigator')).toEqual({
      tier: 'deep',
      provider: 'anthropic',
      model: 'fixture-deep',
    });
    expect(resolveModel(settings, 'summarizer')).toEqual({
      tier: 'light',
      provider: 'vertex',
      model: 'fixture-light',
    });
  });

  it('lets settings override the tier per agent, and a call override the tier', () => {
    expect(resolveModel(settings, 'classifier').tier).toBe('standard');
    expect(resolveModel(settings, 'classifier', 'deep').model).toBe('fixture-deep');
  });

  it('can send one agent to another vendor by pointing its tier elsewhere (grader)', () => {
    const split = aiSettingsSchema.parse({
      ...settings,
      agentTiers: { grader: 'light' },
    });
    expect(resolveModel(split, 'grader').provider).toBe('vertex');
    expect(resolveModel(split, 'drafter').provider).toBe('anthropic');
  });

  it('lets settings give one agent its own model id, keeping its tier label (T-301c)', () => {
    const split = aiSettingsSchema.parse({ ...settings, agentModels: { grader: 'fixture-alias' } });
    expect(resolveModel(split, 'grader')).toEqual({
      tier: 'standard',
      provider: 'vertex',
      model: 'fixture-alias',
    });
    expect(resolveModel(split, 'drafter').model).toBe('fixture-deep');
    // an explicit tier on the call still wins
    expect(resolveModel(split, 'grader', 'deep').model).toBe('fixture-deep');
  });

  it('gives every agent a default tier', () => {
    for (const tier of Object.values(DEFAULT_AGENT_TIERS)) expect(MODEL_TIERS).toContain(tier);
  });

  it('mock settings map every tier to the mock provider', () => {
    const mock = aiSettingsSchema.parse(mockSettings());
    for (const tier of MODEL_TIERS) expect(mock.tiers[tier].provider).toBe('mock');
    expect(mock.embedding.provider).toBe('mock');
  });

  it('rejects settings without a model for a tier', () => {
    expect(() =>
      aiSettingsSchema.parse({ ...settings, tiers: { deep: settings.tiers.deep } }),
    ).toThrow();
  });
});

describe('cost', () => {
  it('prices tokens per million', () => {
    const cost = estimateCostUsd(
      { inputTokens: 2000, outputTokens: 500 },
      { inputUsdPerMTok: 15, outputUsdPerMTok: 75 },
    );
    expect(cost).toBeCloseTo(0.0675, 10);
  });

  it('is null (unknown), not zero, without a price', () => {
    expect(estimateCostUsd({ inputTokens: 1, outputTokens: 1 }, undefined)).toBeNull();
  });
});

describe('no hard-coded model names (AGENTS.md)', () => {
  it('has no vendor model name in non-test source', () => {
    const root = fileURLToPath(new URL('.', import.meta.url));
    const pattern = /\b(?:claude|gemini|opus|sonnet|haiku|gpt-\d)[-\w.@]*/i;
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
          const lines = readFileSync(path, 'utf8').split('\n');
          lines.forEach((line, index) => {
            // Doc comments may name vendors ("Gemini on Vertex AI"); string literals may not.
            // `claude-cli` is a provider kind (ADR-017) and `claude-bridge` a compose service name
            // (ADR-019), not model names.
            const code = line
              .replace(/^\s*(\/\*\*|\*|\/\/).*$/, '')
              .replace(/claude-cli/g, 'provider-kind')
              .replace(/claude-bridge/g, 'service-name')
              // ADR-031: these exact backend protocol values name a vendor, not a model.
              .replace(/backend: z\.enum\(\['claude', 'codex'\]\)/g, 'backend: vendorEnum')
              .replace(/backend: 'claude'/g, 'backend: vendor');
            if (/['"`]/.test(code) && pattern.test(code))
              hits.push(`${path.slice(root.length)}:${String(index + 1)}`);
          });
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
