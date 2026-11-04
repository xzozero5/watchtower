'use client';

import { useEffect, useRef } from 'react';

/**
 * Runs `handler` for Ctrl+<letter> or Cmd+<letter> (no Shift or Alt), from anywhere including text
 * fields. `letter` is a letter or "/". Matches the typed key or the physical key, so it also works on a Thai layout. Like
 * Ctrl+K it uses a modifier, so the single-key shortcut preference does not switch it off
 * (WCAG 2.1.4 exempts it). An open dialog owns the keyboard.
 */
export function useModifierShortcut(letter: string, handler: () => void): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
      if (event.defaultPrevented) return;
      const typed = event.key.toLowerCase() === letter;
      const physical = event.code === (letter === '/' ? 'Slash' : `Key${letter.toUpperCase()}`);
      if (!typed && !physical) return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      event.preventDefault();
      latest.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [letter]);
}
