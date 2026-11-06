import { expect, type Page, test } from '@playwright/test';
import { businessCalendarSchema } from '@watchtower/shared';

import { CALENDAR, ORG } from '../src/test/console-fixtures';
import { makeSession, uuid } from '../src/test/fixtures';

import { APP_ORIGIN, mockBackend } from './backend';
import { mockConsole } from './console-backend';
import { E2E_API_URL } from './constants';
import { mockOps, PUBLIC_TOKEN } from './ops-backend';
import { LIST_VALUE, mockPortal, SAMPLE_VALUE } from './portal-backend';
import { mockReports } from './reports-backend';
import { mockShift } from './shift-backend';

async function noAssistant(page: Page) {
  await expect(page.getByTestId('assistant-bubble')).toHaveCount(0);
  await expect(page.getByTestId('assistant-panel')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('option', { name: /Ask AI/ })).toHaveCount(0);
}

// This is UI visibility coverage, not proof of server RBAC. API requests stay in page.route mocks.
test.describe('T407c: workspace AND assistant.use', () => {
  const agent = makeSession('agent');
  const cases = [
    { name: 'agent', session: agent, allowed: true },
    { name: 'lead', session: makeSession('lead'), allowed: true },
    { name: 'head', session: makeSession('head'), allowed: true },
    { name: 'dev', session: makeSession('dev'), allowed: true },
    {
      name: 'staff without assistant.use',
      session: makeSession('agent', {
        permissions: agent.permissions.filter((p) => p !== 'assistant.use'),
      }),
      allowed: false,
    },
    {
      name: 'org-scoped staff with assistant.use',
      session: { ...agent, user: { ...agent.user, orgId: uuid(500) } },
      allowed: false,
    },
    {
      name: 'client even with assistant.use',
      session: makeSession('client', {
        permissions: [...makeSession('client').permissions, 'assistant.use'],
      }),
      allowed: false,
    },
  ];
  for (const entry of cases) {
    test(entry.name, async ({ page }) => {
      await mockBackend(page, { role: entry.session.user.role, session: entry.session });
      const response = await page.goto('/');
      expect(response?.status()).toBe(200);
      await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
      if (entry.session.user.role === 'dev') {
        await expect(
          page.getByRole('radio', { name: 'Waiting on dev', exact: true }),
        ).toBeVisible();
      } else {
        await expect(page.getByRole('region', { name: 'Conversation' })).toBeVisible();
      }
      if (!entry.allowed) {
        await noAssistant(page);
        return;
      }
      await expect(page.getByTestId('assistant-bubble')).toBeVisible();
      await page.keyboard.press('ControlOrMeta+k');
      await page.getByRole('combobox').fill('Ask AI');
      await expect(page.getByRole('option', { name: /Ask AI/ })).toBeVisible();
    });
  }
});

// Public layouts ignore an existing staff cookie/session too. Override only the exact auth route
// after the public fixture: registering a second catch-all backend would hide the public mocks.
async function staffSession(page: Page) {
  await page.context().addCookies([{ name: 'wt_at', value: 'e2e-staff-only', url: APP_ORIGIN }]);
  const calls: string[] = [];
  await page.route(`${E2E_API_URL}/v1/auth/session`, async (route) => {
    calls.push(route.request().method());
    await route.fulfill({
      json: makeSession('head'),
      headers: {
        'access-control-allow-origin': APP_ORIGIN,
        'access-control-allow-credentials': 'true',
      },
    });
  });
  return calls;
}

