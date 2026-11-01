import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetPreferencesCache } from '@/lib/preferences';
import { renderWorkspace } from '@/test-utils';
import { workspaceApi } from '@/test/scenarios';

const refresh = vi.fn();
const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, replace }) }));

beforeEach(() => {
  localStorage.clear();
  resetPreferencesCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  refresh.mockReset();
  replace.mockReset();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-density');
  document.cookie = 'wt-locale=; Max-Age=0; Path=/';
});

/**
 * Chooses a menu item with the keyboard (focus, then Enter). Radix menus in jsdom ignore the
 * synthetic pointer click on an item; the e2e tests cover the mouse in a real browser.
 */
async function choose(user: ReturnType<typeof userEvent.setup>, item: HTMLElement) {
  item.focus();
  await user.keyboard('{Enter}');
}

async function openWorkspace(options: Parameters<typeof renderWorkspace>[0] = {}) {
  const view = renderWorkspace(options);
  await screen.findByRole('region', { name: options.locale === 'th' ? 'คิวงาน' : 'Queue' });
  return view;
}

describe('AppShell for staff', () => {
  it('shows the three panes: the queue with tickets, an empty conversation, the evidence panel', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();
    const queue = screen.getByRole('region', { name: 'Queue' });
    const conversation = screen.getByRole('region', { name: 'Conversation' });
    const assistant = screen.getByRole('region', { name: 'Details & AI' });

    expect(await within(queue).findByText('Cannot log in')).toBeVisible();
    expect(within(conversation).getByText('Select a ticket')).toBeVisible();
    // The panel opens on Details until the AI brings evidence; Evidence is the first tab.
    expect(within(assistant).getByText('Select a ticket to see its details here.')).toBeVisible();
    expect(
      within(assistant)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Evidence', 'Details', 'Customer']);
    await user.click(within(assistant).getByRole('tab', { name: 'Evidence' }));
    expect(within(assistant).getByText('Select a ticket to see its details here.')).toBeVisible();
  });

  it('keeps the panes in reading order so they stack correctly on a narrow screen', async () => {
    workspaceApi();
    await openWorkspace();
    const ids = screen
      .getAllByRole('region')
      .map((region) => region.getAttribute('id'))
      .filter((id) => id?.startsWith('pane-'));
    expect(ids).toEqual(['pane-queue', 'pane-conversation', 'pane-assistant']);
  });

  it('has a main landmark, a banner and a skip link', async () => {
    workspaceApi();
    await openWorkspace();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skip to the conversation' })).toHaveAttribute(
      'href',
      '#pane-conversation',
    );
  });

  it('renders the whole screen in Thai', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace({ locale: 'th' });
    await user.click(screen.getByRole('tab', { name: 'หลักฐาน' }));
    expect(screen.getByRole('region', { name: 'บทสนทนา' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'รายละเอียดและ AI' })).toBeInTheDocument();
    expect(screen.getByText('เลือก ticket เพื่อดูรายละเอียดที่นี่')).toBeInTheDocument();
    expect(screen.queryByText('Select a ticket')).not.toBeInTheDocument();
  });

  it('lists severity P1 to P4, each with icon, code and label', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();
    await user.click(screen.getByText('Severity key'));
    const key = screen.getByText('Severity key').closest('details');
    if (!key) throw new Error('severity key not found');
    for (const [code, label] of [
      ['P1', 'Critical'],
      ['P2', 'High'],
      ['P3', 'Medium'],
      ['P4', 'Low'],
    ] as const) {
      expect(within(key).getByText(code)).toBeVisible();
      expect(within(key).getByText(label)).toBeVisible();
    }
  });

  it('shows who is signed in and signs out, then the gate sends the browser to the login page', async () => {
    const user = userEvent.setup();
    const api = workspaceApi({ overrides: { 'POST /v1/auth/logout': { status: 204 } } });
    await openWorkspace();
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(await screen.findByText('Alex Agent')).toBeVisible();
    expect(screen.getByText(/agent@example.com · Agent/)).toBeVisible();

    await choose(user, screen.getByRole('menuitem', { name: 'Sign out' }));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/login');
    });
    expect(api.callsTo('/v1/auth/logout', 'POST')).toHaveLength(1);
  });

  it('opens the command palette with Ctrl+K and from the button', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Open command palette/ }));
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
  });

  it('changes the theme from the palette and from the account menu', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();

    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    await user.type(await screen.findByRole('combobox', { name: 'Command palette' }), 'dark');
    await user.keyboard('{Enter}');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');

    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Theme' }));
    expect(await screen.findByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await choose(user, screen.getByRole('menuitemradio', { name: 'Light' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');

    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Density' }));
    await choose(user, await screen.findByRole('menuitemradio', { name: 'Compact' }));
    expect(document.documentElement).toHaveAttribute('data-density', 'compact');
  });

  it('turns single-key shortcuts off and on from the account menu', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    const item = await screen.findByRole('menuitemcheckbox', { name: 'Single-key shortcuts' });
    expect(item).toHaveAttribute('aria-checked', 'true');
    await choose(user, item);
    expect(localStorage.getItem('wt-single-key-shortcuts')).toBe('off');
  });

  it('switches language by saving a cookie and refreshing the server render', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Language' }));
    await choose(user, await screen.findByRole('menuitemradio', { name: 'ไทย' }));
    expect(document.cookie).toContain('wt-locale=th');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('opens the keyboard map with ? and closes it with Escape', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();
    await user.keyboard('?');
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByText('Next ticket')).toBeVisible();
    expect(within(dialog).getByText('Previous ticket')).toBeVisible();
    expect(within(dialog).getByText('Approve the AI draft (opens a preview)')).toBeVisible();
    // Only the four go-to keys that have no screen yet are marked as not available.
    expect(within(dialog).getAllByText('coming soon')).toHaveLength(4);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not open the keyboard map while typing a question mark in a field', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();
    await user.type(screen.getByRole('searchbox', { name: 'Search tickets' }), '?');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the keyboard map from the palette', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    await user.type(await screen.findByRole('combobox', { name: 'Command palette' }), 'shortcuts');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });
});

describe('AI assistant drawer (768 to 1023 px)', () => {
  // jsdom applies no CSS, so these tests cover the behaviour (state, focus, keys); the e2e tests
  // check the layout at real widths.
  it('opens from a button, moves focus into the drawer, closes with Escape and returns focus', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();
    const toggle = screen.getByRole('button', { name: 'Details & AI' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'pane-assistant');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const close = screen.getByRole('button', { name: 'Close the details panel' });
    expect(close).toHaveFocus();
    // A plain region, not a dialog: the conversation stays readable and reachable.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
  });

  it('closes with its own button', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openWorkspace();
    await user.click(screen.getByRole('button', { name: 'Details & AI' }));
    await user.click(screen.getByRole('button', { name: 'Close the details panel' }));
    expect(screen.getByRole('button', { name: 'Details & AI' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('is hidden by CSS from 1024 px up and only between 768 and 1023 px', async () => {
    workspaceApi();
    await openWorkspace();
    expect(screen.getByRole('button', { name: 'Details & AI' }).className).toContain(
      'md:max-lg:inline-flex',
    );
    expect(document.getElementById('pane-assistant')?.className).toContain('md:max-lg:hidden');
  });

  it('is not offered to a customer', async () => {
    workspaceApi({ role: 'client' });
    await openWorkspace();
    expect(screen.queryByRole('button', { name: 'Details & AI' })).not.toBeInTheDocument();
  });
});

describe('shortcuts on a Thai keyboard layout', () => {
  it('J and K move through the queue by physical key, and ? opens the map', async () => {
    workspaceApi();
    await openWorkspace();
    await screen.findByText('Cannot log in');

    // Thai layout: the physical J key types a different character.
    fireEvent.keyDown(document.body, { key: '\u0e48', code: 'KeyJ' });
    expect(await screen.findByRole('option', { name: /OPS-1/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.keyDown(document.body, { key: '\u0e48', code: 'KeyJ' });
    expect(screen.getByRole('option', { name: /OPS-2/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(document.body, { key: '\u0e41', code: 'KeyK' });
    expect(screen.getByRole('option', { name: /OPS-1/ })).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(document.body, { key: '\u0e22', code: 'Slash', shiftKey: true });
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  it('the command palette opens with Ctrl+K on the physical key too', async () => {
    workspaceApi();
    await openWorkspace();
    fireEvent.keyDown(document.body, { key: '\u0e46', code: 'KeyK', ctrlKey: true });
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
  });
});

describe('AppShell for a customer', () => {
  it('shows two panes and no AI assistant, and no staff-only filters', async () => {
    const user = userEvent.setup();
    workspaceApi({ role: 'client' });
    renderWorkspace();
    await screen.findByRole('region', { name: 'Queue' });

    expect(screen.queryByRole('region', { name: 'Details & AI' })).not.toBeInTheDocument();
    expect(
      screen
        .getAllByRole('region')
        .map((region) => region.id)
        .filter((id) => id.startsWith('pane-')),
    ).toEqual(['pane-queue', 'pane-conversation']);
    expect(await screen.findByText('Customer subject 1')).toBeVisible();

    await user.click(screen.getByRole('button', { name: /Filters/ }));
    expect(screen.queryByLabelText('Assignee')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Overdue only')).not.toBeInTheDocument();
  });
});
