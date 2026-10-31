import { defineConfig } from 'vitest/config';

// Needs the compose infrastructure: `docker compose up -d --wait postgres`.
// Fails loudly when Postgres is unreachable; it never skips.
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
