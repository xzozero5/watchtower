'use client';

import { useEffect } from 'react';

/** True for Ctrl+K and Cmd+K, with no Shift or Alt. */
export function isPaletteShortcut(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.shiftKey &&
    !event.altKey &&
    // The physical key too, so the shortcut also works on a Thai keyboard layout.
    (event.key.toLowerCase() === 'k' || event.code === 'KeyK')
  );
}

/**
 * Calls `toggle` on Ctrl+K or Cmd+K from anywhere on the page, including inside text fields, and
 * stops the browser from using the key for its own search focus.
 */
export function usePaletteShortcut(toggle: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      toggle();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [toggle]);
}
