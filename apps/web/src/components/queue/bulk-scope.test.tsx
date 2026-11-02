import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderApp } from '@/test-utils';

import { BulkBar } from './bulk-bar';

const people = [
  { id: 'u1', name: 'Mana' },
  { id: 'u2', name: 'Pim' },
];

const bar = (scope: 'queue' | 'all_staff' | undefined) => (
  <BulkBar
    count={2}
    busy={false}
    assignees={people}
    scope={scope}
    me={null}
    onApply={vi.fn()}
    onClear={vi.fn()}
  />
);

describe('bulk assign scope', () => {
  it('says the list is every active staff member when the api had no queue to narrow by', () => {
    renderApp(bar('all_staff'));
    expect(screen.getByText(/Showing all active staff/)).toBeVisible();
  });

  it('says nothing when the list is the queue', () => {
    renderApp(bar('queue'));
    expect(screen.queryByText(/Showing all active staff/)).toBeNull();
  });
});
