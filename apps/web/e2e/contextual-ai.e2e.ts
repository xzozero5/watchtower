import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { makeClaim, type InsightItem } from '@watchtower/shared';
import { join } from 'node:path';
import { dashboardOps } from '../src/test/dashboard-fixtures';
import { makeInsight } from '../src/test/ai-fixtures';
import { makeTicket, uuid } from '../src/test/fixtures';
import { mockBackend } from './backend';

const summaryText = 'Ticket volume rose this week. Review the oldest unassigned cases first.';
const insight: InsightItem = {
  element: 'dashboard.ops.volume',
  scope: 'instance',
  period: 'd7',
  mode: 'N',
  state: 'fresh',
  stateLabel: 'AI',
  asOf: new Date().toISOString(),
  facts: [{ id: 'volume', kind: 'metric', value: 42, text: '42 tickets created' }],
  claims: [
    makeClaim('42 tickets created', [{ kind: 'metric', label: 'Volume', href: '/dashboard' }]),
  ],
  narration: {
    id: uuid(451),
    claims: [makeClaim(summaryText, [{ kind: 'metric', label: 'Volume', href: '/dashboard' }])],
    generatedAt: new Date().toISOString(),
    mock: false,
  },
};
async function dashboard(page: Page, items: InsightItem[] = [insight]) {
  const backend = await mockBackend(page, {
    role: 'head',
    routes: {
      'GET /v1/dashboard/ops': () => ({ json: dashboardOps({}, 7) }),
      'GET /v1/insights': () => ({ json: { items } }),
      'GET /v1/assistant/starters': () => ({
        json: {
          state: 'ok',
          reason: null,
          starters: [],
          limits: { messagesPerHour: 30, remainingThisHour: 30 },
        },
      }),
    },
  });
  await page.goto('/dashboard');
  await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
  return backend;
}
for (const scheme of ['light', 'dark'] as const) {
  test(`summary-first follow-up preserves context without sending (${scheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    const backend = await dashboard(page);
    const summary = page.locator(
      '[data-testid="element-insight"][data-element="dashboard.ops.volume"]',
    );
    await expect(summary.getByText(summaryText)).toBeVisible();
    const action = summary.getByRole('button', { name: 'Ask AI about Volume' });
    await expect(action).toHaveText('Ask a follow-up');
    await expect(summary.locator('[data-slot="birdday-icon"]')).toHaveCount(0);
    expect(
      await summary
        .locator('li')
        .first()
        .evaluate((node) => {
          const followUp = node
            .closest('aside')
            ?.querySelector('[data-testid="insight-follow-up"]');
          return Boolean(
            followUp && node.compareDocumentPosition(followUp) & Node.DOCUMENT_POSITION_FOLLOWING,
          );
        }),
    ).toBe(true);
    const axe = await new AxeBuilder({ page })
      .include('[data-testid="element-insight"][data-element="dashboard.ops.volume"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(axe.violations).toEqual([]);
    await action.click();
    const panel = page.getByTestId('assistant-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Volume · instance · d7', { exact: true })).toBeVisible();
    await expect(panel.locator('[data-slot="birdday-avatar"]').first()).toHaveClass(/size-10/);
    expect(backend.to('POST', '/v1/assistant/messages')).toHaveLength(0);
  });
}
test('missing summary keeps a contextual fallback without inventing a card', async ({ page }) => {
  const backend = await dashboard(page, []);
  const action = page.getByRole('button', { name: 'Ask AI about Volume' });
  await expect(action).toHaveText('Ask a follow-up');
  await expect(
    page.locator('[data-testid="element-insight"][data-element="dashboard.ops.volume"]'),
  ).toHaveCount(0);
  await action.click();
  await expect(page.getByTestId('assistant-panel')).toBeVisible();
  expect(backend.to('POST', '/v1/assistant/messages')).toHaveLength(0);
});
test('ticket follow-up follows its real brief with one clear mascot identity', async ({ page }) => {
  const backend = await mockBackend(page, {
    tickets: [makeTicket(1)],
    ai: { 'OPS-1': makeInsight() },
  });
  await page.goto('/?ticket=OPS-1');
  const brief = page.getByTestId('ai-brief');
  await expect(brief.getByTestId('ai-summary')).toBeVisible();
  await expect(brief.locator('[data-slot="birdday-avatar"]')).toHaveCount(1);
  await expect(brief.locator('[data-slot="birdday-avatar"]')).toHaveClass(/size-8/);
  await expect(
    brief.getByTestId('ai-brief-follow-up').getByRole('button', { name: 'Ask AI about OPS-1' }),
  ).toHaveText('Ask a follow-up');
  await expect(page.getByRole('button', { name: 'Ask AI about OPS-1' })).toHaveCount(1);
  expect(backend.to('POST', '/v1/assistant/messages')).toHaveLength(0);
});
// Optional visual evidence. These captures work against the unchanged baseline image too;
// regression assertions above run separately only against the candidate build.
for (const width of [1440, 390]) {
  test(`visual capture summary ${String(width)}`, async ({ page }) => {
    const target = process.env.UI_SHOTS;
    test.skip(!target, 'Set UI_SHOTS to capture synthetic visual evidence');
    if (!target) return;
    await page.setViewportSize({ width, height: 900 });
    await dashboard(page);
    await expect(page.getByText(summaryText)).toBeVisible();
    await page.getByText(summaryText).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(target, `summary-${String(width)}.png`) });
    await page.getByRole('button', { name: 'Ask AI about Volume' }).click();
    const panel = page.getByTestId('assistant-panel');
    await expect(panel).toBeVisible();
    await panel.screenshot({ path: join(target, `assistant-${String(width)}.png`) });
  });
}
