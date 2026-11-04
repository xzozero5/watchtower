import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Role } from '@watchtower/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthGate } from '@/components/auth-gate';
import { ConsoleShell } from '@/components/console-shell';
import { resetPreferencesCache } from '@/lib/preferences';
import { RealtimeProvider } from '@/lib/realtime/realtime-provider';
import { consoleApi } from '@/test/console-api';
import { notificationEvent, socketFactory } from '@/test/fake-socket';
import { makeNotification, notificationRoutes } from '@/test/notification-fixtures';
import { renderApp } from '@/test-utils';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/home',
}));

beforeEach(() => {
  localStorage.clear();
  resetPreferencesCache();
  document.title = 'Watchtower';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function renderShell() {
  const sockets = socketFactory();
  const view = renderApp(
    <AuthGate>
      <RealtimeProvider createSocket={sockets.create}>
        <ConsoleShell
          destination="home"
          skipTo={{ href: '#main-content', label: 'app.skipToMain' }}
        >
          <p>Page</p>
        </ConsoleShell>
      </RealtimeProvider>
    </AuthGate>,
  );
  return { ...view, sockets };
}

function setup(
  items = [makeNotification(1), makeNotification(2, { readAt: new Date().toISOString() })],
  role: Role = 'agent',
) {
  const api = consoleApi({ role, overrides: notificationRoutes(items) });
  const view = renderShell();
  return { ...view, api, items };
}

const bell = () => screen.findByTestId('notification-bell');

describe('the bell', () => {
  it('says how many are unread in its name and in a badge, and opens a panel of the newest', async () => {
    const user = userEvent.setup();
    setup([
      makeNotification(1),
      makeNotification(2),
      makeNotification(3, { kind: 'ticket.assigned', severity: 'normal' }),
    ]);

    const button = await bell();
    await waitFor(() => {
      expect(button).toHaveAccessibleName('Notifications 3 unread');
    });
    expect(screen.getByTestId('notification-badge')).toHaveTextContent('3');

    await user.click(button);
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    const rows = await within(panel).findAllByTestId('notification-item');
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getAllByText('P1 ticket OPS-1')[0]).toBeVisible();
    expect(
      within(rows[2] as HTMLElement).getAllByText('OPS-3 was assigned to you')[0],
    ).toBeVisible();
    // Unread is a word for assistive technology, not only a dot.
    expect(within(rows[0] as HTMLElement).getByText(/Unread/)).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: /P1 ticket OPS-1/ })).toHaveAttribute(
      'href',
      '/?ticket=OPS-1',
    );
  });

  it('opens from the keyboard and closes on Escape', async () => {
    const user = userEvent.setup();
    setup();
    const button = await bell();
    button.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Notifications' })).toBeVisible();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument();
    });
  });

  it('marks one read, then all, and the count follows', async () => {
    const user = userEvent.setup();
    const { items } = setup([makeNotification(1), makeNotification(2), makeNotification(3)]);
    await user.click(await bell());
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    await within(panel).findAllByTestId('notification-item');

    await user.click(
      within(panel).getAllByRole('button', { name: /^Mark read/ })[0] as HTMLElement,
    );
    await waitFor(() => {
      expect(items.filter((item) => item.readAt === null)).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId('notification-badge')).toHaveTextContent('2');
    });

    await user.click(within(panel).getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => {
      expect(items.every((item) => item.readAt !== null)).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument();
    });
    expect(within(panel).getByRole('button', { name: 'Mark all read' })).toBeDisabled();
  });

  it('says so when there is nothing, and when the list cannot be read', async () => {
    const user = userEvent.setup();
    setup([]);
    await user.click(await bell());
    expect(await screen.findByText('You are all caught up.')).toBeVisible();
  });

  it('shows an error with a way to try again', async () => {
    const user = userEvent.setup();
    consoleApi({
      overrides: {
        'GET /v1/notifications': {
          status: 500,
          json: { statusCode: 500, code: 'x', message: 'x' },
        },
      },
    });
    renderShell();
    await user.click(await bell());
    const alert = await screen.findByText('Notifications are not available.');
    expect(alert).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('lets a person turn a kind off, but not P1', async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await user.click(await bell());
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    await user.click(within(panel).getByRole('button', { name: 'Settings' }));

    const p1 = await within(panel).findByRole('checkbox', { name: /P1 tickets/ });
    expect(p1).toBeChecked();
    expect(p1).toBeDisabled();
    const assigned = within(panel).getByRole('checkbox', { name: /Tickets assigned to me/ });
    await user.click(assigned);
    await waitFor(() => {
      expect(api.callsTo('/v1/notifications/preferences', 'PUT')).toHaveLength(1);
    });
    expect(api.callsTo('/v1/notifications/preferences', 'PUT')[0]?.body).toEqual({
      preferences: [{ kind: 'ticket.assigned', inApp: false }],
    });
    await waitFor(() => {
      expect(assigned).not.toBeChecked();
    });
  });

  it('re-reads when a notification event arrives on the socket', async () => {
    const { api, sockets, items } = setup([]);
    await bell();
    await waitFor(() => {
      expect(sockets.sockets).toHaveLength(1);
    });
    await act(async () => {
      sockets.last.ready();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(api.callsTo('/v1/notifications', 'GET').length).toBeGreaterThan(0);
    });
    const before = api.callsTo('/v1/notifications', 'GET').length;

    items.push(makeNotification(7));
    await act(async () => {
      sockets.last.event(notificationEvent({ ticketKey: 'OPS-7' }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId('notification-badge')).toHaveTextContent('1');
    });
    expect(api.callsTo('/v1/notifications', 'GET').length).toBeGreaterThan(before);
  });

  it('is not shown to a client (no staff permission)', async () => {
    consoleApi({ role: 'client', overrides: notificationRoutes([]) });
    renderShell();
    await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(screen.queryByTestId('notification-bell')).not.toBeInTheDocument();
    expect(screen.queryByTestId('critical-banner')).not.toBeInTheDocument();
  });
});

