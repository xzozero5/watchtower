import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetPreferencesCache } from '@/lib/preferences';
import { renderApp } from '@/test-utils';

import { DisplayControls } from './display-controls';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh }),
}));

beforeEach(() => {
  localStorage.clear();
  resetPreferencesCache();
  document.documentElement.removeAttribute('data-theme');
});
afterEach(() => {
  vi.unstubAllGlobals();
  refresh.mockReset();
});

function stubSystemDark(dark: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('prefers-color-scheme: dark') ? dark : true,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
}

describe('DisplayControls (sign-in page and portal)', () => {
  it('shows the theme that is in effect: a system that asks for dark turns the switch on', () => {
    stubSystemDark(true);
    renderApp(<DisplayControls />);
    expect(screen.getByRole('switch', { name: 'Dark theme' })).toBeChecked();
  });

  it('the first press saves the opposite of what is in effect, and a second press goes back', async () => {
    const user = userEvent.setup();
    stubSystemDark(true);
    renderApp(<DisplayControls />);
    await user.click(screen.getByRole('switch', { name: 'Dark theme' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(localStorage.getItem('wt-theme')).toBe('light');
    expect(screen.getByRole('switch', { name: 'Dark theme' })).not.toBeChecked();
    await user.click(screen.getByRole('switch', { name: 'Dark theme' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  it('has two flags named in their own language, and choosing one saves the cookie and refreshes', async () => {
    const user = userEvent.setup();
    stubSystemDark(false);
    renderApp(<DisplayControls />);
    const group = screen.getByRole('radiogroup', { name: 'Language' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'English' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'ภาษาไทย' })).toHaveAttribute('lang', 'th');
    await user.click(screen.getByRole('radio', { name: 'ภาษาไทย' }));
    expect(document.cookie).toContain('wt-locale=th');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('is named in Thai on a Thai page', () => {
    stubSystemDark(false);
    renderApp(<DisplayControls />, { locale: 'th' });
    expect(screen.getByRole('switch', { name: 'ธีมมืด' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'ภาษา' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'ภาษาไทย' })).toBeChecked();
  });
});
