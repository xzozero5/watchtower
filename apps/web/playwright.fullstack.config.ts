import { defineConfig, devices } from '@playwright/test';

// Full-stack e2e (T-009): a real browser against the real web, api and worker, Postgres, Redis and
// Mailpit. External integrations and AI use test adapters; browser, web, API, worker and database are real. `e2e-fullstack/global-setup.ts` brings the stack up (from source, on
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
  // In CI an HTML report (with traces) is written for the workflow to upload when the job fails.
  // Folders of their own: each Playwright run clears its output directory when it starts.
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report-fullstack' }]]
    : 'list',
  outputDir: 'test-results-fullstack',
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
