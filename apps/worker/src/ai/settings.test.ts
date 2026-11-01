import { MODEL_TIERS } from '@watchtower/ai';
import { describe, expect, it } from 'vitest';

import { testConfig } from '../testing/support.js';
import { UNCONFIGURED_MODEL, buildAiSettings } from './settings.js';

// Model ids below are labels made up for the test. No real model name is in this repository's code.
const PRICES = JSON.stringify({
  'label-deep': { inputUsdPerMTok: 10, outputUsdPerMTok: 50 },
  'label-standard': { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  'label-light': { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
});
const MODELS = {
  AI_MODEL_DEEP: 'label-deep',
  AI_MODEL_STANDARD: 'label-standard',
  AI_MODEL_LIGHT: 'label-light',
};

describe('buildAiSettings', () => {
  it('gives the offline mock settings for the default provider and ignores model variables', () => {
    const { settings, problems } = buildAiSettings(testConfig(MODELS));
    expect(problems).toEqual([]);
    for (const tier of MODEL_TIERS) {
      expect(settings.tiers[tier].provider).toBe('mock');
      expect(settings.tiers[tier].model).toBe(`mock-${tier}`);
    }
  });

  it('takes the model of each tier and the price of each model from the environment', () => {
    const { settings, problems } = buildAiSettings(
      testConfig({ AI_PROVIDER: 'anthropic', ...MODELS, AI_MODEL_PRICES: PRICES }),
    );
    expect(problems).toEqual([]);
    expect(settings.tiers).toEqual({
      deep: { provider: 'anthropic', model: 'label-deep' },
      standard: { provider: 'anthropic', model: 'label-standard' },
      light: { provider: 'anthropic', model: 'label-light' },
    });
    expect(settings.prices['label-light']).toEqual({ inputUsdPerMTok: 1, outputUsdPerMTok: 5 });
  });

  it('names what is missing, without echoing any configured value', () => {
    const { settings, problems } = buildAiSettings(
      testConfig({
        AI_PROVIDER: 'vertex',
        AI_MODEL_LIGHT: 'label-light',
        AI_MODEL_STANDARD: 'label-standard',
        AI_MODEL_PRICES: JSON.stringify({
          'label-light': { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
        }),
      }),
    );
    expect(settings.tiers.deep.model).toBe(UNCONFIGURED_MODEL);
    expect(problems).toEqual([
      'AI_MODEL_DEEP is not set',
      'AI_MODEL_PRICES has no price for the standard model',
    ]);
    expect(JSON.stringify(problems)).not.toContain('label-');
  });

  it.each(['not json', '[]', '{"label-light":{"inputUsdPerMTok":-1,"outputUsdPerMTok":1}}'])(
    'reports a prices value that is not a JSON object of prices (%s)',
    (value) => {
      const { problems, settings } = buildAiSettings(
        testConfig({ AI_PROVIDER: 'anthropic', ...MODELS, AI_MODEL_PRICES: value }),
      );
      expect(problems).toContain('AI_MODEL_PRICES is not a JSON object of model id to price');
      expect(settings.prices).toEqual({});
    },
  );

  it('derives a 64-character input hash key from the root key and never uses the root key itself', () => {
    const config = testConfig({ AI_PROVIDER: 'anthropic' });
    const { settings } = buildAiSettings(config);
    expect(settings.inputHashKey).toMatch(/^[0-9a-f]{64}$/);
    expect(settings.inputHashKey).not.toContain(config.APP_ENCRYPTION_KEY);
  });
});
