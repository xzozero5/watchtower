import { describe, expect, it } from 'vitest';

import { packageName } from './index.js';

describe('@watchtower/ui', () => {
  it('exposes its name', () => {
    expect(packageName).toBe('@watchtower/ui');
  });
});
