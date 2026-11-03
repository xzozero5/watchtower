import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { mockShift } from './shift-backend';

// Screenshots of the bottom of the navigation rail, expanded and collapsed. Not a test: it only
// runs with RAIL_SHOTS=<folder>, e.g. RAIL_SHOTS=../../docs/screenshots/rail/after.
const target = process.env.RAIL_SHOTS;

test.describe('rail screenshots', () => {
  test.skip(!target, 'set RAIL_SHOTS to a folder to take the screenshots');

  for (const scheme of ['light', 'dark'] as const) {
    for (const state of ['expanded', 'collapsed'] as const) {
      test(`rail bottom ${state} ${scheme}`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        await page.addInitScript(
          (value) => {
            localStorage.setItem('wt-rail-expanded', value);
          },
          state === 'expanded' ? '1' : '0',
        );
        await mockShift(page, { incoming: 2 });
        await page.goto('/shift');
        await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
        await page.waitForTimeout(1200);
        const rail = page.getByRole('banner');
        const box = await rail.boundingBox();
        if (!box) throw new Error('no rail');
        const height = Math.min(460, box.height);
        await page.screenshot({
          path: join(target ?? '.', `rail-bottom-${state}-${scheme}.png`),
          clip: { x: box.x, y: box.y + box.height - height, width: box.width, height },
        });
      });
    }
  }
});
