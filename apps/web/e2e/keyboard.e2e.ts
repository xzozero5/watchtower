import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { makeInsight } from '../src/test/ai-fixtures';
import { makeSession, uuid } from '../src/test/fixtures';

import { type BackendOptions, mockBackend, makeTicket } from './backend';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function openWorkspace(page: Page, options: BackendOptions = {}, path = '/') {
  const backend = await mockBackend(page, options);
  await page.goto(path);
  await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-state', 'open');
  return backend;
}

const queue = (page: Page) => page.getByRole('region', { name: 'Queue' });
const conversation = (page: Page) => page.getByRole('region', { name: 'Conversation' });
const assistant = (page: Page) => page.getByRole('region', { name: 'Details & AI' });
// The board has a listbox per section; the one holding the keyboard has this id.
const listbox = (page: Page) => page.locator('#queue-listbox');
const row = (page: Page, key: string) => page.getByRole('option', { name: new RegExp(key) });

test.describe('pane keys (docs/06-UI-SPEC.md section 14)', () => {
  test('F6 and Alt+1..3 move focus between panes, even from the search box', async ({ page }) => {
    await openWorkspace(page);
    await expect(row(page, 'OPS-1')).toBeVisible();
    await page.keyboard.press('/');
    await expect(page.getByRole('searchbox', { name: 'Search tickets' })).toBeFocused();

    await page.keyboard.press('F6');
    await expect(conversation(page)).toBeFocused();
    await page.keyboard.press('F6');
    await expect(assistant(page)).toBeFocused();
    await page.keyboard.press('Shift+F6');
    await expect(conversation(page)).toBeFocused();
    await page.keyboard.press('Alt+1');
    await expect(listbox(page)).toBeFocused();
    await page.keyboard.press('Alt+3');
    await expect(assistant(page)).toBeFocused();
    // The focused pane is outlined with the 2px focus ring.
    const outline = await page
      .locator('#pane-assistant')
      .evaluate((element) => getComputedStyle(element).outlineWidth);
    expect(outline).toBe('2px');
  });

  test('Enter on the list and O open the ticket and move focus into the conversation', async ({
    page,
  }) => {
    await openWorkspace(page);
    await expect(row(page, 'OPS-1')).toBeVisible();
    await page.keyboard.press('j');
    await page.keyboard.press('Enter');
    await expect(conversation(page)).toBeFocused();
    await expect(
      conversation(page).getByRole('heading', { name: 'Cannot log in', level: 3 }),
    ).toBeVisible();

    // g then q returns to the list.
    await page.keyboard.press('g');
    await page.keyboard.press('q');
    await expect(listbox(page)).toBeFocused();
    await page.keyboard.press('j');
    await page.keyboard.press('o');
    await expect(conversation(page)).toBeFocused();
    await expect(page).toHaveURL(/\?ticket=OPS-2$/);
  });

  test('physical keys work on a Thai layout: Alt+digit and g q', async ({ page }) => {
    await openWorkspace(page);
    await expect(row(page, 'OPS-1')).toBeVisible();
    await page.evaluate(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: '๒', code: 'Digit2', altKey: true, bubbles: true }),
      );
    });
    await expect(conversation(page)).toBeFocused();
    await page.evaluate(() => {
      for (const [key, code] of [
        ['ไ', 'KeyG'],
        ['ๆ', 'KeyQ'],
      ] as const) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true }));
      }
    });
    await expect(listbox(page)).toBeFocused();
  });

  test('the queue listbox and the folded rails have no axe violations', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openWorkspace(page, {}, '/?ticket=OPS-1');
    await page.keyboard.press('Alt+1');
    await expect(listbox(page)).toBeFocused();
    let results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toEqual([]);

    await page.keyboard.press('[');
    await page.keyboard.press(']');
    await expect(page.getByRole('button', { name: 'Expand the queue' })).toBeVisible();
    results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`the phone tabs and the draft's A/E/R buttons have no axe violations in ${scheme} mode`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 375, height: 800 });
      await openWorkspace(page, { ai: { 'OPS-1': makeInsight() } }, '/?ticket=OPS-1');
      await expect(page.getByRole('tab', { name: 'Conversation' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.getByRole('group', { name: 'Draft actions' })).toBeVisible();
      // Target size and contrast are measured on still pixels, not halfway through a transition.
      const settled = () =>
        page.waitForFunction(() =>
          document.getAnimations().every((animation) => animation.playState !== 'running'),
        );
      await settled();
      let results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(results.violations).toEqual([]);

      await page.getByRole('tab', { name: 'Queue' }).click();
      await settled();
      results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(results.violations).toEqual([]);
    });
  }
});

