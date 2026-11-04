import { defineConfig } from 'vitest/config';

// Integration tests write to Postgres/Redis. Outside CI the TEST_* variables must point at
// disposable services: on the owner's machine the default ports are the running stack
// (2026-11-04: test databases and keys were found there). docs/runbooks/local-poc.md §6
const missing = ['TEST_DATABASE_URL', 'TEST_REDIS_URL'].filter((name) => !process.env[name]);
if (!process.env.CI && missing.length > 0) {
  throw new Error(
    `Set ${missing.join(', ')} to disposable services before running integration tests (docs/runbooks/local-poc.md §6)`,
  );
}

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
