import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DENSITY_STORAGE_KEY,
  parseDensity,
  parseThemePreference,
  THEME_STORAGE_KEY,
  themeInitScript,
} from './preferences.js';

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-density');
});

describe('parsing stored preferences', () => {
  it('accepts known values and falls back for anything else', () => {
    expect(parseThemePreference('dark')).toBe('dark');
    expect(parseThemePreference('light')).toBe('light');
    expect(parseThemePreference('purple')).toBe('system');
    expect(parseThemePreference(null)).toBe('system');
    expect(parseDensity('compact')).toBe('compact');
    expect(parseDensity('huge')).toBe('comfortable');
    expect(parseDensity(undefined)).toBe('comfortable');
  });
});

describe('themeInitScript', () => {
  const run = () => {
    // The script is meant to run as an inline <script>, so evaluating it here is the point.
    /* eslint-disable @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call */
    new Function(themeInitScript)();
    /* eslint-enable @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call */
  };

  it('applies a saved theme and density to <html> before paint', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    localStorage.setItem(DENSITY_STORAGE_KEY, 'compact');
    run();
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement).toHaveAttribute('data-density', 'compact');
  });

  it('sets nothing for "system", so the OS preference decides', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'system');
    run();
    expect(document.documentElement).not.toHaveAttribute('data-theme');
    expect(document.documentElement).not.toHaveAttribute('data-density');
  });

  it('ignores unexpected stored values', () => {
    localStorage.setItem(THEME_STORAGE_KEY, '"><script>');
    run();
    expect(document.documentElement).not.toHaveAttribute('data-theme');
  });

  it('does not throw when storage is blocked', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      expect(run).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
