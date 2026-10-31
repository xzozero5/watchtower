import { DEFAULT_DENSITY, DENSITIES, type Density } from '../tokens/density.js';

/** `system` follows the OS (prefers-color-scheme). The other two are the user's override. */
export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

export const THEME_STORAGE_KEY = 'wt-theme';
export const DENSITY_STORAGE_KEY = 'wt-density';

export function parseThemePreference(value: unknown): ThemePreference {
  return THEME_PREFERENCES.find((theme) => theme === value) ?? DEFAULT_THEME_PREFERENCE;
}

export function parseDensity(value: unknown): Density {
  return DENSITIES.find((density) => density === value) ?? DEFAULT_DENSITY;
}

/**
 * Inline script for `<head>`. It applies the saved theme and density to `<html>` before first
 * paint so a dark-mode user never sees a white flash. `system` sets no attribute, which lets the
 * `prefers-color-scheme` media query in tokens.css decide.
 */
export const themeInitScript = `(function(){try{var d=document.documentElement;var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==='light'||t==='dark'){d.setAttribute('data-theme',t)}var n=localStorage.getItem(${JSON.stringify(DENSITY_STORAGE_KEY)});if(n==='compact'){d.setAttribute('data-density',n)}}catch(e){}})();`;
