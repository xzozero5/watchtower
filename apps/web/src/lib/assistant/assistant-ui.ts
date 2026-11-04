'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * Where the person keeps the floating AI button (ADR-023, T-134 web). "Hidden" only removes the
 * button: the shortcut and the palette command "Ask AI" still open the panel, so the assistant is
 * never out of reach. Kept in this browser (localStorage); blocked storage lasts for the page only.
 */
export const ASSISTANT_HIDDEN_STORAGE_KEY = 'wt-assistant-bubble';

let hidden: boolean | null = null;
const listeners = new Set<() => void>();

function readHidden(): boolean {
  try {
    return localStorage.getItem(ASSISTANT_HIDDEN_STORAGE_KEY) === 'hidden';
  } catch {
    return false;
  }
}

const getSnapshot = (): boolean => (hidden ??= readHidden());
const getServerSnapshot = (): boolean => false;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === ASSISTANT_HIDDEN_STORAGE_KEY) {
      hidden = readHidden();
      listener();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** Whether the person hid the floating button. */
export function useAssistantHidden(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function setAssistantHidden(next: boolean): void {
  hidden = next;
  try {
    if (next) localStorage.setItem(ASSISTANT_HIDDEN_STORAGE_KEY, 'hidden');
    else localStorage.removeItem(ASSISTANT_HIDDEN_STORAGE_KEY);
  } catch {
    // Storage is blocked: the choice holds until the page is closed.
  }
  for (const listener of [...listeners]) listener();
}

/** Forgets the cached value (tests). */
export function resetAssistantHiddenCache(): void {
  hidden = null;
}

const OPEN_EVENT = 'wt:assistant-open';

/** Asks the assistant to open (the palette command). Does nothing when no bubble is mounted. */
export function requestAssistantOpen(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** Calls `handler` whenever something asks the assistant to open. */
export function useAssistantOpenRequests(handler: () => void): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    const onRequest = () => {
      latest.current();
    };
    window.addEventListener(OPEN_EVENT, onRequest);
    return () => {
      window.removeEventListener(OPEN_EVENT, onRequest);
    };
  }, []);
}
