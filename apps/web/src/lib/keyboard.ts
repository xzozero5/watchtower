'use client';

import { useEffect, useRef } from 'react';

/** True for elements where a letter key means typing, not a shortcut. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(type);
}

/** An open modal (command palette, keyboard map) owns the keyboard. */
function modalIsOpen(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"]') !== null;
}

export interface ShortcutEvent {
  key: string;
  /** Physical key (`KeyJ`, `Slash`), the same on every keyboard layout. */
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
  defaultPrevented: boolean;
}

/** The physical key of a shortcut character on a US layout, and whether it needs Shift. */
function physicalKey(key: string): { code: string; shift: boolean } | null {
  if (/^[a-z]$/i.test(key)) return { code: `Key${key.toUpperCase()}`, shift: false };
  if (/^\d$/.test(key)) return { code: `Digit${key}`, shift: false };
  if (key === '/') return { code: 'Slash', shift: false };
  if (key === '?') return { code: 'Slash', shift: true };
  if (key === '.') return { code: 'Period', shift: false };
  return null;
}

/**
 * Whether a key press is the single-key shortcut `key`. It matches the typed character
 * (`event.key`) or, so shortcuts also work while a Thai keyboard layout is active, the physical
 * key (`event.code`) with the Shift state the character needs. Ctrl, Cmd and Alt never count, a
 * text field never triggers one, and neither does an open dialog.
 */
export function isShortcut(event: ShortcutEvent, key: string): boolean {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return false;
  const physical = physicalKey(key);
  const typed = event.key === key;
  const sameKey =
    physical !== null && event.code === physical.code && event.shiftKey === physical.shift;
  if (!typed && !sameKey) return false;
  if (isTypingTarget(event.target)) return false;
  return !modalIsOpen();
}

/**
 * Runs `handler` when `key` is pressed on its own, anywhere on the page. The latest handler is
 * always used, so callers do not need to memoise it.
 */
export function useShortcut(key: string, handler: () => void, enabled = true): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isShortcut(event, key)) return;
      event.preventDefault();
      latest.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [key, enabled]);
}

/** Next index when moving by `delta` through `length` items. Clamps at the ends; -1 for an empty list. */
export function stepIndex(current: number, delta: number, length: number): number {
  if (length === 0) return -1;
  if (current < 0) return 0;
  return Math.min(length - 1, Math.max(0, current + delta));
}