test.describe('single-key shortcuts preference (WCAG 2.1.4)', () => {
  test('can be turned off: letters do nothing, Ctrl+K and F6 still work, the choice survives a reload', async ({
    page,
  }) => {
    await openWorkspace(page, {}, '/?ticket=OPS-1');
    await expect(row(page, 'OPS-1')).toBeVisible();
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: /Show keyboard shortcuts/ }).click();
    await page
      .getByRole('dialog', { name: 'Keyboard shortcuts' })
      .getByRole('checkbox', { name: 'Single-key shortcuts' })
      .uncheck();
    await page.keyboard.press('Escape');

    for (const key of ['j', 'k', 'c', 'n', 's', '/', '[', ']', 'Shift+?']) {
      await page.keyboard.press(key);
    }
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(row(page, 'OPS-1')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('searchbox', { name: 'Search tickets' })).not.toBeFocused();
    await expect(page.getByRole('button', { name: 'Collapse the queue' })).toBeVisible();

    await page.keyboard.press('ControlOrMeta+K');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('F6');
    await expect(listbox(page)).toBeFocused();

    await page.reload();
    await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: /Show keyboard shortcuts/ }).click();
    await expect(
      page
        .getByRole('dialog', { name: 'Keyboard shortcuts' })
        .getByRole('checkbox', { name: 'Single-key shortcuts' }),
    ).not.toBeChecked();
    await page.keyboard.press('Escape');
    await expect(row(page, 'OPS-1')).toBeVisible();
    await page.keyboard.press('j');
    await expect(row(page, 'OPS-2')).toHaveAttribute('aria-selected', 'false');

    // The keyboard map says so, and its switch turns them back on.
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: /Show keyboard shortcuts/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog.getByText('Single-key shortcuts are off')).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toEqual([]);
    await dialog.getByRole('checkbox', { name: 'Single-key shortcuts' }).check();
    await expect(dialog.getByText('Single-key shortcuts are off')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('j');
    await expect(row(page, 'OPS-2')).toHaveAttribute('aria-selected', 'true');
  });

  test('a customer is not shown the note, status or AI keys in the keyboard map', async ({
    page,
  }) => {
    await openWorkspace(page, { role: 'client' });
    await page.keyboard.press('Shift+?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog.getByText('Write a public reply')).toBeVisible();
    await expect(dialog.getByText('Write an internal note')).toHaveCount(0);
    await expect(dialog.getByText('Approve the draft')).toHaveCount(0);
    await expect(dialog.getByText('Change the status of the open ticket')).toHaveCount(0);
  });
});

