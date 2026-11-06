import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import type { DeadOutboxItem, EvidenceCard, OutboxHealth, TicketTools } from '@watchtower/shared';

import { ORG } from '../src/test/console-fixtures';
import { uuid } from '../src/test/fixtures';

import { APP_ORIGIN, mockBackend } from './backend';
import { mockConsole } from './console-backend';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const AT = '2026-11-02T02:50:00.000Z';

async function open(page: Page, path: string, assistantAllowed = true) {
  const response = await page.goto(path);
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(new URL(path, APP_ORIGIN).href);
  await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
  await expect(page.getByText('Page not found', { exact: true })).toHaveCount(0);
  if (assistantAllowed) {
    await expect(page.getByTestId('assistant-bubble')).toBeVisible();
  } else {
    await expect(page.getByTestId('assistant-bubble')).toHaveCount(0);
    await expect(page.getByTestId('assistant-panel')).toHaveCount(0);
  }
}

async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html ?? ''}`)).toEqual([]);
}

const HEALTH: OutboxHealth = {
  generatedAt: AT,
  pending: 3,
  dead: 2,
  oldestPendingSeconds: 150,
  status: 'warning',
  warningSeconds: 120,
  criticalSeconds: 600,
  byQueue: [{ queue: 'outbound', pending: 3, dead: 2 }],
};

const CUSTOMER_ROW: DeadOutboxItem = {
  id: uuid(1),
  queue: 'outbound',
  jobName: 'dispatch',
  jobId: 'delivery-x-1',
  attempts: 30,
  lastError: 'ConnectionError: redis down',
  createdAt: AT,
  finishedAt: AT,
  replayable: true,
  notReplayableReason: null,
  effect: {
    kind: 'customer_message',
    channel: 'gmail',
    channelAccountName: 'Ops mailbox',
    origin: 'reply',
    ticketNumber: 14,
    mayAcknowledge: false,
  },
};

const STUCK_ROW: DeadOutboxItem = {
  ...CUSTOMER_ROW,
  id: uuid(2),
  queue: 'email',
  jobName: 'send',
  replayable: false,
  notReplayableReason: 'The payload was cleared',
  effect: null,
};

test.describe('head: Outbox', () => {
  test('shows the oldest waiting job, asks before a resend that reaches a customer, then resends', async ({
    page,
  }) => {
    let rows = [CUSTOMER_ROW, STUCK_ROW];
    const backend = await mockConsole(page, 'head', {
      'GET /v1/ops/outbox': () => ({ json: HEALTH }),
      'GET /v1/ops/outbox/dead': () => ({ json: { items: rows, nextCursor: null } }),
      [`POST /v1/ops/outbox/${CUSTOMER_ROW.id}/resend`]: () => {
        rows = [STUCK_ROW];
        return {
          json: {
            id: CUSTOMER_ROW.id,
            queue: 'outbound',
            jobId: 'delivery-x-1-resend-1',
            status: 'pending',
          },
        };
      },
    });
    await open(page, '/admin/outbox');
    const health = page.getByRole('region', { name: 'Outbox health' });
    await expect(health.getByText('Oldest waiting')).toBeVisible();
    await expect(health.getByText('2m')).toBeVisible();
    await expect(health.getByText('Late')).toBeVisible();
    const table = page.getByRole('table', { name: 'Dead outbox rows' });
    await expect(table.getByText('Send a message to a customer')).toBeVisible();
    await expect(table.getByText('Cannot be resent: The payload was cleared')).toBeVisible();
    await expectNoViolations(page);

    await page.getByRole('button', { name: 'Resend outbound · dispatch' }).click();
    const dialog = page.getByRole('dialog', { name: 'Resend outbound · dispatch?' });
    await expect(dialog).toContainText('ticket OPS-14, by Email (Ops mailbox)');
    await expect(dialog).toContainText('message text is not shown here');
    await expectNoViolations(page);
    expect(backend.to('POST', `/v1/ops/outbox/${CUSTOMER_ROW.id}/resend`)).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Resend' }).click();
    await expect(dialog).toBeHidden();
    expect(backend.to('POST', `/v1/ops/outbox/${CUSTOMER_ROW.id}/resend`)).toHaveLength(1);
    await expect(table.getByText('Send a message to a customer')).toBeHidden();
  });

  test('a lead is told this page is for the head', async ({ page }) => {
    await mockConsole(page, 'lead');
    await open(page, '/admin/outbox');
    await expect(page.getByText('You don’t have access to this page.')).toBeVisible();
  });

  test('is readable in dark, and in Thai', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await mockConsole(page, 'head', {
      'GET /v1/ops/outbox': () => ({ json: HEALTH }),
      'GET /v1/ops/outbox/dead': () => ({ json: { items: [CUSTOMER_ROW], nextCursor: null } }),
    });
    await page.context().addCookies([{ name: 'wt-locale', value: 'th', url: APP_ORIGIN }]);
    await open(page, '/admin/outbox');
    await expect(page.getByText('ส่งข้อความถึงลูกค้า')).toBeVisible();
    await expectNoViolations(page);
  });
});

test.describe('head: organization tiers', () => {
  test('opens the tier list from the organization and adds a tier', async ({ page }) => {
    const tiers = [{ slug: 'gold', name: 'Gold', sortOrder: 1 }];
    const backend = await mockConsole(page, 'head', {
      'GET /v1/org-tiers': () => ({ json: { tiers } }),
      'POST /v1/org-tiers': (request) => {
        const body = request.body as { slug: string; name: string; sortOrder: number };
        tiers.push(body);
        return { status: 201, json: body };
      },
    });
    await open(page, `/admin/orgs/${ORG.id}`);
    await page.getByRole('button', { name: 'Manage tiers' }).click();
    const sheet = page.getByRole('dialog', { name: 'Tiers' });
    await expect(sheet.getByRole('list', { name: 'Tiers' })).toContainText('Gold');
    await expectNoViolations(page);
    await sheet.getByPlaceholder('Name').fill('Platinum');
    await sheet.getByPlaceholder('Slug').fill('platinum');
    await sheet.getByRole('button', { name: 'Add tier' }).click();
    await expect(sheet.getByRole('list', { name: 'Tiers' })).toContainText('Platinum');
    expect(backend.to('POST', '/v1/org-tiers')).toHaveLength(1);
  });
});

const TOOLS: TicketTools = {
  intentKey: null,
  buttons: [
    {
      templateId: uuid(11),
      kind: 'logs',
      name: 'recent-errors',
      title: 'Recent errors',
      inputParams: [],
      connected: true,
      mock: true,
    },
    {
      templateId: uuid(13),
      kind: 'logs',
      name: 'deploys',
      title: 'Recent deploys',
      inputParams: [],
      connected: false,
      mock: false,
    },
  ],
};

const CARD: EvidenceCard = {
  id: uuid(21),
  ticketId: uuid(1),
  incidentId: null,
  kind: 'logs',
  templateId: uuid(11),
  templateName: 'recent-errors',
  title: 'Recent errors',
  summary: '12 entries, 02:00 to 03:00',
  excerpt: 'ERROR timeout calling <email>',
  resultCount: 12,
  truncated: false,
  maskedColumns: [],
  windowFrom: null,
  windowTo: null,
  mock: true,
  createdBy: uuid(900),
  createdAt: AT,
};

test.describe('ticket: investigation buttons', () => {
  for (const [role, scheme] of [
    ['agent', 'light'],
    ['dev', 'dark'],
  ] as const) {
    test(`${role}: run a check and see the pinned result (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      let cards: EvidenceCard[] = [];
      const backend = await mockBackend(page, {
        role,
        routes: {
          'GET /v1/tickets/OPS-1/tools': () => ({ json: TOOLS }),
          // A developer may not list a ticket's pinned cards: the api answers 403.
          'GET /v1/tickets/OPS-1/evidence': () =>
            role === 'dev'
              ? {
                  status: 403,
                  json: {
                    statusCode: 403,
                    error: 'Error',
                    code: 'forbidden',
                    message: 'forbidden',
                  },
                }
              : { json: { items: cards } },
          'POST /v1/tickets/OPS-1/tools/run': () => {
            cards = [CARD];
            return { status: 201, json: CARD };
          },
        },
      });
      await page.setViewportSize({ width: 1400, height: 900 });
      await open(page, '/?ticket=OPS-1');
      // A developer has their own screen: the ticket opens from the list.
      if (role === 'dev') await page.getByRole('button', { name: /^OPS-1 / }).click();
      const section = page.getByRole('region', { name: 'Investigate' });
      await expect(section.getByRole('button', { name: /Recent errors/ })).toBeVisible();
      await expect(section.getByText('Mock').first()).toBeVisible();
      await expect(section.getByRole('button', { name: /Recent deploys/ })).toBeDisabled();
      await expect(section.getByText('Not connected')).toBeVisible();
      await expectNoViolations(page);

      await section.getByRole('button', { name: /Recent errors/ }).click();
      const pinned = section.getByRole('list', { name: 'Pinned results' });
      await expect(pinned).toContainText('12 results');
      await expect(pinned).toContainText('Mock');
      expect(backend.to('POST', '/v1/tickets/OPS-1/tools/run')).toHaveLength(1);
      // Nothing outside the saved checks: no ad-hoc call is ever made from a ticket.
      expect(backend.requests.some((request) => request.path.includes('/investigate/adhoc'))).toBe(
        false,
      );
      await expectNoViolations(page);
    });
  }

  test('a customer on the portal side never sees the section', async ({ page }) => {
    await mockBackend(page, { role: 'client' });
    await open(page, '/', false);
    await expect(page.getByRole('region', { name: 'Investigate' })).toHaveCount(0);
  });
});
