import { describe, expect, it } from 'vitest';

import { pageCount } from './rail-counts';

describe('pageCount', () => {
  it('counts the items and flags a page that has more', () => {
    expect(pageCount({ items: [], nextCursor: null })).toEqual({ count: 0, more: false });
    expect(pageCount({ items: [1, 2], nextCursor: 'c' })).toEqual({ count: 2, more: true });
  });
});
