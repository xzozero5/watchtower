import {
  DENSITY_STORAGE_KEY,
  parseDensity,
  parseThemePreference,
  THEME_STORAGE_KEY,
  type Density,
  type ThemePreference,
} from '@watchtower/ui';
import { useSyncExternalStore } from 'react';

export interface Preferences {
  readonly theme: ThemePreference;
  readonly density: Density;
}

const DEFAULTS: Preferences = Object.freeze({ theme: 'system', density: 'comfortable' });

let current: Preferences | null = null;
const listeners = new Set<() => void>();

function readStored(): Preferences {
  try {
    return {
      theme: parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY)),
      density: parseDensity(localStorage.getItem(DENSITY_STORAGE_KEY)),
    };
  } catch {
    // Storage can be blocked (private mode, policy). Preferences then last for the page only.
    return DEFAULTS;
  }
}

/** Mirrors the preference onto <html>, where tokens.css reads it. "system" removes the override. */
export function applyPreferences({ theme, density }: Preferences, root = document.documentElement) {
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
    if (event.key === THEME_STORAGE_KEY || event.key === DENSITY_STORAGE_KEY) {
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

/** Clears the in-memory copy so the next read goes to storage again. For tests. */
export function resetPreferencesCache() {
  current = null;
}

export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
