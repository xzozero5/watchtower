import { defineConfig, devices } from '@playwright/test';

// Full-stack e2e (T-009): a real browser against the real web, api and worker, Postgres, Redis and
// Mailpit. Nothing is mocked. `e2e-fullstack/global-setup.ts` brings the stack up (from source, on
// loopback ports of its own, with a throwaway database) or, with E2E_STACK=external, points at a
// stack that is already running, for example `docker compose up`. See apps/web/e2e-fullstack/README.md.
//
// One worker, no parallelism: the scenarios share one database and tell their data apart by
// unique addresses, and AC-1 measures a time budget that parallel load would distort.
export default defineConfig({
  testDir: './e2e-fullstack',
  testMatch: '*.e2e.ts',
  globalSetup: './e2e-fullstack/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: { trace: 'retain-on-failure', locale: 'en-US' },
  projects: [
    {
      name: 'chromium',
      // PW_CHANNEL=msedge (or chrome) uses an installed browser instead of Playwright's download.
      // PW_EXECUTABLE_PATH points at a preinstalled Chromium (a cloud dev container).
      use: {
        ...devices['Desktop Chrome'],
        channel: process.env.PW_CHANNEL || undefined,
        launchOptions: { executablePath: process.env.PW_EXECUTABLE_PATH || undefined },
      },
    },
  ],
});
