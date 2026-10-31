import { join } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': join(import.meta.dirname, 'src') },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // e2e/ holds Playwright specs, which Vitest must not pick up.
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
