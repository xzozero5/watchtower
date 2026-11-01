import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DENSITY_STORAGE_KEY } from '@watchtower/ui';

import { resetPreferencesCache } from '@/lib/preferences';
import { renderWorkspace } from '@/test-utils';
import { makeTicket } from '@/test/fixtures';
import { workspaceApi } from '@/test/scenarios';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

beforeEach(() => {
  localStorage.clear();
  resetPreferencesCache();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const board = [
  makeTicket(1, {
    subject: 'Re: login',
    ai: { state: 'draft_ready', summary: 'Locked out after a reset' },
  }),
  makeTicket(2, {
    subject: 'Export',
    ai: { state: 'investigating', summary: 'Export fails for one customer' },
  }),
  makeTicket(3, { subject: 'Invoice question', status: 'waiting_on_customer' }),
  makeTicket(4, {
    subject: 'Webhook',
    ai: { state: 'classified', summary: 'Webhook retries exhausted' },
    firstResponseDueAt: '2026-01-01T00:00:00.000Z',
  }),
  makeTicket(5, { subject: 'Old news', status: 'resolved' }),
];

async function openBoard() {
  workspaceApi({ tickets: board });
  const view = renderWorkspace();
  const queue = await screen.findByRole('region', { name: 'Queue' });
  await within(queue).findByText('Locked out after a reset');
  return { ...view, queue };
}

const sectionOf = (key: string) =>
  screen.getByRole('option', { name: new RegExp(key) }).closest('section')?.dataset.group;

describe('triage board', () => {
  it('groups tickets into Needs you, AI working and Waiting, each with a count', async () => {
    const { queue } = await openBoard();
    expect(sectionOf('OPS-1')).toBe('needsYou'); // draft ready
    expect(sectionOf('OPS-4')).toBe('needsYou'); // classified, but the SLA is breached
    expect(sectionOf('OPS-2')).toBe('aiWorking');
    expect(sectionOf('OPS-3')).toBe('waiting');

    const needsYou = within(queue).getByRole('button', { name: /^Needs you/ });
    expect(needsYou).toHaveTextContent('Needs you2');
    expect(needsYou).toHaveAttribute('aria-expanded', 'true');
    expect(within(queue).getByRole('button', { name: /^AI working/ })).toHaveTextContent(
      'AI working1',
    );
    expect(within(queue).getByRole('button', { name: /^Waiting/ })).toHaveTextContent('Waiting1');
  });

  it('keeps Done folded at first, with its rows out of the list', async () => {
    const user = userEvent.setup();
    const { queue } = await openBoard();
    const done = within(queue).getByRole('button', { name: /^Done/ });
    expect(done).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('option', { name: /OPS-5/ })).toBeNull();
    await user.click(done);
    expect(await screen.findByRole('option', { name: /OPS-5/ })).toBeVisible();
  });

  it('shows the AI summary, the state in words and the priority on a row', async () => {
    await openBoard();
    const row = screen.getByRole('option', { name: /OPS-1/ });
    expect(within(row).getByText('Locked out after a reset')).toBeVisible();
    expect(within(row).getByText('Draft ready')).toBeVisible();
    expect(within(row).getByText('P3')).toBeVisible();
    expect(within(row).queryByText('Re: login')).toBeNull();
  });

  it('folds a section with its header button, which the keyboard reaches with Tab and Enter', async () => {
    const user = userEvent.setup();
    const { queue } = await openBoard();
    const header = within(queue).getByRole('button', { name: /^AI working/ });
    header.focus();
    await user.keyboard('{Enter}');
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('option', { name: /OPS-2/ })).toBeNull();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('option', { name: /OPS-2/ })).toBeVisible();
  });

  it('J and K walk the board top to bottom as drawn, across sections, skipping a folded one', async () => {
    const user = userEvent.setup();
    const { queue } = await openBoard();
    const selected = () =>
      document
        .querySelector('[role="option"][aria-selected="true"]')
        ?.getAttribute('data-ticket-key');

    await user.keyboard('j');
    expect(selected()).toBe('OPS-1');
    await user.keyboard('j');
    expect(selected()).toBe('OPS-4');
    await user.keyboard('j');
    expect(selected()).toBe('OPS-2'); // first row of the next section
    // The keyboard follows into that section's listbox.
    expect(screen.getByRole('listbox', { name: 'AI working' })).toHaveFocus();
    await user.keyboard('j');
    expect(selected()).toBe('OPS-3');
    await user.keyboard('jj');
    expect(selected()).toBe('OPS-3'); // Done is folded: the board ends here
    await user.keyboard('k');
    expect(selected()).toBe('OPS-2');

    // Fold "Waiting" and the walk skips it.
    await user.click(within(queue).getByRole('button', { name: /^Waiting/ }));
    await user.keyboard('j');
    expect(selected()).toBe('OPS-2');
  });

  it('keeps the open ticket where it was when it changes section (no reflow under the cursor)', async () => {
    const user = userEvent.setup();
    await openBoard();
    await user.click(screen.getByRole('option', { name: /OPS-3/ }));
    expect(sectionOf('OPS-3')).toBe('waiting');
    await user.click(screen.getByRole('option', { name: /OPS-1/ }));
    expect(sectionOf('OPS-1')).toBe('needsYou');
  });

  it('lists every section as a labelled listbox with one tab stop', async () => {
    await openBoard();
    const boxes = screen.getAllByRole('listbox');
    expect(boxes.map((box) => box.getAttribute('aria-label'))).toEqual([
      'Needs you',
      'AI working',
      'Waiting',
    ]);
    expect(boxes.filter((box) => box.getAttribute('tabindex') === '0')).toHaveLength(1);
  });

  it('shows one line per ticket in compact density', async () => {
    localStorage.setItem(DENSITY_STORAGE_KEY, 'compact');
    resetPreferencesCache();
    await openBoard();
    const row = screen.getByRole('option', { name: /OPS-1/ });
    expect(row.className).toContain('min-h-10');
    // Compact: the AI state is an icon (words for screen readers only), no intent chip.
    expect(within(row).getByText('Draft ready')).toHaveClass('sr-only');
    expect(within(row).queryByText('Login issue')).toBeNull();
  });

  it('shows the intent chip in comfortable density', async () => {
    await openBoard();
    expect(
      within(screen.getByRole('option', { name: /OPS-1/ })).getByText('Login issue'),
    ).toBeVisible();
  });
});
