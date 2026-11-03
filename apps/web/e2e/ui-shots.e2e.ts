import { join } from 'node:path';

import { expect, type Page, test } from '@playwright/test';

import { boardTickets } from './ai-board';
import { mockBackend } from './backend';
import { mockConsole } from './console-backend';
import { mockDashboard } from './dashboard-backend';
import { mockOps } from './ops-backend';
import { mockShift } from './shift-backend';

// Before/after screenshots for a visual rework (docs/plans/ui-rework-brief.md section 4). Not a
// test: it only runs with UI_SHOTS=<folder>, e.g. UI_SHOTS=../../docs/screenshots/ui-rework/after.
const target = process.env.UI_SHOTS;

const PAGES: { name: string; path: string; mock: (page: Page) => Promise<unknown> }[] = [
  {
    name: 'home',
    path: '/home',
    mock: async (page) => {
      // Registered last wins: the console routes go on top of the dashboard ones.
      await mockDashboard(page);
      await mockConsole(page, 'head');
    },
  },
  { name: 'dashboard', path: '/dashboard', mock: (page) => mockDashboard(page) },
  { name: 'shift', path: '/shift', mock: (page) => mockShift(page) },
  { name: 'alerts', path: '/alerts', mock: (page) => mockOps(page) },
  { name: 'incidents', path: '/incidents', mock: (page) => mockOps(page) },
  { name: 'queue', path: '/', mock: (page) => mockBackend(page, { tickets: boardTickets() }) },
  {
    name: 'ticket',
    path: '/?ticket=OPS-1',
    mock: (page) => mockBackend(page, { tickets: boardTickets() }),
  },
];

const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
] as const;

test.describe('UI screenshots', () => {
  test.skip(!target, 'set UI_SHOTS to a folder to take the screenshots');

  for (const scheme of ['light', 'dark'] as const) {
    for (const viewport of VIEWPORTS) {
      for (const shot of PAGES) {
        test(`${shot.name} ${scheme} ${viewport.name}`, async ({ page }) => {
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
          await shot.mock(page);
          await page.goto(shot.path);
          await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
          await page.waitForTimeout(1200);
          await page.screenshot({
            path: join(target ?? '.', `${shot.name}-${scheme}-${viewport.name}.png`),
          });
        });
      }
    }
  }
});
