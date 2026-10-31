'use client';

import { useEffect, useRef } from 'react';

import { getPreferences } from '@/lib/preferences';

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
  if (key === '[') return { code: 'BracketLeft', shift: false };
  if (key === ']') return { code: 'BracketRight', shift: false };
  return null;
}

/**
 * Whether a key press is the single-key shortcut `key`. It matches the typed character
 * (`event.key`) or, so shortcuts also work while a Thai keyboard layout is active, the physical
 * key (`event.code`) with the Shift state the character needs. Ctrl, Cmd and Alt never count, a
 * text field never triggers one, neither does an open dialog, and none fires once the person has
 * turned single-key shortcuts off in the preferences.
 */
export function isShortcut(event: ShortcutEvent, key: string): boolean {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return false;
  // WCAG 2.1.4: a person who turned single-key shortcuts off gets none of them.
  if (!getPreferences().singleKeyShortcuts) return false;
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

/** How long `g` waits for its second key. */
export const SEQUENCE_TIMEOUT_MS = 1500;

/**
 * Two-key sequences such as `g` then `q`. `prefix` arms the sequence; the next key picks the
 * action. Any other key (Shift, Ctrl and the like excepted) or a pause of
 * `SEQUENCE_TIMEOUT_MS` disarms it, and that key then behaves as it normally would. Every key
 * goes through `isShortcut`, so the field guard, the Thai layout and the single-key preference all
 * apply.
 */
export function useShortcutSequence(
  prefix: string,
  actions: Readonly<Record<string, () => void>>,
  enabled = true,
): void {
  const latest = useRef(actions);
  useEffect(() => {
    latest.current = actions;
  });
  useEffect(() => {
    if (!enabled) return;
    let armedAt: number | null = null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
      if (armedAt !== null) {
        const fresh = Date.now() - armedAt <= SEQUENCE_TIMEOUT_MS;
        armedAt = null;
        if (fresh) {
          for (const [key, action] of Object.entries(latest.current)) {
            if (!isShortcut(event, key)) continue;
            event.preventDefault();
            action();
            return;
          }
        }
      }
      if (isShortcut(event, prefix)) {
        event.preventDefault();
        armedAt = Date.now();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [prefix, enabled]);
}

/** What a pane key press asks for: step through the panes, or jump to the n-th (0-based). */
export type PaneCommand = { type: 'cycle'; delta: 1 | -1 } | { type: 'jump'; index: 0 | 1 | 2 };

/**
 * F6 and Shift+F6 cycle the panes, Alt+1/2/3 jump to one (docs/06-UI-SPEC.md section 14). These
 * keys are not characters (WCAG 2.1.4 exempts them), they work from inside a text field (they are
 * how you leave one), and they match the physical key so Alt+digit survives a Thai layout.
 */
export function paneCommand(event: ShortcutEvent): PaneCommand | null {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey) return null;
  if (event.code === 'F6' || event.key === 'F6') {
    return event.altKey ? null : { type: 'cycle', delta: event.shiftKey ? -1 : 1 };
  }
  if (!event.altKey || event.shiftKey) return null;
  const index = ['Digit1', 'Digit2', 'Digit3'].indexOf(event.code);
  return index === 0 || index === 1 || index === 2 ? { type: 'jump', index } : null;
}

/** Runs `handler` for F6, Shift+F6 and Alt+1/2/3, unless a dialog is open. */
export function usePaneKeys(handler: (command: PaneCommand) => void, enabled = true): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const command = paneCommand(event);
      if (!command || modalIsOpen()) return;
      event.preventDefault();
      latest.current(command);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [enabled]);
}

/** Next index when moving by `delta` through `length` items. Clamps at the ends; -1 for an empty list. */
export function stepIndex(current: number, delta: number, length: number): number {
  if (length === 0) return -1;
  if (current < 0) return 0;
  return Math.min(length - 1, Math.max(0, current + delta));
}
