import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetPreferencesCache } from '@/lib/preferences';
import { renderApp } from '@/test-utils';

import { AppShell } from './app-shell';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
  localStorage.clear();
  resetPreferencesCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  refresh.mockReset();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-density');
  document.cookie = 'wt-locale=; Max-Age=0; Path=/';
});

describe('AppShell', () => {
  it('shows the three panes, each with an empty state', () => {
    renderApp(<AppShell />);
    const queue = screen.getByRole('region', { name: 'Queue' });
    const conversation = screen.getByRole('region', { name: 'Conversation' });
    const assistant = screen.getByRole('region', { name: 'AI assistant' });

    expect(within(queue).getByText('No tickets yet')).toBeVisible();
    expect(within(conversation).getByText('Select a ticket')).toBeVisible();
    expect(within(assistant).getByText('Nothing to investigate')).toBeVisible();
  });

  it('keeps the panes in reading order so they stack correctly on a narrow screen', () => {
    renderApp(<AppShell />);
    const names = screen.getAllByRole('region').map((region) => region.getAttribute('id'));
    expect(names).toEqual(['pane-queue', 'pane-conversation', 'pane-assistant']);
  });

  it('has a main landmark, a banner and a skip link', () => {
    renderApp(<AppShell />);
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skip to the conversation' })).toHaveAttribute(
      'href',
      '#pane-conversation',
    );
  });

  it('renders the whole screen in Thai', () => {
    renderApp(<AppShell />, { locale: 'th' });
    expect(screen.getByRole('region', { name: 'คิวงาน' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'บทสนทนา' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'ผู้ช่วย AI' })).toBeInTheDocument();
    expect(screen.queryByText('No tickets yet')).not.toBeInTheDocument();
  });

  it('lists severity P1 to P4, each with icon, code and label', async () => {
    const user = userEvent.setup();
    renderApp(<AppShell />);
    await user.click(screen.getByText('Severity key'));
    for (const [code, label] of [
      ['P1', 'Critical'],
      ['P2', 'High'],
      ['P3', 'Medium'],
      ['P4', 'Low'],
    ] as const) {
      expect(screen.getByText(code)).toBeVisible();
      expect(screen.getByText(label)).toBeVisible();
    }
  });

  it('opens the command palette with Ctrl+K and from the button', async () => {
    const user = userEvent.setup();
    renderApp(<AppShell />);
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Open command palette/ }));
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
  });

  it('changes the theme from the palette and from the select', async () => {
    const user = userEvent.setup();
    renderApp(<AppShell />);

    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    await user.type(await screen.findByRole('combobox'), 'dark');
    await user.keyboard('{Enter}');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveValue('dark');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Theme' }), 'light');
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Density' }), 'compact');
    expect(document.documentElement).toHaveAttribute('data-density', 'compact');
  });

  it('switches language by saving a cookie and refreshing the server render', async () => {
    const user = userEvent.setup();
    renderApp(<AppShell />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'th');
    expect(document.cookie).toContain('wt-locale=th');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
