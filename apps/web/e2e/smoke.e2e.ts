import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { COLOR_TOKENS } from '@watchtower/ui';

import { type BackendOptions, mockBackend } from './backend';
import { E2E_API_URL } from './constants';

const rgb = (hex: string) => {
  const n = (start: number) => parseInt(hex.slice(start, start + 2), 16);
  return `rgb(${String(n(1))}, ${String(n(3))}, ${String(n(5))})`;
};

const bodyBackground = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

/**
 * Signs in as an agent against the in-browser stand-in for the api, opens the home page and waits
 * until React has hydrated, so key presses and clicks are heard.
 */
async function openHome(page: Page, options: BackendOptions = {}) {
  const backend = await mockBackend(page, options);
  await page.goto('/');
  await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
  return backend;
}

/** Account menu (avatar in the rail) -> one of its radio items (a density icon or a language flag). */
async function chooseFromAccountMenu(page: Page, item: string) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitemradio', { name: item }).click();
}

/** Account menu -> the dark theme switch: it saves the opposite of the theme in effect. */
async function toggleDarkFromAccountMenu(page: Page) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Dark theme' }).click();
}

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test.describe('health', () => {
  test('GET /health answers 200', async ({ request }) => {
    const response = await request.get('/health');
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', service: 'web' });
  });
});

test.describe('three-pane layout', () => {
  test('shows the queue, an empty conversation and the AI placeholder', async ({ page }) => {
    await openHome(page);
    await expect(page).toHaveTitle('Watchtower');
    await expect(page.getByRole('region', { name: 'Queue' })).toContainText('Cannot log in');
    await expect(page.getByRole('region', { name: 'Conversation' })).toContainText(
      'Select a ticket',
    );
    // The right-hand panel opens on Details until the AI brings evidence.
    const panel = page.getByRole('region', { name: 'Details & AI' });
    await expect(panel).toContainText('Select a ticket to see its details here.');
    await panel.getByRole('tab', { name: 'Evidence', exact: true }).click();
    await expect(panel).toContainText('Select a ticket to see its details here.');
  });

  test('puts the rail and the panes side by side on a wide screen, as cards with an even gutter', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHome(page);
    const rail = await page.getByRole('banner').boundingBox();
    // Expanded by default (248 px with words) until someone collapses it.
    expect(rail?.width).toBe(248);
    const boxes = await Promise.all(
      ['pane-queue', 'pane-conversation', 'pane-assistant'].map(async (id) => {
        const box = await page.locator(`#${id}`).boundingBox();
        if (!box) throw new Error(`${id} has no box`);
        return box;
      }),
    );
    const [queue, conversation, assistant] = boxes;
    expect(queue && conversation && assistant).toBeTruthy();
    if (!queue || !conversation || !assistant) return;
    expect(Math.abs(queue.y - conversation.y)).toBeLessThan(2);
    expect(Math.abs(conversation.y - assistant.y)).toBeLessThan(2);
    expect(queue.x + queue.width).toBeLessThanOrEqual(conversation.x);
    expect(conversation.x + conversation.width).toBeLessThanOrEqual(assistant.x);
    // Soft Beacon (docs/design/redesign-2026-11): floating cards with a 1rem (15px) gutter at 1440.
    expect(Math.round(conversation.x - (queue.x + queue.width))).toBe(15); // 1rem at the 15px base
    expect(Math.round(assistant.x - (conversation.x + conversation.width))).toBe(15);
    expect(queue.width).toBeLessThanOrEqual(360);
    expect(assistant.width).toBeLessThanOrEqual(320);
    expect(rail && Math.round(queue.x - (rail.x + rail.width))).toBe(15);
  });

  test('shows one pane at a time with tabs on a phone-sized screen, without sideways scrolling', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await openHome(page);
    const tabs = page.getByRole('tablist', { name: 'Panes' });
    await expect(tabs.getByRole('tab')).toHaveText(['Queue', 'Conversation', 'Details & AI']);
    await expect(page.locator('#pane-queue')).toBeVisible();
    await expect(page.locator('#pane-conversation')).toBeHidden();
    await expect(page.locator('#pane-assistant')).toBeHidden();

    await tabs.getByRole('tab', { name: 'Details & AI' }).click();
    await expect(page.locator('#pane-assistant')).toBeVisible();
    await expect(page.locator('#pane-queue')).toBeHidden();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('command palette', () => {
  test('opens with Ctrl/Cmd+K, filters, runs a command with Enter and closes', async ({ page }) => {
    await openHome(page);
    await page.keyboard.press('ControlOrMeta+K');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Command palette' })).toBeFocused();

    await page.keyboard.type('dark');
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Enter');

    await expect(dialog).toBeHidden();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('closes with Escape and returns focus to the page', async ({ page }) => {
    await openHome(page);
    await page.keyboard.press('ControlOrMeta+K');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('opens from the rail button', async ({ page }) => {
    await openHome(page);
    await page.getByRole('button', { name: /Open command palette/ }).click();
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  });
});

test.describe('theme, density and motion', () => {
  test('follows the OS colour scheme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openHome(page);
    expect(await bodyBackground(page)).toBe(rgb(COLOR_TOKENS.light.background));

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => bodyBackground(page)).toBe(rgb(COLOR_TOKENS.dark.background));
  });

  test('lets the user override the OS and remembers it across reloads', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openHome(page);
    // The OS is dark, so the switch is on; pressing it saves light.
    await toggleDarkFromAccountMenu(page);
    await expect.poll(() => bodyBackground(page)).toBe(rgb(COLOR_TOKENS.light.background));

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await bodyBackground(page)).toBe(rgb(COLOR_TOKENS.light.background));
  });

  test('uses a 15px base, and 14px when compact', async ({ page }) => {
    await openHome(page);
    const fontSize = () => page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
    expect(await fontSize()).toBe('15px');
    await chooseFromAccountMenu(page, 'Compact');
    expect(await fontSize()).toBe('14px');
  });

  test('drops motion when the OS asks for reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openHome(page);
    const duration = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--wt-motion-duration-fast'),
    );
    // The CSS minifier may write zero milliseconds as 0s. Both mean no animation time.
    expect(duration.trim()).toMatch(/^0(ms|s)$/);
  });
});

