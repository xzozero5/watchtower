import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import {
  GMAIL_ACCOUNT,
  LINE_ACCOUNT,
  makeGmailStatus,
  makeIntegration,
  makeIntegrationList,
} from '../src/test/integrations-fixtures';

import { APP_ORIGIN } from './backend';
import { mockConsole } from './console-backend';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const GOOGLE_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=e2e';

async function open(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(new URL(path, APP_ORIGIN).href);
  await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
  await expect(page.getByText('Page not found', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('assistant-bubble')).toBeVisible();
}

/** The reads and writes of Admin / Integrations, in memory so a save shows in the next read. */
async function mockIntegrations(page: Page, role: 'head' | 'lead' = 'head') {
  const state = { tokenSet: false };
  const list = () =>
    makeIntegrationList({
      line: makeIntegration('line', {
        channelId: 'db',
        channelSecret: 'env',
        ...(state.tokenSet ? { channelAccessToken: 'db' as const } : {}),
      }),
    });
  const backend = await mockConsole(page, role, {
    'GET /v1/admin/integrations': () => ({ json: list() }),
    'PUT /v1/admin/integrations/line': (request) => {
      const body = request.body as { fields: Record<string, string> };
      if ('channelAccessToken' in body.fields) state.tokenSet = true;
      return { json: list().items.find((item) => item.key === 'line') };
    },
    'POST /v1/admin/integrations/line/test': () => ({
      json: {
        ok: true,
        mode: 'mock',
        identity: 'mock:line',
        message: 'All required fields are set.',
        checkedAt: '2026-11-02T03:00:00.000Z',
      },
    }),
    'GET /v1/admin/channel-accounts': () => ({ json: { items: [LINE_ACCOUNT, GMAIL_ACCOUNT] } }),
    'GET /v1/admin/integrations/gmail/oauth/status': () => ({ json: makeGmailStatus() }),
    'POST /v1/admin/integrations/gmail/oauth/start': () => ({
      json: {
        authorizationUrl: GOOGLE_URL,
        expiresAt: '2026-11-02T03:10:00.000Z',
        redirectUri: makeGmailStatus().redirectUri,
      },
    }),
  });
  return { ...backend, state };
}

test.describe('head: Admin / Integrations', () => {
  test('saves a typed value write-only, tests the connection with the fake, and reaches Google', async ({
    page,
  }) => {
    const backend = await mockIntegrations(page);
    await page.route('https://accounts.google.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>Google (stub)</title>' }),
    );
    await open(page, '/admin/integrations');

    // Channel accounts: the LINE webhook URL is there to copy.
    const accounts = page.getByRole('list', { name: 'Channel accounts' });
    await expect(accounts.getByText('Support LINE')).toBeVisible();
    await expect(accounts.getByLabel(/Webhook URL/)).toHaveValue(LINE_ACCOUNT.webhookUrl ?? '');

    // Credentials: the environment-set field is locked and names its variable; no value is shown.
    const line = page.getByRole('region', { name: 'LINE Official Account' });
    await expect(
      line.getByText('Set by environment variable LINE_CHANNEL_SECRET', { exact: false }),
    ).toBeVisible();
    await expect(line.getByRole('button', { name: /^Replace Channel secret/ })).toHaveCount(0);

    await line.getByRole('button', { name: /^Set Channel access token/ }).click();
    const input = line.getByLabel('New value for Channel access token');
    await expect(input).toHaveAttribute('type', 'password');
    await input.fill('token-for-the-e2e');

    await line.getByRole('button', { name: 'Test connection' }).click();
    await expect(line.getByText('Connected (built-in fake: nothing was contacted)')).toBeVisible();
    expect(backend.to('POST', '/v1/admin/integrations/line/test')[0]?.body).toEqual({
      fields: { channelAccessToken: 'token-for-the-e2e' },
    });

    await line.getByRole('button', { name: 'Save changes' }).click();
    await expect(line.getByLabel('New value for Channel access token')).toHaveCount(0);
    await expect(line.getByText('Configured')).toBeVisible();
    expect(backend.to('PUT', '/v1/admin/integrations/line')[0]?.body).toEqual({
      fields: { channelAccessToken: 'token-for-the-e2e' },
    });
    // Nothing on the page repeats the value.
    await expect(page.getByText('token-for-the-e2e')).toHaveCount(0);

    // Gmail: Connect sends the browser to Google with the typed mailbox.
    const gmail = page.getByRole('group', { name: 'Gmail connection' });
    await gmail.getByLabel('Support mailbox to connect').fill('support@example.com');
    await gmail.getByRole('button', { name: 'Connect Gmail' }).click();
    await page.waitForURL('https://accounts.google.com/**');
    expect(backend.to('POST', '/v1/admin/integrations/gmail/oauth/start')[0]?.body).toEqual({
      mailbox: 'support@example.com',
    });
  });

  test('shows the result Google sent back in ?gmail_oauth= and can dismiss it', async ({
    page,
  }) => {
    await mockIntegrations(page);
    await open(page, '/admin/integrations?gmail_oauth=scope_mismatch');
    await expect(
      page.getByText(
        'The mail provider granted other permissions than read and send mail. Nothing was saved.',
      ),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await page.waitForURL((url) => !url.search.includes('gmail_oauth'));
    await expect(page.getByText('Nothing was saved.')).toHaveCount(0);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no accessibility violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockIntegrations(page);
      await open(page, '/admin/integrations?gmail_oauth=connected');
      await expect(page.getByRole('region', { name: 'Discord' })).toBeVisible();
      await expect(page.getByRole('group', { name: 'Gmail connection' })).toBeVisible();
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html ?? ''}`)).toEqual([]);
    });
  }
});

test.describe('lead: Admin / Integrations', () => {
  test('is told it needs the Head role and the section is not listed', async ({ page }) => {
    await mockIntegrations(page, 'lead');
    await open(page, '/admin/integrations');
    await expect(page.getByText('It needs the Head role.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'LINE Official Account' })).toHaveCount(0);
    await expect(
      page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', {
        name: 'Integrations',
      }),
    ).toHaveCount(0);
  });
});
