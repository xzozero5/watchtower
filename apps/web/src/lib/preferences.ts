import {
  DENSITY_STORAGE_KEY,
  parseDensity,
  parseThemePreference,
  THEME_STORAGE_KEY,
  type Density,
  type ThemePreference,
} from '@watchtower/ui';
import { useSyncExternalStore } from 'react';

/**
 * WCAG 2.1.4 (Character Key Shortcuts): single-character shortcuts must be switchable off. "on" is
 * the default; only the value "off" turns them off, so a corrupt value fails towards the default.
 * Ctrl/Cmd+K, F6 and Alt+digit use modifiers or non-character keys, which the criterion exempts,
 * so they keep working either way.
 */
export const SINGLE_KEY_STORAGE_KEY = 'wt-single-key-shortcuts';

export interface Preferences {
  readonly theme: ThemePreference;
  readonly density: Density;
  /** False: J, K, C, N, S, /, ., ?, [, ], g-sequences and O do nothing. */
  readonly singleKeyShortcuts: boolean;
}

const DEFAULTS: Preferences = Object.freeze({
  theme: 'system',
  density: 'comfortable',
  singleKeyShortcuts: true,
});

let current: Preferences | null = null;
const listeners = new Set<() => void>();

function readStored(): Preferences {
  try {
    return {
      theme: parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY)),
      density: parseDensity(localStorage.getItem(DENSITY_STORAGE_KEY)),
      singleKeyShortcuts: localStorage.getItem(SINGLE_KEY_STORAGE_KEY) !== 'off',
    };
  } catch {
    // Storage can be blocked (private mode, policy). Preferences then last for the page only.
    return DEFAULTS;
  }
}

/** Mirrors the preference onto <html>, where tokens.css reads it. "system" removes the override. */
export function applyPreferences(
  { theme, density }: Pick<Preferences, 'theme' | 'density'>,
  root = document.documentElement,
) {
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  if (density === 'comfortable') root.removeAttribute('data-density');
  else root.setAttribute('data-density', density);
}

function getSnapshot(): Preferences {
  current ??= readStored();
  return current;
}

function getServerSnapshot(): Preferences {
  return DEFAULTS;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === THEME_STORAGE_KEY ||
      event.key === DENSITY_STORAGE_KEY ||
      event.key === SINGLE_KEY_STORAGE_KEY
    ) {
      current = readStored();
      applyPreferences(current);
      listener();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

function update(next: Preferences) {
  current = next;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next.theme);
    localStorage.setItem(DENSITY_STORAGE_KEY, next.density);
    localStorage.setItem(SINGLE_KEY_STORAGE_KEY, next.singleKeyShortcuts ? 'on' : 'off');
  } catch {
    // See readStored: not persisting is acceptable.
  }
  applyPreferences(next);
  listeners.forEach((listener) => {
    listener();
  });
}

export function setTheme(theme: ThemePreference) {
  update({ ...getSnapshot(), theme });
}

export function setDensity(density: Density) {
  update({ ...getSnapshot(), density });
}

export function setSingleKeyShortcuts(enabled: boolean) {
  update({ ...getSnapshot(), singleKeyShortcuts: enabled });
}

/** The current preferences, for code that runs outside React (the keyboard handlers). */
export function getPreferences(): Preferences {
  return getSnapshot();
}

/** Clears the in-memory copy so the next read goes to storage again. For tests. */
export function resetPreferencesCache() {
  current = null;
}

export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
