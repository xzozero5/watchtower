import { useSyncExternalStore } from 'react';

/**
 * Whether the navigation rail shows words (248 px) or only icons (68 px). A per-viewer convenience
 * kept in localStorage, like the theme and density (`preferences.ts`). "0" is the only value that
 * collapses it, so a missing or corrupt value falls back to the default: expanded.
 */
export const RAIL_STORAGE_KEY = 'wt-rail-expanded';

const listeners = new Set<() => void>();
/** What this page last chose, used when storage is blocked so the switch still works until reload. */
let memory: boolean | null = null;

function readStored(): boolean | null {
  try {
    const value = localStorage.getItem(RAIL_STORAGE_KEY);
    if (value === '0') return false;
    if (value === '1') return true;
    return null;
  } catch {
    // Storage can be blocked (private mode, policy): the choice then lasts for the page only.
    return null;
  }
}

/** The saved choice; expanded when there is none. Storage wins over memory so other tabs are heard. */
export function getRailExpanded(): boolean {
  return readStored() ?? memory ?? true;
}

export function setRailExpanded(expanded: boolean): void {
  memory = expanded;
  try {
    localStorage.setItem(RAIL_STORAGE_KEY, expanded ? '1' : '0');
  } catch {
    // See readStored: not persisting is acceptable.
  }
  listeners.forEach((listener) => {
    listener();
  });
}

/** Forgets the in-memory choice. For tests. */
export function resetRailPreference(): void {
  memory = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab changed it: follow, so two open tabs do not disagree.
  const onStorage = (event: StorageEvent) => {
    if (event.key === RAIL_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * The user's choice for the rail. The server snapshot is the default (expanded). The console shell
 * only mounts after the session has loaded in the browser, so it is never part of the server HTML
 * and the saved choice is read on its first render: there is no collapsed-then-expanded flash.
 */
export function useRailExpanded(): boolean {
  return useSyncExternalStore(subscribe, getRailExpanded, () => true);
}
