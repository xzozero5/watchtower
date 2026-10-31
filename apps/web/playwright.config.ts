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
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL, trace: 'on-first-retry' },
  projects: [
    {
      name: 'chromium',
      // PW_CHANNEL=msedge (or chrome) uses an installed browser instead of Playwright's download.
      use: { ...devices['Desktop Chrome'], channel: process.env.PW_CHANNEL || undefined },
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
