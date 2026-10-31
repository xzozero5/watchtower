import { defineConfig } from 'vitest/config';

// Unit tests only. Tests that need Postgres and Redis are *.integration.test.ts.
export default defineConfig({
  // Same decorator settings as tsconfig.json, so tests see the metadata tsc would emit.
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', '**/node_modules/**', '**/dist/**'],
  },
});
