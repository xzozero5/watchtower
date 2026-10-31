import type { ReactElement } from 'react';

import { AuthGate } from '@/components/auth-gate';
import { renderApp } from '@/test-utils';

/** A console page (Home, an admin page) behind the auth gate, with the session from `fetch`. */
export function renderConsole(ui: ReactElement, options: Parameters<typeof renderApp>[1] = {}) {
  return renderApp(<AuthGate>{ui}</AuthGate>, options);
}