describe('the P1 banner', () => {
  it('stays away when there is no unread P1, even if other notifications are unread', async () => {
    setup([makeNotification(1, { kind: 'ticket.assigned', severity: 'normal' })]);
    await bell();
    await waitFor(() => {
      expect(screen.getByTestId('notification-badge')).toHaveTextContent('1');
    });
    expect(screen.queryByTestId('critical-banner')).not.toBeInTheDocument();
    expect(document.title).toBe('Watchtower');
  });

  it('shows the ticket in words and icon, announces itself and prefixes the tab title', async () => {
    setup([makeNotification(1)]);
    const banner = await screen.findByTestId('critical-banner');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveAccessibleName('Critical alert');
    // Not colour alone: the words, the key and the subject.
    expect(within(banner).getByText('P1 Critical')).toBeVisible();
    expect(within(banner).getByText('OPS-1')).toBeVisible();
    expect(within(banner).getByText(/Subject of OPS-1/)).toBeVisible();
    expect(banner.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    // The one colour pair the design tokens test for contrast (P1 foreground on P1 background).
    expect(banner.className).toContain('bg-sev-p1-bg');
    expect(banner.className).toContain('text-sev-p1-fg');
    await waitFor(() => {
      expect(document.title).toBe('(P1) Watchtower');
    });
    expect(within(banner).getByRole('link', { name: 'Open ticket OPS-1' })).toHaveAttribute(
      'href',
      '/?ticket=OPS-1',
    );
  });

  it('cannot be dismissed, only acknowledged, and then it goes and the title is restored', async () => {
    const user = userEvent.setup();
    const { items, api } = setup([makeNotification(1)]);
    const banner = await screen.findByTestId('critical-banner');
    expect(within(banner).queryByRole('button', { name: /close|dismiss|hide/i })).toBeNull();

    await user.click(within(banner).getByRole('button', { name: 'Acknowledge OPS-1' }));
    await waitFor(() => {
      expect(screen.queryByTestId('critical-banner')).not.toBeInTheDocument();
    });
    expect(items[0]?.readAt).not.toBeNull();
    expect(api.callsTo(`/v1/notifications/${items[0]?.id ?? ''}/read`, 'POST')).toHaveLength(1);
    expect(document.title).toBe('Watchtower');
  });

  it('opening the ticket acknowledges it', async () => {
    const user = userEvent.setup();
    const { items } = setup([makeNotification(1)]);
    const banner = await screen.findByTestId('critical-banner');
    await user.click(within(banner).getByRole('link', { name: 'Open ticket OPS-1' }));
    await waitFor(() => {
      expect(items[0]?.readAt).not.toBeNull();
    });
  });

  it('is one banner: the others are behind "+N more P1", newest first', async () => {
    const user = userEvent.setup();
    setup([makeNotification(1), makeNotification(2), makeNotification(3)]);
    const banner = await screen.findByTestId('critical-banner');
    expect(screen.getAllByTestId('critical-banner')).toHaveLength(1);
    const more = within(banner).getByRole('button', { name: /\+2 more P1/ });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(within(banner).getByText('OPS-1')).toBeVisible();
    expect(within(banner).getByText('OPS-2')).not.toBeVisible();

    await user.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(within(banner).getByText('OPS-2')).toBeVisible();
    expect(within(banner).getByText('OPS-3')).toBeVisible();
    expect(within(banner).getAllByTestId('critical-item')).toHaveLength(3);
  });

  it('appears when a P1 notification arrives live', async () => {
    const { sockets, items } = setup([]);
    await bell();
    await waitFor(() => {
      expect(sockets.sockets).toHaveLength(1);
    });
    await act(async () => {
      sockets.last.ready();
      await Promise.resolve();
    });
    expect(screen.queryByTestId('critical-banner')).not.toBeInTheDocument();
    items.push(makeNotification(9));
    await act(async () => {
      sockets.last.event(notificationEvent({ ticketKey: 'OPS-9' }));
      await Promise.resolve();
    });
    expect(await screen.findByTestId('critical-banner')).toBeVisible();
  });
});
