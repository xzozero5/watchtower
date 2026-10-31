import { describe, expect, it } from 'vitest';

import { isChannelType, packageName } from './index.js';

describe('@watchtower/channels', () => {
  it('exposes its name', () => {
    expect(packageName).toBe('@watchtower/channels');
  });

  it('recognises channel types from the shared package', () => {
    expect(isChannelType('portal')).toBe(true);
    expect(isChannelType('fax')).toBe(false);
  });
});