for (const staff of [false, true]) {
  test.describe(`T407c public (${staff ? 'staff session available' : 'anonymous'})`, () => {
    for (const entry of [
      { path: `/portal/tickets/OPS-12#token=${SAMPLE_VALUE}`, ready: 'OPS-12' },
      { path: '/portal/tickets/OPS-12#token=expired-example', ready: 'This link has expired' },
      { path: '/portal/my-requests', ready: 'My requests' },
      { path: `/portal/my-requests#token=${LIST_VALUE}`, ready: 'Old invoice question' },
      {
        path: '/portal/my-requests#token=wtl1.invalid-example',
        ready: 'This link has expired or was already used',
      },
    ]) {
      test(entry.path, async ({ page }) => {
        await mockPortal(page);
        const calls = staff ? await staffSession(page) : [];
        const response = await page.goto(entry.path);
        expect(response?.status()).toBe(200);
        await expect(page.getByText(entry.ready, { exact: true })).toBeVisible();
        await noAssistant(page);
        expect(calls).toEqual([]);
      });
    }

    for (const mode of ['confirm', 'unsubscribe'] as const) {
      test(`status ${mode}: ready, completed, invalid link`, async ({ page }) => {
        const backend = await mockOps(page);
        const calls = staff ? await staffSession(page) : [];
        await page.goto(`/status/${mode}#token=${PUBLIC_TOKEN}`);
        const action = mode === 'confirm' ? 'Confirm subscription' : 'Unsubscribe';
        await expect(page.getByRole('button', { name: action, exact: true })).toBeVisible();
        await noAssistant(page);
        expect(backend.to('POST', `/v1/status/subscriptions/${mode}`)).toHaveLength(0);
        await page.getByRole('button', { name: action, exact: true }).click();
        await expect(
          page.getByText(mode === 'confirm' ? 'You are subscribed.' : 'You are unsubscribed.'),
        ).toBeVisible();
        await noAssistant(page);
        await page.goto(`/status/${mode}`);
        await expect(page.getByText('This link is not valid or has expired.')).toBeVisible();
        await noAssistant(page);
        expect(calls).toEqual([]);
      });
    }

    test('disabled status page is the intended public not-found state', async ({ page }) => {
      await mockOps(page, { statusPageOpen: false });
      const calls = staff ? await staffSession(page) : [];
      await page.goto('/status');
      await expect(page.getByText('Page not found')).toBeVisible();
      await noAssistant(page);
      expect(calls).toEqual([]);
    });
  });
}

for (const path of ['/login', '/start']) {
  test(`signed-out ${path} settles on login without AI`, async ({ page }) => {
    await mockBackend(page, { session: null });
    await page.goto(path);
    await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
    await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
    await noAssistant(page);
  });

  test(`staff ${path} redirects to its console with AI`, async ({ page }) => {
    await mockBackend(page, { role: 'agent' });
    await page.goto(path);
    await expect(page).toHaveURL(`${APP_ORIGIN}/`);
    await expect(page.getByRole('region', { name: 'Queue' })).toBeVisible();
    await expect(page.getByTestId('assistant-bubble')).toBeVisible();
  });
}

