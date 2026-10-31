import { act, render, screen } from '@testing-library/react';
import { DENSITY_STORAGE_KEY, THEME_STORAGE_KEY } from '@watchtower/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getPreferences,
  resetPreferencesCache,
  setDensity,
  setSingleKeyShortcuts,
  setTheme,
  SINGLE_KEY_STORAGE_KEY,
  usePreferences,
} from './preferences';

function Probe() {
  const { theme, density, singleKeyShortcuts } = usePreferences();
  return (
    <>
      <p data-testid="probe">{`${theme}/${density}`}</p>
      <p data-testid="keys">{singleKeyShortcuts ? 'on' : 'off'}</p>
    </>
  );
}

const html = () => document.documentElement;

beforeEach(() => {
  localStorage.clear();
  resetPreferencesCache();
});

afterEach(() => {
  html().removeAttribute('data-theme');
  html().removeAttribute('data-density');
});

describe('preferences', () => {
  it('starts as system theme and comfortable density', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('system/comfortable');
  });

  it('reads what was saved earlier', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    localStorage.setItem(DENSITY_STORAGE_KEY, 'compact');
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('dark/compact');
  });

  it('ignores a corrupt saved value', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'neon');
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('system/comfortable');
  });

  it('applies the theme to <html>, saves it and updates readers', () => {
    render(<Probe />);
    act(() => {
      setTheme('dark');
    });
    expect(html()).toHaveAttribute('data-theme', 'dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(screen.getByTestId('probe')).toHaveTextContent('dark/comfortable');
  });

  it('removes the override when the user goes back to "system"', () => {
    render(<Probe />);
    act(() => {
      setTheme('light');
    });
    expect(html()).toHaveAttribute('data-theme', 'light');
    act(() => {
      setTheme('system');
    });
    expect(html()).not.toHaveAttribute('data-theme');
  });

  it('applies density to <html>', () => {
    render(<Probe />);
    act(() => {
      setDensity('compact');
    });
    expect(html()).toHaveAttribute('data-density', 'compact');
    act(() => {
      setDensity('comfortable');
    });
    expect(html()).not.toHaveAttribute('data-density');
  });

  it('keeps working in memory when storage is blocked', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      render(<Probe />);
      act(() => {
        setTheme('dark');
      });
      expect(screen.getByTestId('probe')).toHaveTextContent('dark/comfortable');
    } finally {
      spy.mockRestore();
    }
  });

  describe('single-key shortcuts (WCAG 2.1.4)', () => {
    it('are on by default', () => {
      render(<Probe />);
      expect(screen.getByTestId('keys')).toHaveTextContent('on');
      expect(getPreferences().singleKeyShortcuts).toBe(true);
    });

    it('can be turned off, are saved and survive a reload', () => {
      render(<Probe />);
      act(() => {
        setSingleKeyShortcuts(false);
      });
      expect(screen.getByTestId('keys')).toHaveTextContent('off');
      expect(localStorage.getItem(SINGLE_KEY_STORAGE_KEY)).toBe('off');

      resetPreferencesCache();
      expect(getPreferences().singleKeyShortcuts).toBe(false);

      act(() => {
        setSingleKeyShortcuts(true);
      });
      expect(localStorage.getItem(SINGLE_KEY_STORAGE_KEY)).toBe('on');
    });

    it('does not change the other preferences when toggled', () => {
      render(<Probe />);
      act(() => {
        setTheme('dark');
        setSingleKeyShortcuts(false);
      });
      expect(screen.getByTestId('probe')).toHaveTextContent('dark/comfortable');
    });

    it('treats any value but "off" as on, so a corrupt value fails towards the default', () => {
      localStorage.setItem(SINGLE_KEY_STORAGE_KEY, 'nope');
      expect(getPreferences().singleKeyShortcuts).toBe(true);
    });

    it('follows a change made in another tab', () => {
      render(<Probe />);
      act(() => {
        localStorage.setItem(SINGLE_KEY_STORAGE_KEY, 'off');
        window.dispatchEvent(new StorageEvent('storage', { key: SINGLE_KEY_STORAGE_KEY }));
      });
      expect(screen.getByTestId('keys')).toHaveTextContent('off');
    });
  });
});
