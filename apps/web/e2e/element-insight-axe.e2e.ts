import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { dashboardOps } from '../src/test/dashboard-fixtures';
import { APP_ORIGIN, mockBackend } from './backend';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

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

async function open(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(new URL(path, APP_ORIGIN).href);
  await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
  await expect(page.getByText('Page not found', { exact: true })).toHaveCount(0);
}

const mockInsights = [
  {
    element: 'dashboard.ops.volume',
    scope: 'instance',
    period: 'd7',
    mode: 'N',
    state: 'fresh',
    stateLabel: 'AI · 5m ago',
    asOf: new Date().toISOString(),
    facts: [{ id: 'f1', kind: 'metric', value: 42, text: '42 tickets created' }],
    claims: [
      {
        text: 'Deterministic system claim for volume',
        evidence: [{ kind: 'metric', label: 'Volume', href: '/ops/incidents' }],
        uncited: false,
      },
    ],
    narration: {
      id: 'a0000000-0000-4000-8000-000000000042',
      claims: [
        {
          text: 'AI observed ticket volume spike this week',
          evidence: [{ kind: 'metric', label: 'Volume', href: '/ops/incidents' }],
          uncited: false,
        },
      ],
      generatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      mock: false,
    },
  },
  {
    element: 'dashboard.ops.sla',
    scope: 'instance',
    period: 'd7',
    mode: 'N',
    state: 'fresh',
    stateLabel: 'AI · 5m ago',
    asOf: new Date().toISOString(),
    facts: [{ id: 'f2', kind: 'metric', value: 98, text: '98% SLA compliance' }],
    claims: [
      {
        text: 'Deterministic system claim for SLA',
        evidence: [{ kind: 'metric', label: 'SLA', href: '/ops/incidents' }],
        uncited: false,
      },
    ],
    narration: {
      id: 'a0000000-0000-4000-8000-000000000043',
      claims: [
        {
          text: 'AI reports 98% of tickets met resolution SLA',
          evidence: [{ kind: 'metric', label: 'SLA', href: '/ops/incidents' }],
          uncited: false,
        },
      ],
      generatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      mock: false,
    },
  },
];

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`ElementInsight accessibility (${scheme})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    });

    test('embedded insight and 👎 feedback dialog have no axe violations', async ({ page }) => {
      await mockBackend(page, {
        role: 'head',
        routes: {
          'GET /v1/dashboard/ops': () => ({ json: dashboardOps({}, 7) }),
          'GET /v1/insights': () => ({ json: { items: mockInsights } }),
        },
      });

      await open(page, '/dashboard');

      // Wait for the element insight to be rendered
      const insight = page.locator('[data-testid="element-insight"]').first();
      await expect(insight).toBeVisible();

      // State badge and citation claim should be visible
      await expect(insight.locator('[data-testid="insight-state-badge"]')).toBeVisible();
      await expect(insight.getByText('AI observed ticket volume spike this week')).toBeVisible();

      // Verify no axe violations on the page with embedded insight
      await expectNoViolations(page);

      // Open the thumbs-down reason dialog
      const downButton = insight.locator('[data-testid="insight-feedback-down"]');
      await expect(downButton).toBeVisible();
      await downButton.click();

      // Verify the dialog is visible and accessible
      const dialog = page.locator('[data-testid="insight-feedback-dialog"]');
      await expect(dialog).toBeVisible();

      // Verify role="radiogroup" with accessible name
      const radiogroup = dialog.locator('[role="radiogroup"]');
      await expect(radiogroup).toBeVisible();
      await expect(radiogroup).toHaveAttribute('aria-labelledby');

      // Verify no axe violations in the open dialog
      await expectNoViolations(page);

      // Press Escape to verify accessible dismiss
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });
  });
}
