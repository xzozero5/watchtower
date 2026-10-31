import { defineConfig } from 'vitest/config';

// Unit tests only. Tests that need Postgres and Redis are *.integration.test.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', '**/node_modules/**', '**/dist/**'],
  },
});
