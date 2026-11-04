import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { uuid } from '../src/test/fixtures';

import { mockConsole } from './console-backend';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
}

async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html ?? ''}`)).toEqual([]);
}

test.describe('head: Home', () => {
  test('loads the counts and the at-risk list, and every number is a link to the queue', async ({
    page,
  }) => {
    await mockConsole(page);
    await open(page, '/home');
    const sla = page.getByRole('link', { name: /^SLA at risk\s*7/ });
    await expect(sla).toBeVisible();
    await expect(sla).toContainText('2 overdue');
    await expect(page.getByRole('link', { name: /^Unassigned\s*3/ })).toHaveAttribute(
      'href',
      /assignee=unassigned/,
    );
    const risk = page.getByRole('list', { name: 'SLA at risk' });
    await expect(risk.getByRole('listitem')).toHaveCount(2);
    await expect(page.getByText('Database and Redis: ready')).toBeVisible();
    await expect(page.getByRole('region', { name: 'AI', exact: true })).toContainText(
      'Stage 2 · Draft for approval',
    );
    await expect(page.getByRole('region', { name: 'AI', exact: true })).not.toContainText(
      'Stage 3',
    );
  });

  test('a number opens the queue with that filter', async ({ page }) => {
    await mockConsole(page);
    await open(page, '/home');
    await page.getByRole('link', { name: /^Unassigned\s*3/ }).click();
    await page.waitForURL(/\/\?.*assignee=unassigned/);
    await expect(page.getByRole('region', { name: 'Queue' })).toBeVisible();
  });

  test('g d and g a move between Home and Admin', async ({ page }) => {
    await mockConsole(page);
    await open(page, '/home');
    await page.keyboard.press('g');
    await page.keyboard.press('a');
    await page.waitForURL('**/admin/users');
    await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
    await page.keyboard.press('g');
    await page.keyboard.press('d');
    await page.waitForURL('**/home');
    await expect(page.getByRole('link', { name: 'Home', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no accessibility violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockConsole(page);
      await open(page, '/home');
      await expect(page.getByRole('link', { name: /^SLA at risk\s*7/ })).toBeVisible();
      await expectNoViolations(page);
    });
  }
});

test.describe('head: AI controls', () => {
  test('flips the kill switch with a reason, and the banner follows', async ({ page }) => {
    const backend = await mockConsole(page);
    await open(page, '/admin/ai');
    await page.getByRole('button', { name: /Turn on.*Stop all AI runs/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Stop all AI runs?' });
    await expect(dialog.getByLabel(/Reason/)).toBeFocused();
    await dialog.getByLabel(/Reason/).fill('provider outage');
    await dialog.getByRole('button', { name: 'Stop AI runs' }).click();
    await expect(dialog).toBeHidden();
    expect(backend.to('POST', '/v1/autonomy/switches')[0]?.body).toEqual({
      switch: 'ai_kill_switch',
      on: true,
      reason: 'provider outage',
    });
    const banner = page.getByTestId('ai-paused-banner');
    await expect(banner).toContainText('AI paused by Alex');
    await expect(page.getByRole('heading', { name: 'Stop all AI runs' })).toBeVisible();
  });

  test('the palette opens the same dialog and sends nothing until a reason is given', async ({
    page,
  }) => {
    const backend = await mockConsole(page);
    await open(page, '/home');
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: 'Command palette' }).fill('limit all');
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Limit all intents to Stage 2 or lower?' });
    await expect(dialog).toBeVisible();
    expect(backend.to('POST', '/v1/autonomy/switches')).toHaveLength(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(backend.to('POST', '/v1/autonomy/switches')).toHaveLength(0);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`the confirm dialog has no accessibility violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockConsole(page);
      await open(page, '/admin/ai');
      await page.getByRole('button', { name: /Turn on.*Stop all AI runs/ }).click();
      await expect(page.getByRole('dialog', { name: 'Stop all AI runs?' })).toBeVisible();
      await expectNoViolations(page);
    });
  }
});

test.describe('head: intents', () => {
  test('changes an intent from stage 1 to 2 with a reason, and never offers stage 3', async ({
    page,
  }) => {
    const backend = await mockConsole(page);
    await open(page, `/admin/intents/${uuid(700)}`);
    await page.getByRole('tab', { name: 'Autonomy' }).click();
    const group = page.getByRole('radiogroup', { name: 'Stage' });
    await expect(group.getByRole('radio')).toHaveCount(3);
    await expect(page.getByRole('radio', { name: /Stage 3/ })).toHaveCount(0);
    await group.getByRole('radio', { name: 'Stage 2 · Draft for approval' }).click();
    await page.getByLabel('Reason (required)').fill('eval run passed');
    await page.getByRole('button', { name: 'Change stage' }).click();
    await expect(page.getByText(/Stage changed to Stage 2/)).toBeVisible();
    expect(backend.to('POST', `/v1/intents/${uuid(700)}/autonomy`)[0]?.body).toEqual({
      stage: 2,
      reason: 'eval run passed',
    });
  });

  test('lists intents with their stage badge', async ({ page }) => {
    await mockConsole(page);
    await open(page, '/admin/intents');
    const table = page.getByRole('table', { name: 'Intents' });
    await expect(table.getByText('Stage 1 · Suggest')).toBeVisible();
    await expect(table.getByText('Pinned')).toBeVisible();
  });
});

test.describe('lead', () => {
  test('sees the AI controls but cannot change them', async ({ page }) => {
    await mockConsole(page, 'lead');
    await open(page, '/admin/ai');
    await expect(page.getByText('Only the head can change these.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Turn o/ })).toHaveCount(0);
    // Sections the lead may not open are not listed.
    const nav = page.getByRole('navigation', { name: 'Admin sections' });
    await expect(nav.getByRole('link', { name: 'Audit log' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'SLA' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Users' })).toBeVisible();
  });

  test('is told the audit log needs the head role', async ({ page }) => {
    await mockConsole(page, 'lead');
    await open(page, '/admin/audit');
    await expect(page.getByText('It needs the Head role.')).toBeVisible();
  });
});

test.describe('agent', () => {
  test('has neither Home nor Admin in the rail', async ({ page }) => {
    await mockConsole(page, 'agent');
    await open(page, '/');
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav.getByRole('button', { name: 'Queue' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Home' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Admin' })).toHaveCount(0);
  });
});

test.describe('admin pages: accessibility', () => {
  for (const path of [
    '/admin/users',
    '/admin/audit',
    '/admin/orgs',
    '/admin/sla',
    '/admin/queues',
  ]) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`${path} (${scheme})`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await mockConsole(page);
        await open(page, path);
        await expect(page.getByRole('table').first()).toBeVisible();
        await expectNoViolations(page);
      });
    }
  }
});
