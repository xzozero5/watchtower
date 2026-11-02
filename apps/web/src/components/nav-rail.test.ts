import { describe, expect, it } from 'vitest';

import { railLit } from './nav-rail';

describe('rail colour means state (QA-20)', () => {
  it('is neutral unless the page is current or something is waiting', () => {
    expect(railLit(false, 0)).toBe(false);
    expect(railLit(true, 0)).toBe(true);
    expect(railLit(false, 3)).toBe(true);
  });
});
