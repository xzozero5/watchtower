'use client';

import { useEffect } from 'react';

/**
 * Registers /sw.js in production builds only, so `next dev` is never served stale files by a
 * worker. Failure is silent: the app works the same without it.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }, []);
  return null;
}
