import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { DEFAULT_ROLE_PERMISSIONS } from '@watchtower/shared';

import { makeAutonomy } from '../src/test/console-fixtures';
import { makeSession } from '../src/test/fixtures';
import {
  makeGateReport,
  makePromotion,
  STAGE3_INTENT_ID,
  stage3Routes,
} from '../src/test/stage3-fixtures';

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

type Options = Parameters<typeof stage3Routes>[0] & { owner?: boolean };

/** The Stage 3 reads of the mock api as responders, plus the instance switch (`autosendFlag`). */
function stage3(options: Options = {}) {
  const base = stage3Routes(options);
  const responders = Object.fromEntries(
    Object.entries(base).map(([key, value]) => [key.replace(':id', STAGE3_INTENT_ID), () => value]),
  );
  return {
    ...responders,
    'GET /v1/autonomy': () => ({
      json: makeAutonomy({ autosendFlag: options.flag ?? true }),
    }),
    ...(options.owner
      ? {
          'GET /v1/auth/session': () => ({
            json: makeSession('head', {
              permissions: [...DEFAULT_ROLE_PERMISSIONS.head, 'ai.autonomy.owner_approve'],
            }),
          }),
        }
      : {}),
  };
}

async function openTab(page: Page) {
  await open(page, `/admin/intents/${STAGE3_INTENT_ID}`);
  await page.getByRole('tab', { name: 'Stage 3' }).click();
  await expect(page.getByRole('heading', { name: 'Gate report' })).toBeVisible();
}

test.describe('Stage 3 (mock backend)', () => {
  test('switch off: the button to ask is off, the reason is on the page, and it passes axe', async ({
    page,
  }) => {
    await mockConsole(page, 'head', stage3({ flag: false }));
    await openTab(page);
    await expect(page.getByRole('button', { name: 'Ask the owner for Stage 3' })).toBeDisabled();
    await expect(page.getByText(/switched off for this instance/).first()).toBeVisible();
    await expect(page.getByRole('table', { name: 'Checks of the gate report' })).toContainText(
      'Pass',
    );
    await expectNoViolations(page);
  });

  test('red report: the button stays off and says the report is red', async ({ page }) => {
    await mockConsole(page, 'head', stage3({ report: makeGateReport('red') }));
    await openTab(page);
    await expect(page.getByRole('button', { name: 'Ask the owner for Stage 3' })).toBeDisabled();
    await expect(page.getByText(/gate report is red/)).toBeVisible();
    await expect(page.getByText('Fail', { exact: true })).toBeVisible();
    await expectNoViolations(page);
  });

  test('green report: the head asks with a reason, and the dialog passes axe', async ({ page }) => {
    const backend = await mockConsole(page, 'head', {
      ...stage3(),
      [`POST /v1/intents/${STAGE3_INTENT_ID}/autonomy/promotions`]: () => ({
        json: makePromotion(),
      }),
    });
    await openTab(page);
    await page.getByRole('button', { name: 'Ask the owner for Stage 3' }).click();
    const dialog = page.getByRole('dialog', {
      name: 'Ask the owner to move this intent to Stage 3',
    });
    await expect(dialog).toBeVisible();
    await expectNoViolations(page);
    await dialog.getByLabel(/Reason/).fill('Four weeks green');
    await dialog.getByRole('button', { name: 'Send the request' }).click();
    await expect
      .poll(() => backend.to('POST', `/v1/intents/${STAGE3_INTENT_ID}/autonomy/promotions`).length)
      .toBe(1);
  });

  test('owner: approve needs the typed key, and the dialog passes axe', async ({ page }) => {
    const request = makePromotion('requested');
    const backend = await mockConsole(page, 'head', {
      ...stage3({ open: request, owner: true }),
      [`POST /v1/autonomy/promotions/${request.id}/decide`]: () => ({
        json: { status: 'approved', selfApproved: false },
      }),
    });
    await openTab(page);
    await page.getByRole('button', { name: 'Approve…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Approve Stage 3 for billing' });
    await expect(dialog).toBeVisible();
    await expectNoViolations(page);
    await dialog.getByLabel(/Reason/).fill('Reviewed the report');
    await dialog.getByLabel(/Type the key of the intent/).fill('wrong');
    await expect(dialog.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
    await dialog.getByLabel(/Type the key of the intent/).fill('billing');
    await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect
      .poll(() => backend.to('POST', `/v1/autonomy/promotions/${request.id}/decide`).length)
      .toBe(1);
    expect(backend.to('POST', `/v1/autonomy/promotions/${request.id}/decide`)[0]?.body).toEqual({
      approve: true,
      reason: 'Reviewed the report',
      confirmKey: 'billing',
    });
  });

  test('Admin AI: the notice on automatic replies is editable by the head and passes axe', async ({
    page,
  }) => {
    await mockConsole(page, 'head');
    await open(page, '/admin/ai');
    await expect(page.getByRole('heading', { name: 'Notice on automatic replies' })).toBeVisible();
    await expect(page.getByLabel('Notice in English')).toHaveValue(/sent automatically/);
    await expectNoViolations(page);
  });
});
