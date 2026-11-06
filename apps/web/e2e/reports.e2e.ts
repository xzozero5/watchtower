import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { APP_ORIGIN } from './backend';

import { mockReports } from './reports-backend';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const;

const PAGES = [
  { path: '/dashboard/cost', title: 'AI cost' },
  { path: '/dashboard/ceo', title: 'CEO view' },
] as const;

async function open(page: Page, path: string, title: string) {
  const response = await page.goto(path);
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(new URL(path, APP_ORIGIN).href);
  await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
  await expect(page.getByText('Page not found', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('assistant-bubble')).toBeVisible();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
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
    test.describe(`Reports (${scheme}, ${viewport.name})`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      });

      test('AI cost shows its figures and passes axe', async ({ page }) => {
        await mockReports(page);
        await open(page, '/dashboard/cost', 'AI cost');
        await expect(page.getByRole('region', { name: 'Cost per agent' })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Cost per intent' })).toBeVisible();
        await expect(page.getByText('+50% vs previous period').first()).toBeVisible();
        await expect(page.getByRole('link', { name: 'Open OPS-12' })).toBeVisible();
        await expectNoViolations(page);
        await expectNoHorizontalScroll(page);
      });

      test('CEO view gives a reason, not a number, for a figure with no data, and passes axe', async ({
        page,
      }) => {
        await mockReports(page);
        await open(page, '/dashboard/ceo', 'CEO view');
        // The export buttons are disabled until the figures arrive and fade to their colour: not before axe reads them.
        await expect(page.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
        await page.waitForTimeout(500);
        await expect(page.getByText('Ticket volume').first()).toBeVisible();
        await expect(page.locator('[data-state="unavailable"]').first()).toContainText(
          'Waits for the AI grader',
        );
        await expect(
          page.getByRole('heading', { name: 'How automation savings are worked out' }),
        ).toBeVisible();
        await expectNoViolations(page);
        await expectNoHorizontalScroll(page);
      });
    });
  }
}

test.describe('Reports: window, errors, roles', () => {
  test('switching to 30 days asks the api for 30 days', async ({ page }) => {
    const backend = await mockReports(page);
    await open(page, '/dashboard/cost', 'AI cost');
    await page.getByRole('radio', { name: 'Last 30 days' }).click();
    await expect(page.getByRole('radio', { name: 'Last 30 days' })).toBeChecked();
    await expect
      .poll(() =>
        backend.to('GET', '/v1/reports/ai-cost').some((r) => r.search.includes('days=30')),
      )
      .toBe(true);
  });

  for (const { path, title } of PAGES) {
    test(`${path} shows an error with a retry, then recovers`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
      let fail = true;
      await mockReports(page, { failing: () => fail });
      await page.goto(path);
      await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
      await expect(page.locator('main').getByRole('alert')).toBeVisible();
      fail = false;
      await page.getByRole('button', { name: 'Try again' }).click();
      await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
      await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
    });
  }

  test('an agent does not get the cost page', async ({ page }) => {
    await mockReports(page, { role: 'agent' });
    await page.goto('/dashboard/cost');
    await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
    await expect(page.getByRole('heading', { name: 'AI cost', level: 1 })).toHaveCount(0);
  });
});
