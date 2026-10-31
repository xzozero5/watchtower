import { act, render, screen } from '@testing-library/react';
import { DENSITY_STORAGE_KEY, THEME_STORAGE_KEY } from '@watchtower/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetPreferencesCache, setDensity, setTheme, usePreferences } from './preferences';

function Probe() {
  const { theme, density } = usePreferences();
  return <p data-testid="probe">{`${theme}/${density}`}</p>;
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
});
