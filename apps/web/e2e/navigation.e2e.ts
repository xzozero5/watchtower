import { expect, type Page, test } from '@playwright/test';

import { mockBackend } from './backend';
import { mockConsole } from './console-backend';

async function hydrated(page: Page) {
  await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
}

/** Marks the current document. A full page load throws the mark away; a client-side move keeps it. */
async function markDocument(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
  });
}

async function expectSameDocument(page: Page) {
  const kept = await page.evaluate(
    () => (window as unknown as { __sameDocument?: boolean }).__sameDocument === true,
  );
  expect(kept, 'the page was reloaded instead of moving client-side').toBe(true);
  const navigations = await page.evaluate(() => performance.getEntriesByType('navigation').length);
  expect(navigations).toBe(1);
}

test.describe('no full page reloads', () => {
  test('opening a ticket, the rail, the logo, the palette and the language keep one document', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockConsole(page, 'head');
    await page.goto('/home');
    await hydrated(page);
    await markDocument(page);

    // Rail link to the queue, then open a ticket from the list.
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Admin' })
      .click();
    await page.waitForURL('**/admin/**');
    await expectSameDocument(page);

    // The logo goes home through the router.
    await page.getByRole('link', { name: 'Watchtower: Go to home' }).click();
    await page.waitForURL('**/home');
    await expectSameDocument(page);

    // The command palette navigates in place.
    // The button, not the shortcut: right after a client-side move the key handler may not be bound yet.
    await page.getByRole('button', { name: 'Open command palette' }).click();
    await page.getByRole('combobox').fill('admin');
    await page.keyboard.press('Enter');
    await page.waitForURL('**/admin/**');
    await expectSameDocument(page);

    // Language switch refreshes the server render without reloading.
    await page.getByRole('button', { name: /Account menu/ }).click();
    await page.getByRole('menuitemradio', { name: 'ไทย' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'th');
    await expectSameDocument(page);
  });

  test('a queue row opens its ticket without a reload', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockBackend(page, { role: 'agent' });
    await page.goto('/');
    await hydrated(page);
    await markDocument(page);
    await page
      .getByRole('region', { name: 'Queue' })
      .getByRole('option', { name: /OPS-1/ })
      .click();
    await expect(page).toHaveURL(/ticket=OPS-1/);
    await expect(page.getByRole('region', { name: 'Conversation' })).toContainText('OPS-1');
    await expectSameDocument(page);
  });
});

test.describe('the shell stays mounted', () => {
  test('the rail keeps its element and no shell skeleton appears while moving between pages', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockConsole(page, 'head');
    await page.goto('/home');
    await hydrated(page);
    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(rail).toBeVisible();
    await markDocument(page);
    // Tag the element, and watch for the whole-page skeleton of the auth gate.
    await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Main navigation"]');
      (nav as unknown as { __tag: string }).__tag = 'same';
      const w = window as unknown as { __shellSkeleton: boolean };
      w.__shellSkeleton = false;
      new MutationObserver(() => {
        if (document.querySelector('main[role="status"]')) w.__shellSkeleton = true;
      }).observe(document.body, { childList: true, subtree: true });
    });

    const steps: [string, RegExp][] = [
      ['Admin', /\/admin\//],
      ['Ops dashboard', /\/dashboard/],
      ['Home', /\/home/],
      ['Queue', /\/(\?.*)?$/],
      ['My shift', /\/shift/],
      ['Home', /\/home/],
    ];
    for (const [name, url] of steps) {
      await rail.getByRole('link', { name, exact: true }).click();
      await expect(page).toHaveURL(url);
      const kept = await page.evaluate(() => {
        const nav = document.querySelector('nav[aria-label="Main navigation"]');
        return (nav as unknown as { __tag?: string } | null)?.__tag === 'same';
      });
      expect(kept, `the rail was re-created going to ${name}`).toBe(true);
    }
    expect(
      await page.evaluate(
        () => (window as unknown as { __shellSkeleton: boolean }).__shellSkeleton,
      ),
      'a shell-level skeleton appeared',
    ).toBe(false);
    await expectSameDocument(page);
  });
});

test.describe('where each role starts', () => {
  test('an agent lands on the queue', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockBackend(page, { role: 'agent' });
    await page.goto('/start');
    await page.waitForURL((url) => url.pathname === '/');
    await expect(page.getByRole('region', { name: 'Queue' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Watchtower: Go to home' })).toHaveAttribute(
      'href',
      '/',
    );
  });

  test('a head lands on the team overview, and the logo goes there', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockConsole(page, 'head');
    await page.goto('/start');
    await page.waitForURL('**/home');
    await expect(page.getByRole('link', { name: 'Watchtower: Go to home' })).toHaveAttribute(
      'href',
      '/home',
    );
  });

  test('a deep link wins over the role home, and an off-site one is ignored', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockBackend(page, { role: 'agent' });
    await page.goto('/start?next=%2F%3Fticket%3DOPS-1');
    await page.waitForURL(/ticket=OPS-1/);

    await page.goto('/start?next=https%3A%2F%2Fevil.example%2F');
    await page.waitForURL(
      (url) => url.origin === new URL(page.url()).origin && url.pathname === '/',
    );
    expect(new URL(page.url()).hostname).not.toContain('evil');
  });
});

test.describe('navigation rail state', () => {
  test('is expanded by default, remembers a collapse across reloads, and does not flash', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockBackend(page, { role: 'agent' });
    await page.goto('/');
    await hydrated(page);
    const rail = page.getByRole('banner');
    await expect.poll(async () => (await rail.boundingBox())?.width).toBe(248);

    await page.keyboard.press('ControlOrMeta+B');
    await expect.poll(async () => (await rail.boundingBox())?.width).toBe(68);
    await expect(page.getByRole('button', { name: 'Expand the navigation' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    await page.reload();
    await hydrated(page);
    await expect.poll(async () => (await rail.boundingBox())?.width).toBe(68);
  });

  test('768 to 1023 px forces icons without saving that as the choice', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await mockBackend(page, { role: 'agent' });
    await page.goto('/');
    await hydrated(page);
    const rail = page.getByRole('banner');
    await expect.poll(async () => (await rail.boundingBox())?.width).toBe(68);
    expect(await page.evaluate(() => localStorage.getItem('wt-rail-expanded'))).toBeNull();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(async () => (await rail.boundingBox())?.width).toBe(248);
  });
});
