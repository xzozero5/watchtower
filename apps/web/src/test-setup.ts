import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll } from 'vitest';

import { draftStore } from '@/lib/tickets/templates';

beforeAll(() => {
  // jsdom does not implement scrolling. Components call these; tests only need them not to throw.
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  cleanup();
  draftStore.clear();
  window.history.replaceState(null, '', '/');
});
