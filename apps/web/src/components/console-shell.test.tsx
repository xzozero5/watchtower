import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminLayout } from '@/components/admin/admin-layout';
import { AuthGate } from '@/components/auth-gate';
import { ConsoleShell } from '@/components/console-shell';
import type { RailDestination } from '@/components/nav-rail';
import { resetPreferencesCache } from '@/lib/preferences';
import { RealtimeProvider } from '@/lib/realtime/realtime-provider';
import { consoleApi, makeAutonomy } from '@/test/console-fixtures';
import { socketFactory } from '@/test/fake-socket';
import { renderApp } from '@/test-utils';
import type { Role } from '@watchtower/shared';

const push = vi.fn();
let pathname = '/home';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => pathname,
}));

beforeEach(() => {
  localStorage.clear();
  resetPreferencesCache();
  pathname = '/home';
});
afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

const AT = '2026-11-02T03:00:00.000Z';

function renderShell(
  destination: Exclude<RailDestination, never> = 'home',
  children = <p>Page</p>,
) {
  const sockets = socketFactory();
  return renderApp(
    <AuthGate>
      <RealtimeProvider createSocket={sockets.create}>
        <ConsoleShell
          destination={destination}
          skipTo={{ href: '#main-content', label: 'app.skipToMain' }}
        >
          {children}
        </ConsoleShell>
      </RealtimeProvider>
    </AuthGate>,
  );
}

async function ready() {
  await screen.findByRole('navigation', { name: 'Main navigation' });
}

describe('rail entries', () => {
  it.each<[Role, boolean, boolean]>([
    ['head', true, true],
    ['lead', true, true],
    ['agent', false, false],
  ])('%s: Home %s, Admin %s', async (role, home, admin) => {
    consoleApi({ role });
    renderShell();
    await ready();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(nav).queryByRole('link', { name: 'Home' }) !== null).toBe(home);
    expect(within(nav).queryByRole('link', { name: 'Admin' }) !== null).toBe(admin);
  });

  it('marks the current page, and Admin opens the first section the person may use', async () => {
    consoleApi({ role: 'lead' });
    renderShell('home');
    await ready();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Admin' })).not.toHaveAttribute('aria-current');
    expect(within(nav).getByRole('link', { name: 'Admin' })).toHaveAttribute(
      'href',
      '/admin/users',
    );
    expect(within(nav).getByRole('link', { name: 'Queue' })).toHaveAttribute('href', '/');
  });

  it('has a skip link to the main content', async () => {
    consoleApi();
    renderShell();
    await ready();
    expect(screen.getByRole('link', { name: 'Skip to the content' })).toHaveAttribute(
      'href',
      '#main-content',
    );
  });
});

describe('g d, g a and g q', () => {
  const press = (key: string) => {
    fireEvent.keyDown(document.body, { key, code: `Key${key.toUpperCase()}` });
  };

  it('goes to Home and Admin with two keys, and back to the queue from a console page', async () => {
    consoleApi();
    renderShell();
    await ready();
    press('g');
    press('d');
    expect(push).toHaveBeenLastCalledWith('/home');
    press('g');
    press('a');
    expect(push).toHaveBeenLastCalledWith('/admin/users');
    press('g');
    press('q');
    expect(push).toHaveBeenLastCalledWith('/');
  });

  it('does nothing for a person without Home or Admin', async () => {
    consoleApi({ role: 'agent' });
    renderShell();
    await ready();
    press('g');
    press('d');
    press('g');
    press('a');
    expect(push).not.toHaveBeenCalled();
  });

  it('respects the single-key preference', async () => {
    localStorage.setItem('wt-single-key-shortcuts', 'off');
    resetPreferencesCache();
    consoleApi();
    renderShell();
    await ready();
    press('g');
    press('d');
    expect(push).not.toHaveBeenCalled();
  });

  it('ignores the keys while typing in a field', async () => {
    consoleApi();
    renderShell('home', <input aria-label="Filter" />);
    await ready();
    const input = screen.getByLabelText('Filter');
    input.focus();
    fireEvent.keyDown(input, { key: 'g', code: 'KeyG' });
    fireEvent.keyDown(input, { key: 'd', code: 'KeyD' });
    expect(push).not.toHaveBeenCalled();
  });
});

