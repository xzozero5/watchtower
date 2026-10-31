import { describe, expect, it } from 'vitest';

import { CHANNEL_TYPES, resolveIntegrationMode } from './index.js';

describe('CHANNEL_TYPES', () => {
  it('matches the channel types in the data model', () => {
    expect(CHANNEL_TYPES).toEqual(['gmail', 'line', 'portal', 'discord', 'webhook']);
  });
});

describe('resolveIntegrationMode', () => {
  it('is live when every credential is present', () => {
    expect(resolveIntegrationMode(['a', 'b'])).toBe('live');
  });

  it.each([
    ['no credentials listed', []],
    ['an empty value', ['a', '']],
    ['a blank value', ['a', '   ']],
    ['an unset value', ['a', undefined]],
  ])('falls back to mock with %s', (_label, credentials) => {
    expect(resolveIntegrationMode(credentials)).toBe('mock');
  });
});
