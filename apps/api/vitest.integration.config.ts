import { defineConfig } from 'vitest/config';

// Needs the compose infrastructure: `docker compose up -d --wait postgres redis`.
// Fails loudly when it is unreachable; it never skips.
export default defineConfig({
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: {
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
