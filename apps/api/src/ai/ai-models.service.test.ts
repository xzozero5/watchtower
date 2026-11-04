import { describe, expect, it } from 'vitest';

import { AiModelsService } from './ai-models.service.js';

// Model ids are labels made up for the test; no real model name is in code.
const KEY = 'k'.repeat(40);
const PRICES = JSON.stringify({
  'label-a': { inputUsdPerMTok: 0, outputUsdPerMTok: 0 },
  'label-b': { inputUsdPerMTok: 0, outputUsdPerMTok: 0 },
});
const BASE = {
  AI_PROVIDER: 'claude-cli',
  APP_ENCRYPTION_KEY: KEY,
  AI_MODEL_DEEP: 'label-a',
  AI_MODEL_STANDARD: 'label-a',
  AI_MODEL_LIGHT: 'label-a',
  AI_MODEL_PRICES: PRICES,
} as const;

describe('AiModelsService (T-301c)', () => {
  it('reports the default tier mapping and flags a grader on the drafter model', () => {
    const mapping = new AiModelsService(BASE).read();
    const grader = mapping.agents.find((row) => row.agent === 'grader');
    expect(grader).toEqual({
      agent: 'grader',
      tier: 'standard',
      model: 'label-a',
      source: 'default',
      priced: true,
    });
    expect(mapping.graderIndependent).toBe(false);
    expect(mapping.agents.map((row) => row.agent)).not.toContain('embedder');
  });

  it('shows a grader alias as independent of the drafter', () => {
    const mapping = new AiModelsService({ ...BASE, AI_AGENT_MODEL_GRADER: 'label-b' }).read();
    expect(mapping.agents.find((row) => row.agent === 'grader')).toMatchObject({
      model: 'label-b',
      source: 'alias',
    });
    expect(mapping.graderIndependent).toBe(true);
  });

  it('shows a tier choice, and a null model when the tier has none', () => {
    const mapping = new AiModelsService({
      ...BASE,
      AI_MODEL_DEEP: undefined,
      AI_AGENT_MODEL_GRADER: 'deep',
    }).read();
    expect(mapping.agents.find((row) => row.agent === 'grader')).toMatchObject({
      tier: 'deep',
      model: null,
      source: 'tier',
      priced: false,
    });
    expect(mapping.graderIndependent).toBe(false);
  });

  it('is all mock labels for the mock provider', () => {
    const mapping = new AiModelsService({ AI_PROVIDER: 'mock', APP_ENCRYPTION_KEY: KEY }).read();
    expect(mapping.provider).toBe('mock');
    expect(mapping.agents.every((row) => row.model?.startsWith('mock-') === true)).toBe(true);
  });
});
