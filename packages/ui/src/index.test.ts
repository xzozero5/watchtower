import { describe, expect, it } from 'vitest';

import { cn, packageName } from './index.js';

describe('@watchtower/ui', () => {
  it('exposes its name', () => {
    expect(packageName).toBe('@watchtower/ui');
  });

  it('cn resolves conflicting Tailwind utilities, last one wins', () => {
    expect(cn('px-2 py-1', 'px-4', false, undefined)).toBe('py-1 px-4');
  });
});