test.describe('a session that expires', () => {
  test('leaves nothing of the first person for the next one signing in on the same tab', async ({
    page,
  }) => {
    const sessionOf = (who: 'A' | 'B') =>
      makeSession('agent', {
        user: {
          id: who === 'A' ? uuid(900) : uuid(950),
          email: `${who.toLowerCase()}@example.com`,
          name: who === 'A' ? 'Alex Agent' : 'Bea Agent',
          role: 'agent',
          orgId: null,
        },
      });
    const state = { who: 'A' as 'A' | 'B', expired: false };
    const unauthenticated = () => ({
      status: 401,
      json: { statusCode: 401, error: 'E', code: 'unauthenticated', message: 'x' },
    });
    const own = {
      A: [
        makeTicket(1, { subject: 'Alex private ticket' }),
        makeTicket(2, { subject: 'Alex second' }),
      ],
      B: [makeTicket(1, { subject: 'Bea own ticket' })],
    };
    const guarded = (json: () => unknown) => () =>
      state.expired ? unauthenticated() : { json: json() };
    await mockBackend(page, {
      routes: {
        'GET /v1/auth/session': guarded(() => sessionOf(state.who)),
        'POST /v1/auth/refresh': unauthenticated,
        'POST /v1/auth/break-glass': () => {
          state.who = 'B';
          state.expired = false;
          return { json: sessionOf('B') };
        },
        'GET /v1/tickets': guarded(() => ({ items: own[state.who], nextCursor: null })),
        'GET /v1/tickets/OPS-1': guarded(() => own[state.who][0]),
        'GET /v1/tickets/OPS-2': guarded(() => own.A[1]),
        'GET /v1/tickets/OPS-1/timeline': guarded(() => ({ entries: [], nextCursor: null })),
        'GET /v1/tickets/OPS-2/timeline': guarded(() => ({ entries: [], nextCursor: null })),
      },
    });
    await page.goto('/?ticket=OPS-1');
    await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
    await expect(queue(page).getByText('Alex private ticket')).toBeVisible();
    await conversation(page)
      .getByRole('textbox', { name: 'Public reply' })
      .fill('Alex half written reply');

    // The session ends; the next call fails and the refresh fails too.
    state.expired = true;
    await row(page, 'OPS-2').click();
    await page.waitForURL('**/login');
    await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();

    // Bea signs in on the same tab, without a page load in between.
    await page.getByText('Emergency administrator sign-in').click();
    await page.getByLabel('Email address').last().fill('bea@example.com');
    await page.getByLabel('Password').fill('a long passphrase');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/');
    await expect(queue(page).getByText('Bea own ticket')).toBeVisible();
    await expect(page.getByText('Alex private ticket')).toHaveCount(0);
    await expect(page.getByText('Alex second')).toHaveCount(0);

    // Same ticket key, empty composer: Alex's unsent text is gone.
    await row(page, 'OPS-1').click();
    await expect(conversation(page).getByRole('textbox', { name: 'Public reply' })).toHaveValue('');
    await expect(page.getByText('Alex half written reply')).toHaveCount(0);
  });
});

test.describe('layout details', () => {
  test('a staff ticket opens with its key and subject visible, not scrolled away', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWorkspace(page, {}, '/?ticket=OPS-1');
    const heading = conversation(page).getByRole('heading', { name: 'Cannot log in', level: 3 });
    await expect(heading).toBeVisible();
    const pane = await conversation(page).boundingBox();
    const box = await heading.boundingBox();
    expect(box?.y ?? 0).toBeGreaterThanOrEqual((pane?.y ?? 0) - 1);
    await expect(conversation(page).getByText('OPS-1', { exact: true })).toBeVisible();
    await expect(conversation(page).getByRole('textbox', { name: 'Public reply' })).toBeVisible();
  });

  test('768 to 1023 px: the rail stays 56 px wide and the account menu opens from it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await openWorkspace(page);
    const rail = await page.getByRole('banner').boundingBox();
    expect(rail?.width).toBe(56);

    await page.getByRole('button', { name: 'Account menu' }).click();
    await expect(page.getByRole('menuitemcheckbox', { name: 'Dark theme' })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toEqual([]);
    await page.getByRole('menuitemcheckbox', { name: 'Dark theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('below 768 px the rail is a 48 px bar across the top', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openWorkspace(page);
    const bar = await page.getByRole('banner').boundingBox();
    expect(bar?.height).toBe(48);
    expect(bar?.width).toBe(390);
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();
  });

  test('1024 px and wider: Ctrl+B expands the rail to 220 px with words, and back', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openWorkspace(page);
    const rail = page.getByRole('banner');
    expect((await rail.boundingBox())?.width).toBe(56);
    await page.keyboard.press('ControlOrMeta+B');
    await expect.poll(async () => (await rail.boundingBox())?.width).toBe(220);
    await expect(rail.getByText('Queue', { exact: true })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+B');
    await expect.poll(async () => (await rail.boundingBox())?.width).toBe(56);
  });

  test('tooltips on the rail icons carry the shortcut, and show on keyboard focus', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openWorkspace(page);
    await page.getByRole('button', { name: 'Open command palette' }).focus();
    const tip = page.getByRole('tooltip');
    await expect(tip).toContainText('Open command palette');
    await expect(tip).toContainText('K');
  });
});