// Remaining registry entries use the same module fixtures as their existing page tests. A 200
// document alone is insufficient: wait for the real read endpoint and its data/valid empty state.
test.describe('T407c remaining console registry routes', () => {
  const entries: {
    path: string;
    destination?: string;
    read: string;
    mock: (page: Page) => Promise<unknown>;
    ready: (page: Page) => Promise<void>;
  }[] = [
    {
      path: '/tickets/new',
      read: '/v1/orgs',
      mock: (page) => mockConsole(page),
      ready: async (page) => {
        await expect(page.getByRole('heading', { name: 'New ticket', exact: true })).toBeVisible();
        await expect(page.getByRole('option', { name: ORG.name, exact: true })).toBeAttached();
        await expect(
          page.getByRole('button', { name: 'Create ticket', exact: true }),
        ).toBeVisible();
      },
    },
    {
      path: '/dashboard/ceo/brief',
      read: '/v1/reports/ceo/brief/draft',
      mock: (page) => mockReports(page),
      ready: async (page) => {
        await expect(
          page.getByRole('heading', { name: 'Weekly brief draft', exact: true }),
        ).toBeVisible();
        await expect(
          page.getByText(
            'There is no draft to edit. The AI drafts one each week; the day and time are server settings.',
            { exact: true },
          ),
        ).toBeVisible();
      },
    },
    {
      path: '/other-mail',
      read: '/v1/inbound/other-mail',
      mock: (page) =>
        mockConsole(page, 'head', {
          'GET /v1/inbound/other-mail': () => ({ json: { items: [], nextCursor: null } }),
        }),
      ready: async (page) => {
        await expect(page.getByRole('heading', { name: 'Other mail', exact: true })).toBeVisible();
        await expect(
          page.getByText('No received message is waiting in this list.', { exact: true }),
        ).toBeVisible();
      },
    },
    {
      path: '/shift/brief',
      read: '/v1/shifts/brief',
      mock: (page) => mockShift(page),
      ready: async (page) => {
        await expect(page.getByRole('heading', { name: 'Daily brief', exact: true })).toBeVisible();
        await expect(
          page.getByRole('button', { name: 'Mark brief read', exact: true }),
        ).toBeVisible();
      },
    },
    {
      path: '/shift/handoff',
      read: '/v1/handoffs/current',
      mock: (page) => mockShift(page),
      ready: async (page) => {
        await expect(
          page.getByRole('button', { name: 'Start the handoff', exact: true }),
        ).toBeVisible();
        await expect(
          page.getByText(
            'The draft is pre-filled with your open tickets. Nothing is sent until you confirm.',
            { exact: true },
          ),
        ).toBeVisible();
      },
    },
    {
      path: '/admin',
      destination: '/admin/users',
      read: '/v1/users',
      mock: (page) => mockConsole(page),
      ready: async (page) => {
        await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
        await expect(page.getByRole('table').first()).toBeVisible();
      },
    },
    {
      path: '/admin/golden',
      read: '/v1/ai/golden',
      mock: (page) =>
        mockConsole(page, 'head', {
          'GET /v1/ai/golden': () => ({ json: { items: [] } }),
        }),
      ready: async (page) => {
        await expect(
          page.getByRole('heading', { name: 'Golden answers', exact: true }),
        ).toBeVisible();
        await expect(page.getByText('No golden answers yet', { exact: true })).toBeVisible();
      },
    },
    {
      path: `/admin/sla/calendars/${CALENDAR.id}`,
      read: `/v1/business-calendars/${CALENDAR.id}`,
      mock: async (page) => {
        businessCalendarSchema.parse(CALENDAR);
        return mockConsole(page);
      },
      ready: async (page) => {
        await expect(page.getByRole('heading', { name: CALENDAR.name, exact: true })).toBeVisible();
        await expect(page.getByText('New Year’s Eve', { exact: true })).toBeVisible();
      },
    },
  ];

  for (const entry of entries) {
    test(entry.path, async ({ page }) => {
      await entry.mock(page);
      const read = page.waitForResponse(
        (response) =>
          response.request().method() === 'GET' && new URL(response.url()).pathname === entry.read,
      );
      const document = await page.goto(entry.path);
      expect(document?.status()).toBe(200);
      expect((await read).status()).toBe(200);
      await expect(page).toHaveURL(`${APP_ORIGIN}${entry.destination ?? entry.path}`);
      await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
      await entry.ready(page);
      await expect(page.getByText('Page not found', { exact: true })).toHaveCount(0);
      await expect(page.getByTestId('assistant-bubble')).toBeVisible();
    });
  }
});

for (const staff of [false, true]) {
  for (const fault of ['network', 'server'] as const) {
    test(`T407c public fault: tracking ${fault}, staff=${String(staff)}`, async ({ page }) => {
      await mockPortal(page);
      const calls = staff ? await staffSession(page) : [];
      await page.route(`${E2E_API_URL}/v1/portal/tickets/OPS-12`, async (route) => {
        if (route.request().method() === 'OPTIONS') return route.fallback();
        if (fault === 'network') return route.abort('connectionrefused');
        return route.fulfill({
          status: 503,
          headers: { 'access-control-allow-origin': APP_ORIGIN },
          json: {
            statusCode: 503,
            error: 'Error',
            code: 'internal',
            message: 'Synthetic unavailable',
          },
        });
      });
      await page.goto(`/portal/tickets/OPS-12#token=${SAMPLE_VALUE}`);
      await expect(
        page.getByText(
          fault === 'network'
            ? "We couldn't reach the server. Check your connection and try again."
            : 'Something went wrong on our side. Try again in a moment.',
          { exact: true },
        ),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
      await noAssistant(page);
      expect(calls).toEqual([]);
    });

    test(`T407c public fault: status ${fault}, staff=${String(staff)}`, async ({ page }) => {
      await mockOps(page);
      const calls = staff ? await staffSession(page) : [];
      await page.route(`${E2E_API_URL}/v1/status`, async (route) => {
        if (route.request().method() === 'OPTIONS') return route.fallback();
        if (fault === 'network') return route.abort('connectionrefused');
        return route.fulfill({
          status: 503,
          headers: { 'access-control-allow-origin': APP_ORIGIN },
          json: {
            statusCode: 503,
            error: 'Error',
            code: 'internal',
            message: 'Synthetic unavailable',
          },
        });
      });
      await page.goto('/status');
      await expect(
        page.getByText('Could not load the status. Try again in a moment.', { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
      await noAssistant(page);
      expect(calls).toEqual([]);
    });
  }
}
