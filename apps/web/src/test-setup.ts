import '@testing-library/jest-dom/vitest';

import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeAll } from 'vitest';

import { resetPreferencesCache } from '@/lib/preferences';
import { draftStore } from '@/lib/tickets/templates';

// findBy*/waitFor default to 1 s. When turbo runs every package's tests in parallel the CPU is
// saturated and a render can take longer, which made some tests flaky (T-125). 5 s keeps a real
// failure fast enough while tolerating load.
configure({ asyncUtilTimeout: 5_000 });

beforeAll(() => {
  // jsdom does not implement scrolling. Components call these; tests only need them not to throw.
  Element.prototype.scrollIntoView = () => undefined;
  // Radix (menus, popovers) and cmdk measure and capture pointers; jsdom has neither.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  globalThis.ResizeObserver = class {
    observe() {
      return undefined;
    }
    unobserve() {
      return undefined;
    }
    disconnect() {
      return undefined;
    }
  };
  // Clipboard access for the copy buttons.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: () => Promise.resolve() },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  draftStore.clear();
  resetPreferencesCache();
  window.history.replaceState(null, '', '/');
});