test.describe('severity is not colour alone', () => {
  test('each of P1 to P4 has an icon, a code and a label', async ({ page }) => {
    await openHome(page);
    await page.getByText('Severity key').click();
    const expected = [
      ['P1', 'Critical'],
      ['P2', 'High'],
      ['P3', 'Medium'],
      ['P4', 'Low'],
    ] as const;
    for (const [code, label] of expected) {
      const badge = page
        .locator('details', { hasText: 'Severity key' })
        .locator(`[data-severity="${code.toLowerCase()}"]`);
      await expect(badge).toContainText(code);
      await expect(badge).toContainText(label);
      await expect(badge.locator('svg')).toBeVisible();
    }
  });
});

test.describe('language', () => {
  test('switches to Thai, sets <html lang> and remembers the choice', async ({ page }) => {
    await openHome(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await chooseFromAccountMenu(page, 'ภาษาไทย');

    await expect(page.getByRole('region', { name: 'คิวงาน' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'th');

    await page.reload();
    await expect(page.getByRole('region', { name: 'คิวงาน' })).toBeVisible();
  });

  test('picks Thai from the browser language when nothing is saved', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'th-TH' });
    const page = await context.newPage();
    await openHome(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'th');
    await expect(page.getByRole('region', { name: 'บทสนทนา' })).toBeVisible();
    await context.close();
  });
});

test.describe('runtime API URL', () => {
  test('the browser calls the API_URL the server started with, not a build-time value', async ({
    page,
  }) => {
    const requested = page.waitForRequest(`${E2E_API_URL}/health`);
    await openHome(page);
    await requested;
    await expect(page.getByTestId('api-status')).toHaveAttribute('data-state', 'success');
    await expect(page.getByText('API online')).toBeVisible();
  });

  test('says the API is unreachable when it does not answer', async ({ page }) => {
    await openHome(page, { health: 'down' });
    await expect(page.getByText('API unreachable')).toBeVisible();
  });
});

test.describe('error pages', () => {
  test('an unknown path shows a 404 page; signed out it leads to the help portal', async ({
    page,
  }) => {
    await mockBackend(page, { session: null });
    const response = await page.goto('/no-such-page');
    expect(response?.status()).toBe(404);
    await expect(page.getByText('Page not found')).toBeVisible();
    const link = page.getByRole('link', { name: 'Go to the help portal' });
    await expect(link).toHaveAttribute('href', '/portal');
    await expect(page.getByRole('link', { name: 'Back to the queue' })).toHaveCount(0);
  });

  test('signed-in staff get a way back to the queue on a 404', async ({ page }) => {
    await mockBackend(page);
    const response = await page.goto('/no-such-page');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('link', { name: 'Back to the queue' })).toHaveAttribute(
      'href',
      '/',
    );
    await expect(page.getByRole('link', { name: 'Go to the help portal' })).toHaveCount(0);
  });
});

test.describe('accessibility (axe, WCAG 2.x A/AA)', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`home page has no violations in ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openHome(page);
      await expect(page.getByText('API online')).toBeVisible();
      await page.getByText('Severity key').click();
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(results.violations).toEqual([]);
    });

    test(`command palette has no violations in ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openHome(page);
      await page.keyboard.press('ControlOrMeta+K');
      await expect(page.getByRole('dialog')).toBeVisible();
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(results.violations).toEqual([]);
    });
  }

  for (const scheme of ['light', 'dark'] as const) {
    test(`an open ticket with its panel, menus and note composer has no violations in ${scheme} mode`, async ({
      page,
    }) => {
      // Reduced motion: popovers and menus are at full opacity when axe measures their contrast.
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 1440, height: 900 });
      await openHome(page);
      await page.goto('/?ticket=OPS-1');
      await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
      await expect(page.getByRole('heading', { name: 'Cannot log in', level: 3 })).toBeVisible();
      await expect(page.getByText('Hello from OPS-1')).toBeVisible();
      const check = async () => {
        const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
        expect(results.violations).toEqual([]);
      };
      await check();

      // The composer in note mode, and each tab of the panel.
      await page.getByRole('radio', { name: 'Internal note' }).click();
      await page.getByRole('textbox', { name: 'Internal note' }).fill('Looking into it');
      await check();
      await page.getByRole('tab', { name: 'Evidence', exact: true }).click();
      await check();
      await page.getByRole('tab', { name: 'Customer' }).click();
      await check();
      await page.getByRole('tab', { name: 'Details' }).click();

      // An inline field open, then the account menu with a submenu open.
      await page.getByRole('button', { name: /^Priority:/ }).click();
      await expect(page.getByRole('listbox', { name: 'Priority' })).toBeVisible();
      await check();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Account menu' }).click();
      await expect(page.getByRole('menuitemcheckbox', { name: 'Dark theme' })).toBeVisible();
      await check();
    });
  }

  test('unreachable-API state has no violations', async ({ page }) => {
    await openHome(page, { health: 'down' });
    await expect(page.getByText('API unreachable')).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });
});
