import { defineConfig } from 'vitest/config';

// Unit tests only. Tests that need Postgres are *.integration.test.ts (vitest.integration.config.ts).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', '**/node_modules/**', '**/dist/**'],
  },
});
