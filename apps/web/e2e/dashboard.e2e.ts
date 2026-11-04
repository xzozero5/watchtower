import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { mockDashboard } from './dashboard-backend';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const;

/** Staff pages: the console shell marks itself when React has taken over. */
async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
  await expect(page.getByRole('region', { name: 'Now' })).toBeVisible();
}

/** The colours have a short transition: axe must not read them half way (a false low-contrast hit). */
async function settleColors(page: Page) {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const read = () =>
          `${getComputedStyle(document.body).backgroundColor}|${getComputedStyle(document.body).color}`;
        const first = read();
        setTimeout(() => {
          resolve(read() === first);
        }, 350);
      }),
    undefined,
    { timeout: 10_000 },
  );
}

async function expectNoViolations(page: Page) {
  await settleColors(page);
  const results = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .exclude('[data-sonner-toaster]')
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html ?? ''}`)).toEqual([]);
}

/** No horizontal page scroll: the document is never wider than the window. */
async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const widest = Math.max(
      document.documentElement.scrollWidth,
      ...[...document.querySelectorAll('main, main *')].map(
        (el) => el.getBoundingClientRect().right,
      ),
    );
    return Math.ceil(widest) - window.innerWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const scheme of ['light', 'dark'] as const) {
  for (const viewport of VIEWPORTS) {
    test.describe(`Ops dashboard (${scheme}, ${viewport.name})`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      });

      test('shows every section, says why a figure is missing and passes axe', async ({ page }) => {
        await mockDashboard(page);
        await open(page, '/dashboard');

        const names = ['Now', 'Volume', 'SLA', 'Quality', 'Reliability', 'AI', 'Team'];
        for (const name of names) {
          await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
        }
        await expect(page.getByRole('region', { name: 'Product usage' })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Service status' })).toBeVisible();

        // N5: a missing figure gives its reason, never a 0.
        const quality = page.getByRole('region', { name: 'Quality' });
        await expect(quality.locator('[data-state="unavailable"]')).toContainText('Not built yet');
        const ai = page.getByRole('region', { name: 'AI', exact: true });
        await expect(ai.locator('[data-state="unavailable"]').first()).toContainText(
          'Waits for the AI grader',
        );
        // A real zero is a number.
        const now = page.getByRole('region', { name: 'Now' });
        await expect(now.getByRole('figure', { name: 'Open by age' })).toContainText('Under 4 h');

        await expectNoViolations(page);
        await expectNoHorizontalScroll(page);

        if (process.env.DASHBOARD_SHOTS) {
          // The page scrolls inside its main area: make the window tall enough to show all of it.
          await page.setViewportSize({ width: viewport.width, height: 3600 });
          await page.screenshot({
            path: `${process.env.DASHBOARD_SHOTS}/dashboard-${scheme}-${viewport.name}.png`,
          });
        }
      });

      test('reads a chart by keyboard, offers a table, and switches the window to 90 days', async ({
        page,
      }) => {
        await mockDashboard(page);
        await open(page, '/dashboard');

        const volume = page.getByRole('region', { name: 'Volume' });
        const plot = volume.getByRole('group', { name: 'Created per day' });
        await plot.focus();
        const tip = volume.getByTestId('chart-tooltip');
        await expect(tip).toContainText('Created');
        const first = await tip.textContent();
        await page.keyboard.press('ArrowLeft');
        await expect(tip).not.toHaveText(first ?? '');
        await page.keyboard.press('Escape');
        await expect(tip).toHaveCount(0);

        await volume.getByRole('button', { name: 'Show as a table' }).click();
        await expect(volume.getByRole('row')).toHaveCount(8);
        await volume.getByRole('button', { name: 'Show as a chart' }).click();

        await page.getByRole('radio', { name: 'Last 90 days' }).click();
        await expect(page.getByRole('radio', { name: 'Last 90 days' })).toBeChecked();
        await expect(volume.locator('rect[data-slot]')).toHaveCount(90);
        await expectNoHorizontalScroll(page);
        await expectNoViolations(page);
      });
    });
  }
}

test.describe('Ops dashboard: roles and states', () => {
  test('an agent sees the queue and says plainly what the role does not see', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await mockDashboard(page, { role: 'agent' });
    await open(page, '/dashboard');
    const ai = page.getByRole('region', { name: 'AI', exact: true });
    await expect(ai).toContainText('Not visible to your role');
    await expect(
      page.getByRole('region', { name: 'Quality' }).locator('[data-state="restricted"]'),
    ).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Now' })).toContainText('23');
    await expectNoViolations(page);
  });

  test('is in the rail for a head and opens from it', async ({ page }) => {
    await mockDashboard(page);
    await page.goto('/home');
    await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
    await page.getByRole('link', { name: 'Ops dashboard' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('region', { name: 'Now' })).toBeVisible();
  });

  test('shows an error with a retry when the api fails, then recovers', async ({ page }) => {
    let fail = true;
    await mockDashboard(page, { failing: () => fail });
    await page.goto('/dashboard');
    await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
    await expect(page.locator('main').getByRole('alert')).toContainText(
      'Could not load the dashboard.',
    );
    fail = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('region', { name: 'Now' })).toBeVisible();
  });
});
