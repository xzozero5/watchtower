import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { phase1EnvShape } from '../config.js';
import {
  AUTOSEND_DISCLOSURE_DEFAULT,
  MANUAL_MAX_AUTONOMY_STAGE,
  PHASE_MAX_AUTONOMY_STAGE,
  autosendDisclosureSchema,
  autosendFlagSchema,
  autosendPolicySchema,
  decidePromotionSchema,
  parseAutosendFlag,
  parseAutosendPolicy,
  setIntentAutosendSchema,
} from './autonomy.js';

describe('AI_AUTOSEND_ENABLED (ADR-025 section 2)', () => {
  it('is ON only for the string "true", exactly', () => {
    expect(parseAutosendFlag('true')).toBe(true);
    for (const value of [
      undefined,
      '',
      'TRUE',
      'True',
      ' true',
      'true ',
      '1',
      'yes',
      'on',
      'false',
      'enabled',
    ]) {
      expect(parseAutosendFlag(value), String(value)).toBe(false);
    }
    expect(autosendFlagSchema.parse('true')).toBe(true);
    expect(autosendFlagSchema.parse(undefined)).toBe(false);
    expect(autosendFlagSchema.parse('1')).toBe(false);
  });

  it('is in the environment contract of the api and the worker and defaults to off', () => {
    const shape = z.object({ AI_AUTOSEND_ENABLED: phase1EnvShape.AI_AUTOSEND_ENABLED });
    expect(shape.parse({ AI_AUTOSEND_ENABLED: 'true' }).AI_AUTOSEND_ENABLED).toBe(true);
    expect(shape.parse({}).AI_AUTOSEND_ENABLED).toBe(false);
    expect(shape.parse({ AI_AUTOSEND_ENABLED: 'TRUE' }).AI_AUTOSEND_ENABLED).toBe(false);
    expect(shape.parse({ AI_AUTOSEND_ENABLED: '' }).AI_AUTOSEND_ENABLED).toBe(false);
  });
});

describe('the stage ceilings', () => {
  it('a person sets 0-2 by hand; 3 exists but is only reached by a promotion', () => {
    expect(MANUAL_MAX_AUTONOMY_STAGE).toBe(2);
    expect(PHASE_MAX_AUTONOMY_STAGE).toBe(3);
  });
});

describe('the auto-send policy', () => {
  it('allows no channel by default and fills the other defaults', () => {
    expect(parseAutosendPolicy({})).toEqual({ channels: [], action: 'reply', maxChars: 1200 });
    expect(parseAutosendPolicy(undefined)).toEqual({
      channels: [],
      action: 'reply',
      maxChars: 1200,
    });
  });

  it('accepts Gmail and the portal, and nothing else', () => {
    expect(parseAutosendPolicy({ channels: ['gmail', 'portal'], maxChars: 800 })).toMatchObject({
      channels: ['gmail', 'portal'],
      maxChars: 800,
    });
    expect(parseAutosendPolicy({ channels: ['line'] })).toBeUndefined();
    expect(parseAutosendPolicy({ channels: ['gmail'], action: 'close' })).toBeUndefined();
    expect(parseAutosendPolicy({ channels: ['gmail'], tools: ['logs'] })).toBeUndefined();
    expect(parseAutosendPolicy({ maxChars: 50 })).toBeUndefined();
    expect(parseAutosendPolicy('gmail')).toBeUndefined();
    expect(autosendPolicySchema.safeParse({ channels: ['gmail', 'gmail', 'portal'] }).success).toBe(
      false,
    );
  });

  it('a setting change needs something to change, a score of 0.70-1.00 and a reason', () => {
    expect(setIntentAutosendSchema.safeParse({ reason: 'why not' }).success).toBe(false);
    expect(setIntentAutosendSchema.safeParse({ minScore: 0.69, reason: 'why not' }).success).toBe(
      false,
    );
    expect(setIntentAutosendSchema.safeParse({ minScore: 0.7, reason: 'why not' }).success).toBe(
      true,
    );
    expect(setIntentAutosendSchema.safeParse({ shadow: true, reason: 'x' }).success).toBe(false);
    expect(setIntentAutosendSchema.safeParse({ dailyCap: 1001, reason: 'why not' }).success).toBe(
      false,
    );
  });
});

describe('the disclosure notice and the promotion decision', () => {
  it('has a default that is on, in Thai and English', () => {
    expect(autosendDisclosureSchema.safeParse(AUTOSEND_DISCLOSURE_DEFAULT).success).toBe(true);
    expect(AUTOSEND_DISCLOSURE_DEFAULT.enabled).toBe(true);
    expect(
      autosendDisclosureSchema.safeParse({ enabled: true, text: { th: '', en: 'x' } }).success,
    ).toBe(false);
  });

  it('an approval carries the typed key; a rejection does not need one', () => {
    expect(decidePromotionSchema.safeParse({ approve: true, reason: 'fine' }).success).toBe(false);
    expect(
      decidePromotionSchema.safeParse({
        approve: true,
        reason: 'fine',
        confirmKey: 'reset_password',
      }).success,
    ).toBe(true);
    expect(decidePromotionSchema.safeParse({ approve: false, reason: 'not yet' }).success).toBe(
      true,
    );
  });
});
