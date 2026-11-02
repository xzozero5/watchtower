import { defineConfig } from 'vitest/config';

// Unit tests only. Tests that need Postgres and Redis are *.integration.test.ts.
export default defineConfig({
  // Same decorator settings as tsconfig.json, so tests see the metadata tsc would emit.
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: {
    // Building the Nest app under a full turbo run takes far longer than the defaults allow.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', '**/node_modules/**', '**/dist/**'],
  },
});
