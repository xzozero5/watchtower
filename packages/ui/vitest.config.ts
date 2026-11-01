import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    css: false,
    // Radix dialogs, menus and focus returns take ~0.5 s each in jsdom; with the whole monorepo's
    // tests running in parallel on a loaded machine they pass the 5 s default (apps/web does the same).
    testTimeout: 20_000,
  },
});
