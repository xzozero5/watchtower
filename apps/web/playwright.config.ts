import { defineConfig, devices } from '@playwright/test';

import { E2E_API_URL, E2E_PORT } from './e2e/constants';

// The smoke tests run against the standalone production build (`next build` first: turbo does
// this), not the dev server, so they test what the Docker image runs.
const baseURL = `http://127.0.0.1:${String(E2E_PORT)}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // In CI an HTML report (with traces) is written for the workflow to upload when the job fails.
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : 'list',
  outputDir: 'test-results',
  // No transitions: axe measures contrast and target size on still pixels, not halfway through one.
  use: { baseURL, trace: 'on-first-retry', contextOptions: { reducedMotion: 'reduce' } },
  projects: [
    {
      name: 'chromium',
      // PW_CHANNEL=msedge (or chrome) uses an installed browser instead of Playwright's download.
      // PW_EXECUTABLE_PATH points at a preinstalled Chromium whose revision differs from the pinned
      // Playwright (e.g. a cloud dev container), so no browser download is needed.
      use: {
        ...devices['Desktop Chrome'],
        channel: process.env.PW_CHANNEL || undefined,
        launchOptions: { executablePath: process.env.PW_EXECUTABLE_PATH || undefined },
      },
    },
  ],
  webServer: {
    command: 'node scripts/start-standalone.mjs',
    url: `${baseURL}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      API_URL: E2E_API_URL,
      NEXT_TELEMETRY_DISABLED: '1',
      HOSTNAME: '127.0.0.1',
      PORT: String(E2E_PORT),
    },
  },
});
