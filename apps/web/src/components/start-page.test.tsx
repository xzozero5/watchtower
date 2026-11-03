import { screen, waitFor, within } from '@testing-library/react';
import type { Role } from '@watchtower/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthGate } from '@/components/auth-gate';
import { ConsoleShell } from '@/components/console-shell';
import { StartPage } from '@/components/start-page';
import { resetRailPreference } from '@/lib/rail-preference';
import { RealtimeProvider } from '@/lib/realtime/realtime-provider';
import { consoleApi } from '@/test/console-api';
import { socketFactory } from '@/test/fake-socket';
import { renderApp } from '@/test-utils';

const replace = vi.fn();
const push = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh: vi.fn() }),
  usePathname: () => '/start',
  useSearchParams: () => new URLSearchParams(search),
}));

beforeEach(() => {
  search = '';
  localStorage.clear();
  resetRailPreference();
});
afterEach(() => {
  vi.unstubAllGlobals();
  replace.mockReset();
  push.mockReset();
});

describe('the landing page after sign-in', () => {
  it.each<[Role, string]>([
    ['agent', '/'],
    ['lead', '/home'],
    ['head', '/home'],
    ['dev', '/'],
    ['client', '/'],
  ])('%s lands on %s with no destination', async (role, path) => {
    consoleApi({ role });
    renderApp(<StartPage />);
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(path);
    });
  });

  it('honours a deep link over the role home', async () => {
    search = 'next=%2F%3Fticket%3DOPS-5';
    consoleApi({ role: 'head' });
    renderApp(<StartPage />);
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/?ticket=OPS-5');
    });
  });

  it.each(['https%3A%2F%2Fevil.example', '%2F%2Fevil.example', '%5Cevil'])(
    'ignores the off-site destination %s',
    async (value) => {
      search = `next=${value}`;
      consoleApi({ role: 'lead' });
      renderApp(<StartPage />);
      await waitFor(() => {
        expect(replace).toHaveBeenCalledWith('/home');
      });
      expect(replace).not.toHaveBeenCalledWith(expect.stringContaining('evil'));
    },
  );
});

describe('the logo in the rail', () => {
  it.each<[Role, string]>([
    ['agent', '/'],
    ['lead', '/home'],
    ['head', '/home'],
    ['dev', '/'],
  ])('%s: links to %s and says where it goes', async (role, href) => {
    consoleApi({ role });
    const sockets = socketFactory();
    renderApp(
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
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(nav).toBeVisible();
    const logo = screen.getByRole('link', { name: 'Watchtower: Go to home' });
    expect(logo).toHaveAttribute('href', href);
    expect(within(logo).queryByRole('img')).toBeNull();
  });
});
