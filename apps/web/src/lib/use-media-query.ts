'use client';

import { useCallback, useSyncExternalStore } from 'react';

/** From 48rem (768 px) the queue and the conversation sit side by side and the rail is a column. */
export const SIDE_BY_SIDE_QUERY = '(min-width: 48rem)';
/** From 64rem (1024 px) the details panel is a third column. */
export const THREE_PANES_QUERY = '(min-width: 64rem)';

/**
 * Whether a media query matches, live. Without `matchMedia` (tests) it answers `fallback`, which
 * is the widest layout by default.
 */
export function useMediaQuery(query: string, fallback = true): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => {
        list.removeEventListener('change', onChange);
      };
    },
    [query],
  );
  const getSnapshot = () =>
    typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : fallback;
  return useSyncExternalStore(subscribe, getSnapshot, () => fallback);
}
