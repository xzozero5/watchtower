'use client';

import {
  assistantElementSchema,
  assistantEntitySchema,
  assistantSelectionSchema,
} from '@watchtower/shared';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import type { AskTarget } from './page-context';

/** An event can carry anything: only a target the contract accepts is used. */
function isAskTarget(value: unknown): value is AskTarget {
  if (typeof value !== 'object' || value === null) return false;
  const target = value as { entity?: unknown; selection?: unknown; element?: unknown };
  if (target.entity === undefined && target.selection === undefined && target.element === undefined)
    return false;
  return (
    (target.element === undefined || assistantElementSchema.safeParse(target.element).success) &&
    (target.entity === undefined || assistantEntitySchema.safeParse(target.entity).success) &&
    (target.selection === undefined || assistantSelectionSchema.safeParse(target.selection).success)
  );
}

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

/**
 * Asks the assistant to open (the palette command, or an "Ask AI about this" button, which passes
 * what it is about so the bubble shows it as a chip). Does nothing when no bubble is mounted.
 */
export function requestAssistantOpen(target?: AskTarget): void {
  window.dispatchEvent(new CustomEvent<AskTarget | undefined>(OPEN_EVENT, { detail: target }));
}

/** Calls `handler` whenever something asks the assistant to open, with what it was asked about. */
export function useAssistantOpenRequests(handler: (target: AskTarget | null) => void): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    const onRequest = (event: Event) => {
      const detail: unknown = event instanceof CustomEvent ? event.detail : null;
      latest.current(isAskTarget(detail) ? detail : null);
    };
    window.addEventListener(OPEN_EVENT, onRequest);
    return () => {
      window.removeEventListener(OPEN_EVENT, onRequest);
    };
  }, []);
}
