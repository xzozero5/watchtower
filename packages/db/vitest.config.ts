import { defineConfig } from 'vitest/config';

// Unit tests only. Tests that need Postgres are *.integration.test.ts (vitest.integration.config.ts).
export default defineConfig({
  test: {
    // Reading every migration under a full turbo run can take longer than the default.
    testTimeout: 30_000,
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', '**/node_modules/**', '**/dist/**'],
  },
});
