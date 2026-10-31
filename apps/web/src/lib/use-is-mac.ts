'use client';

import { useSyncExternalStore } from 'react';

const subscribeNever = () => () => undefined;
const detectMac = () => /Mac|iPhone|iPad/.test(navigator.userAgent);
const serverIsMac = () => false;

/** True on Apple platforms, where shortcut hints say Cmd instead of Ctrl. False in the server HTML. */
export function useIsMac(): boolean {
  return useSyncExternalStore(subscribeNever, detectMac, serverIsMac);
}
