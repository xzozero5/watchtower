import { OPEN_STATUSES } from '@watchtower/shared';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { makeInsight } from '../src/test/ai-fixtures';
import { makeMessage, makeTicket } from '../src/test/fixtures';

import { APP_ORIGIN, mockBackend } from './backend';
import { mockConsole } from './console-backend';
import { mockPortal, SAMPLE_VALUE } from './portal-backend';

test('PO audit: Home counts link to the same set of open tickets', async ({ page }) => {
  await mockConsole(page);
  await page.goto('/home');
  const unassigned = page.getByRole('link', { name: /^Unassigned\s*3/ });
  await expect(unassigned).toBeVisible();
  const unassignedUrl = new URL((await unassigned.getAttribute('href')) ?? '', page.url());
  expect(unassignedUrl.searchParams.get('status')?.split(',').sort()).toEqual(
    [...OPEN_STATUSES].sort(),
  );
  const risk = page.getByRole('link', { name: /^SLA at risk\s*7/ });
  const riskUrl = new URL((await risk.getAttribute('href')) ?? '', page.url());
  expect(riskUrl.searchParams.get('slaState')?.split(',').sort()).toEqual(['at_risk', 'breached']);
});

test('PO audit: AI wait action asks before leaving an unanswered customer waiting', async ({
  page,
}) => {
  const ticket = makeTicket(1, { status: 'open' });
  const backend = await mockBackend(page, {
    tickets: [ticket],
    timelines: { 'OPS-1': [makeMessage(1, ticket)] },
    ai: {
      'OPS-1': makeInsight({
        nextStep: { kind: 'wait_customer', label: 'Wait for the customer' },
        draft: undefined,
      }),
    },
  });
  await page.goto('/?ticket=OPS-1');
  await page.getByRole('button', { name: 'Wait for the customer', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Set Waiting on customer?' });
  await expect(dialog).toBeVisible();
  expect(backend.to('POST', '/v1/tickets/OPS-1/status')).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(backend.to('POST', '/v1/tickets/OPS-1/status')).toHaveLength(0);
  await page.getByRole('button', { name: 'Wait for the customer', exact: true }).click();
  await dialog.getByRole('button', { name: 'Set anyway', exact: true }).click();
  await expect
    .poll(() => backend.to('POST', '/v1/tickets/OPS-1/status').map((request) => request.body))
    .toEqual([{ status: 'waiting_on_customer' }]);
});

test('PO audit: staff can see and download a customer attachment', async ({ page }) => {
  const ticket = makeTicket(1);
  await mockBackend(page, {
    tickets: [ticket],
    timelines: {
      'OPS-1': [
        makeMessage(1, ticket, {
          attachments: [
            {
              filename: 'trace.log',
              objectKey: 'test/trace.log',
              size: 123,
              contentType: 'text/plain',
            },
          ],
        }),
      ],
    },
  });
  await page.route('**/v1/tickets/OPS-1/messages/*/attachments/0', (route) =>
    route.fulfill({
      status: 200,
      body: 'Example diagnostic text',
      headers: {
        'content-type': 'application/octet-stream',
        'access-control-allow-origin': new URL(page.url()).origin,
        'access-control-allow-credentials': 'true',
      },
    }),
  );
  await page.goto('/?ticket=OPS-1');
  await expect(page.getByRole('list', { name: 'Attachments' })).toContainText('trace.log');
  const a11y = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(a11y.violations).toEqual([]);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download trace.log', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('trace.log');
});

test('PO audit: a valid tracking fragment recovers an expired link without reloading', async ({
  page,
}) => {
  const portal = await mockPortal(page);
  await page.goto('/portal/tickets/OPS-12#token=expired-example');
  await expect(page.getByText('This link has expired', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset.auditDocument = 'same-document';
  });
  await page.goto(`/portal/tickets/OPS-12#token=${SAMPLE_VALUE}`);
  await expect(page.getByRole('heading', { name: 'OPS-12', level: 1 })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-audit-document', 'same-document');
  expect(page.url()).toBe(`${APP_ORIGIN}/portal/tickets/OPS-12`);
  expect(portal.to('GET', '/v1/portal/tickets/OPS-12').at(-1)?.headers['x-portal-token']).toBe(
    SAMPLE_VALUE,
  );
  const reads = portal.to('GET', '/v1/portal/tickets/OPS-12').length;
  await page.goto(`/portal/tickets/OPS-12#token=${SAMPLE_VALUE}`);
  await expect
    .poll(() => portal.to('GET', '/v1/portal/tickets/OPS-12').length)
    .toBeGreaterThan(reads);
  await expect(page.locator('html')).toHaveAttribute('data-audit-document', 'same-document');
  await expect.poll(() => new URL(page.url()).hash).toBe('');
});

test('PO audit: navigating away cancels a delayed AI wait decision', async ({ page }) => {
  const first = makeTicket(1, { status: 'open' });
  const second = makeTicket(2, { subject: 'Another request' });
  const entries = [makeMessage(1, first), makeMessage(2, first, { direction: 'outbound' })];
  const backend = await mockBackend(page, {
    tickets: [first, second],
    timelines: { 'OPS-1': entries },
    ai: {
      'OPS-1': makeInsight({
        nextStep: { kind: 'wait_customer', label: 'Wait for the customer' },
        draft: undefined,
      }),
    },
  });
  await page.goto('/?ticket=OPS-1');
  await expect(
    page.getByRole('region', { name: 'Conversation' }).getByText('Message body 2'),
  ).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finished!: () => void;
  const completed = new Promise<void>((resolve) => {
    finished = resolve;
  });
  await page.route('**/v1/tickets/OPS-1/timeline*', async (route) => {
    started();
    await gate;
    await route
      .fulfill({
        status: 200,
        json: { entries, nextCursor: null },
        headers: {
          'access-control-allow-origin': APP_ORIGIN,
          'access-control-allow-credentials': 'true',
        },
      })
      .catch(() => undefined);
    finished();
  });
  await page.getByRole('button', { name: 'Wait for the customer', exact: true }).click();
  await pending;
  await page.getByRole('option', { name: /OPS-2/ }).click();
  await expect(page.getByRole('heading', { name: 'Another request', level: 3 })).toBeVisible();
  release();
  await completed;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            resolve();
          }),
        ),
      ),
  );
  expect(backend.to('POST', '/v1/tickets/OPS-1/status')).toHaveLength(0);
  await expect(page.getByRole('dialog', { name: 'Set Waiting on customer?' })).toHaveCount(0);
});