describe('command palette', () => {
  async function openPalette() {
    const user = userEvent.setup();
    await ready();
    await user.keyboard('{Control>}k{/Control}');
    return { user, dialog: await screen.findByRole('dialog', { name: 'Command palette' }) };
  }

  it('lists the admin sections a lead may open and no AI switch commands', async () => {
    consoleApi({ role: 'lead' });
    renderShell();
    const { user, dialog } = await openPalette();
    await user.type(within(dialog).getByRole('combobox'), 'admin');
    const options = within(dialog)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options.some((text) => text?.startsWith('Go to Admin › Users'))).toBe(true);
    expect(options.some((text) => text?.startsWith('Go to Admin › Audit log'))).toBe(false);
    await user.clear(within(dialog).getByRole('combobox'));
    await user.type(within(dialog).getByRole('combobox'), 'AI:');
    expect(within(dialog).queryByText(/Stop all AI runs/)).not.toBeInTheDocument();
  });

  it('goes to an admin section', async () => {
    consoleApi();
    renderShell();
    const { user, dialog } = await openPalette();
    await user.type(within(dialog).getByRole('combobox'), 'audit');
    await user.keyboard('{Enter}');
    expect(push).toHaveBeenCalledWith('/admin/audit');
  });

  it('only opens the confirm dialog for a switch; nothing is sent until a reason is given', async () => {
    const api = consoleApi();
    renderShell();
    const { user, dialog } = await openPalette();
    await user.type(within(dialog).getByRole('combobox'), 'stop all');
    await user.keyboard('{Enter}');
    const confirm = await screen.findByRole('dialog', { name: 'Stop all AI runs?' });
    expect(within(confirm).getByLabelText(/Reason/)).toHaveFocus();
    expect(api.callsTo('/v1/autonomy/switches', 'POST')).toHaveLength(0);
    await user.keyboard('{Escape}');
    expect(api.callsTo('/v1/autonomy/switches', 'POST')).toHaveLength(0);
  });

  it('offers to resume when the AI is stopped', async () => {
    consoleApi({
      autonomy: makeAutonomy({
        switches: [
          { key: 'ai_stage_cap_pinned', on: true, reason: 'x', changedBy: null, changedAt: AT },
          { key: 'ai_kill_switch', on: true, reason: 'x', changedBy: null, changedAt: AT },
        ],
      }),
    });
    renderShell();
    await screen.findByTestId('ai-paused-banner');
    const { user, dialog } = await openPalette();
    await user.type(within(dialog).getByRole('combobox'), 'AI:');
    expect(within(dialog).getByText('AI: Resume AI runs…')).toBeVisible();
    expect(within(dialog).getByText('AI: Remove the stage limit…')).toBeVisible();
  });

  it('has no admin group for an agent', async () => {
    consoleApi({ role: 'agent' });
    renderShell();
    const { user, dialog } = await openPalette();
    await user.type(within(dialog).getByRole('combobox'), 'go to');
    expect(within(dialog).queryByText(/Go to Home/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Go to Admin/)).not.toBeInTheDocument();
  });
});

describe('AI paused banner', () => {
  const paused = (name?: string) =>
    makeAutonomy({
      switches: [
        { key: 'ai_stage_cap_pinned', on: false, reason: '', changedBy: null, changedAt: AT },
        {
          key: 'ai_kill_switch',
          on: true,
          reason: 'provider outage',
          changedBy: null,
          changedAt: AT,
          ...(name ? { changedByName: name } : {}),
        },
      ],
    });

  it('tells every staff member the AI is paused, with who when the api says', async () => {
    consoleApi({ autonomy: paused('Mana K.') });
    renderShell();
    const banner = await screen.findByTestId('ai-paused-banner');
    expect(banner).toHaveTextContent(/AI paused by Mana K\. at .* — replies are manual\./);
    expect(within(banner).getByRole('link', { name: 'AI controls' })).toHaveAttribute(
      'href',
      '/admin/ai',
    );
    expect(
      within(banner).queryByRole('button', { name: /dismiss|close/i }),
    ).not.toBeInTheDocument();
  });

  it('shows an agent the time only, and no link to controls they cannot use', async () => {
    consoleApi({ role: 'agent', autonomy: paused() });
    renderShell();
    const banner = await screen.findByTestId('ai-paused-banner');
    expect(banner).toHaveTextContent(/AI paused at .* — replies are manual\./);
    expect(within(banner).queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows no banner for the stage limit alone', async () => {
    consoleApi({
      autonomy: makeAutonomy({
        switches: [
          { key: 'ai_stage_cap_pinned', on: true, reason: 'x', changedBy: null, changedAt: AT },
          { key: 'ai_kill_switch', on: false, reason: '', changedBy: null, changedAt: AT },
        ],
      }),
    });
    renderShell();
    await ready();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByTestId('ai-paused-banner')).not.toBeInTheDocument();
  });

  it('shows nothing when the status cannot be read', async () => {
    consoleApi({ overrides: { 'GET /v1/autonomy': { status: 500, json: {} } } });
    renderShell();
    await ready();
    expect(screen.queryByTestId('ai-paused-banner')).not.toBeInTheDocument();
  });
});

describe('admin layout', () => {
  it('lists only the sections the role may open and marks the current one', async () => {
    pathname = '/admin/intents';
    consoleApi({ role: 'lead' });
    renderApp(
      <AuthGate>
        <AdminLayout>
          <p>Body</p>
        </AdminLayout>
      </AuthGate>,
    );
    const nav = await screen.findByRole('navigation', { name: 'Admin sections' });
    const names = within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(names).toEqual(['Users', 'Organizations', 'Intents', 'Queues', 'AI controls']);
    expect(within(nav).getByRole('link', { name: 'Intents' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('lists all eight for the head', async () => {
    consoleApi({ role: 'head' });
    renderApp(
      <AuthGate>
        <AdminLayout>
          <p>Body</p>
        </AdminLayout>
      </AuthGate>,
    );
    const nav = await screen.findByRole('navigation', { name: 'Admin sections' });
    expect(within(nav).getAllByRole('link')).toHaveLength(8);
  });

  it('shows the denied page when the role has no admin section', async () => {
    consoleApi({ role: 'agent' });
    renderApp(
      <AuthGate>
        <AdminLayout>
          <p>Body</p>
        </AdminLayout>
      </AuthGate>,
    );
    await waitFor(() => {
      expect(screen.getByText('You don’t have access to this page.')).toBeVisible();
    });
    expect(screen.queryByText('Body')).not.toBeInTheDocument();
  });
});
