import { describe, expect, it } from 'vitest';

import { summarizeHidden } from './hidden-matches';

describe('summarizeHidden', () => {
  const shown = new Set(['OPS-1']);

  it('is null when the list already shows every match', () => {
    expect(summarizeHidden([{ key: 'OPS-1', status: 'open' }], shown)).toBeNull();
  });

  it('counts what the list does not show and says whether all of it is finished', () => {
    expect(
      summarizeHidden(
        [
          { key: 'OPS-1', status: 'open' },
          { key: 'OPS-2', status: 'closed' },
          { key: 'OPS-3', status: 'resolved' },
        ],
        shown,
      ),
    ).toEqual({ count: 2, allClosed: true });
    expect(
      summarizeHidden(
        [
          { key: 'OPS-2', status: 'closed' },
          { key: 'OPS-4', status: 'waiting_on_customer' },
        ],
        shown,
      ),
    ).toEqual({ count: 2, allClosed: false });
  });
});
