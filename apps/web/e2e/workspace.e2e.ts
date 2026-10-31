import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { makeSession } from '../src/test/fixtures';

import { APP_ORIGIN, type BackendOptions, LIVE_CONFIG, mockBackend, makeTicket } from './backend';

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

test.describe('sign-in', () => {
  test('a signed-out visitor is sent to the login page', async ({ page }) => {
    await mockBackend(page, { session: null });
    await page.goto('/');
    await page.waitForURL('**/login');
    await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Continue with Google' })).toHaveAttribute(
      'href',
      /\/v1\/auth\/google\/start\?returnTo=%2F$/,
    );
  });

  test('a customer asks for a magic link and gets the same answer for any address', async ({
    page,
  }) => {
    const backend = await mockBackend(page, {
      session: null,
      routes: {
        'POST /v1/auth/magic-link/request': () => ({ status: 202, json: { status: 'accepted' } }),
      },
    });
    await page.goto('/login');
    const customers = page.getByRole('region', { name: 'Customers' });
    await customers.getByLabel('Email address').fill('someone@example.com');
    await customers.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await expect(customers.getByText('Check your email')).toBeVisible();
    expect(backend.to('POST', '/v1/auth/magic-link/request')[0]?.body).toEqual({
      email: 'someone@example.com',
    });
  });

  test('the emailed link signs the customer in and removes the token from the address bar', async ({
    page,
  }) => {
    const token = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
    let signedIn = false;
    const backend = await mockBackend(page, {
      role: 'client',
      routes: {
        'GET /v1/auth/session': () =>
          signedIn
            ? { json: makeSession('client') }
            : {
                status: 401,
                json: { statusCode: 401, error: 'E', code: 'unauthenticated', message: 'x' },
              },
        'POST /v1/auth/magic-link/verify': () => {
          signedIn = true;
          return { json: makeSession('client') };
        },
      },
    });
    await page.goto(`/login/magic#token=${token}`);
    await page.waitForURL((url) => url.pathname === '/');
    await expect(conversation(page)).toBeVisible();
    expect(backend.to('POST', '/v1/auth/magic-link/verify')[0]?.body).toEqual({ token });
    expect(page.url()).not.toContain(token);
  });

  test('a used link explains itself and offers a new one', async ({ page }) => {
    await mockBackend(page, {
      session: null,
      routes: {
        'POST /v1/auth/magic-link/verify': () => ({
          status: 401,
          json: { statusCode: 401, error: 'E', code: 'invalid_or_expired_link', message: 'x' },
        }),
      },
    });
    await page.goto('/login/magic#token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG');
    await expect(page.getByText('This sign-in link cannot be used')).toBeVisible();
    await page.getByRole('link', { name: 'Back to sign-in' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
  });

  test('break-glass form signs in and goes to the queue', async ({ page }) => {
    let signedIn = false;
    const backend = await mockBackend(page, {
      role: 'head',
      routes: {
        'GET /v1/auth/session': () =>
          signedIn
            ? { json: makeSession('head') }
            : {
                status: 401,
                json: { statusCode: 401, error: 'E', code: 'unauthenticated', message: 'x' },
              },
        'POST /v1/auth/break-glass': () => {
          signedIn = true;
          return { json: makeSession('head') };
        },
      },
    });
    await page.goto('/login');
    await page.getByText('Emergency administrator sign-in').click();
    await page.getByLabel('Email address').last().fill('admin@example.com');
    await page.getByLabel('Password').fill('a long passphrase');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/');
    await expect(queue(page)).toBeVisible();
    expect(backend.to('POST', '/v1/auth/break-glass')[0]?.body).toEqual({
      email: 'admin@example.com',
      password: 'a long passphrase',
    });
  });

  test('sign out returns to the login page', async ({ page }) => {
    const backend = await openWorkspace(page);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL('**/login');
    expect(backend.to('POST', '/v1/auth/logout')).toHaveLength(1);
  });
});

test.describe('queue and conversation', () => {
  test('J and K move through tickets and open them; the address follows', async ({ page }) => {
    await openWorkspace(page);
    // J on an empty (still loading) queue does nothing by design; wait for the rows first.
    await expect(queue(page).getByRole('button', { name: /OPS-1/ })).toBeVisible();
    await page.keyboard.press('j');
    await expect(
      conversation(page).getByRole('heading', { name: 'Cannot log in', level: 3 }),
    ).toBeVisible();
    await page.keyboard.press('j');
    await expect(
      conversation(page).getByRole('heading', { name: 'Export is slow', level: 3 }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\?ticket=OPS-2$/);
    await expect(queue(page).getByRole('button', { name: /OPS-2/ })).toBeFocused();
    await page.keyboard.press('k');
    await expect(queue(page).getByRole('button', { name: /OPS-1/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  test('shortcuts work with a Thai keyboard layout (physical key)', async ({ page }) => {
    await openWorkspace(page);
    await page.evaluate(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: '่', code: 'KeyJ', bubbles: true }),
      );
    });
    await expect(queue(page).getByRole('button', { name: /OPS-1/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  test('typing in the search box does not trigger shortcuts', async ({ page }) => {
    await openWorkspace(page);
    await page.keyboard.press('/');
    await expect(page.getByRole('searchbox', { name: 'Search tickets' })).toBeFocused();
    await page.keyboard.type('jjk?');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('[aria-current="true"]')).toHaveCount(0);
  });

  test('? shows the keyboard map and Escape gives the focus back', async ({ page }) => {
    await openWorkspace(page);
    await page.keyboard.press('Shift+?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Next ticket');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('a public reply and an internal note look different and go to different endpoints', async ({
    page,
  }) => {
    const backend = await openWorkspace(page, {}, '/?ticket=OPS-1');
    const box = conversation(page).getByRole('textbox', { name: 'Public reply' });
    await box.fill('We are on it.');
    await box.press('Control+Enter');
    await expect(conversation(page).getByText('Reply sent.')).toBeVisible();
    const reply = backend.to('POST', '/v1/tickets/OPS-1/replies')[0];
    expect(reply?.body).toEqual({ body: 'We are on it.' });
    expect(reply?.csrf).toBe('csrf-token-for-tests');

    await conversation(page).getByRole('button', { name: 'Internal note' }).click();
    await expect(conversation(page).getByText('Only your team sees this note.')).toBeVisible();
    await conversation(page)
      .getByRole('textbox', { name: 'Internal note' })
      .fill('Check the config');
    await conversation(page).getByRole('button', { name: 'Add note' }).click();
    await expect(conversation(page).getByText('Note added.')).toBeVisible();
    expect(backend.to('POST', '/v1/tickets/OPS-1/notes')[0]?.body).toEqual({
      body: 'Check the config',
    });
  });

  test('"reply and set status" sends both in one request', async ({ page }) => {
    const backend = await openWorkspace(page, {}, '/?ticket=OPS-1');
    await conversation(page).getByRole('textbox', { name: 'Public reply' }).fill('Fixed.');
    await conversation(page)
      .getByRole('combobox', { name: 'Then set status' })
      .selectOption({ label: 'Resolved' });
    await conversation(page).getByRole('button', { name: 'Send reply and set Resolved' }).click();
    await expect(conversation(page).getByText('Reply sent.')).toBeVisible();
    expect(backend.to('POST', '/v1/tickets/OPS-1/replies')[0]?.body).toEqual({
      body: 'Fixed.',
      setStatus: 'resolved',
    });
  });

  test('editing the status in the details saves it and updates the queue row', async ({ page }) => {
    const backend = await openWorkspace(page, {}, '/?ticket=OPS-1');
    await conversation(page)
      .getByRole('combobox', { name: 'Status', exact: true })
      .selectOption({ label: 'Resolved' });
    await expect(conversation(page).getByText('Saved.')).toBeVisible();
    expect(backend.to('POST', '/v1/tickets/OPS-1/status')[0]?.body).toEqual({ status: 'resolved' });
    await expect(queue(page).getByRole('button', { name: /OPS-1/ })).toContainText('Resolved');
  });

  test('filters and saved views are sent to the api and survive a reload', async ({ page }) => {
    const backend = await openWorkspace(page);
    await queue(page).getByRole('combobox', { name: 'View' }).selectOption({ label: 'My queue' });
    await expect
      .poll(() => backend.to('GET', '/v1/tickets').at(-1)?.search ?? '')
      .toContain('assignee=me');

    await queue(page)
      .getByRole('button', { name: /Filters/ })
      .click();
    await queue(page).getByRole('textbox', { name: 'Name for this view' }).fill('Mine, urgent');
    await queue(page).getByRole('button', { name: 'Save view' }).click();
    await page.reload();
    await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
    await expect(
      queue(page)
        .getByRole('combobox', { name: 'View' })
        .getByRole('option', { name: 'Mine, urgent' }),
    ).toHaveCount(1);
  });
});

test.describe('realtime', () => {
  test('new tickets are counted in a pill and the list does not move until asked', async ({
    page,
  }) => {
    const backend = await openWorkspace(page);
    await expect(queue(page).getByRole('button', { name: /OPS-/ })).toHaveCount(3);
    const added = makeTicket(9, { subject: 'Brand new ticket' });
    backend.tickets.unshift(added);
    backend.push({
      id: 'b0000000-0000-4000-8000-000000000001',
      type: 'ticket.created',
      occurredAt: '2026-11-02T03:01:00.000Z',
      orgId: added.org.id,
      ticketId: added.id,
      ticketKey: added.key,
      data: { subject: added.subject, status: 'new', priority: 'P3', changed: [] },
    });

    const pill = queue(page).getByRole('button', { name: '1 new — press .' });
    await expect(pill).toBeVisible();
    await expect(queue(page).getByRole('button', { name: /OPS-/ })).toHaveCount(3);
    await expect(queue(page).getByText('Brand new ticket')).toHaveCount(0);

    await page.keyboard.press('.');
    await expect(queue(page).getByText('Brand new ticket')).toBeVisible();
    await expect(pill).toBeHidden();
  });

  test('reconnects after the connection drops and shows it in words', async ({ page }) => {
    const backend = await openWorkspace(page);
    await backend.closeSockets(1006);
    await expect(page.getByTestId('live-status')).toHaveAttribute(
      'data-state',
      /reconnecting|open/,
    );
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-state', 'open', {
      timeout: 15_000,
    });
    expect(backend.socketCount).toBe(1);
  });

  test('a 401 is answered with one refresh and a retry, without signing out', async ({ page }) => {
    let tickets401 = true;
    const backend = await mockBackend(page, {
      routes: {
        'GET /v1/tickets': () => {
          if (tickets401) {
            tickets401 = false;
            return {
              status: 401,
              json: { statusCode: 401, error: 'E', code: 'unauthenticated', message: 'x' },
            };
          }
          return {
            json: { items: [makeTicket(1, { subject: 'After refresh' })], nextCursor: null },
          };
        },
        'POST /v1/auth/refresh': () => ({ json: makeSession('agent') }),
      },
    });
    await page.addInitScript(() => {
      localStorage.setItem('wt-had-session', '1');
    });
    await page.goto('/');
    await expect(queue(page).getByText('After refresh')).toBeVisible();
    expect(backend.to('POST', '/v1/auth/refresh')).toHaveLength(1);
    expect(page.url()).not.toContain('/login');
  });
});

test.describe('customer', () => {
  test('sees two panes, no AI assistant and can only reply', async ({ page }) => {
    await openWorkspace(page, { role: 'client' }, '/?ticket=OPS-1');
    await expect(page.getByRole('region', { name: 'AI assistant' })).toHaveCount(0);
    await expect(conversation(page).getByRole('textbox', { name: 'Public reply' })).toBeVisible();
    await expect(conversation(page).getByRole('button', { name: 'Internal note' })).toHaveCount(0);
    await expect(conversation(page).getByRole('combobox')).toHaveCount(0);
  });
});

test.describe('layout by width (docs/06-UI-SPEC.md section 3.2)', () => {
  test('1024 px and wider: three panes side by side, no drawer button', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await openWorkspace(page);
    const [q, c, a] = await Promise.all(
      ['pane-queue', 'pane-conversation', 'pane-assistant'].map((id) =>
        page.locator(`#${id}`).boundingBox(),
      ),
    );
    if (!q || !c || !a) throw new Error('a pane is missing');
    expect(q.x + q.width).toBeLessThanOrEqual(c.x + 1);
    expect(c.x + c.width).toBeLessThanOrEqual(a.x + 1);
    await expect(page.getByRole('button', { name: 'AI assistant' })).toBeHidden();
  });

  test('768 to 1023 px: two panes and the AI assistant as a drawer', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await openWorkspace(page);
    const q = await page.locator('#pane-queue').boundingBox();
    const c = await page.locator('#pane-conversation').boundingBox();
    if (!q || !c) throw new Error('a pane is missing');
    expect(Math.abs(q.y - c.y)).toBeLessThan(2);
    expect(q.x + q.width).toBeLessThanOrEqual(c.x + 1);
    await expect(page.locator('#pane-assistant')).toBeHidden();

    const toggle = page.getByRole('button', { name: 'AI assistant' });
    await expect(toggle).toBeVisible();
    await toggle.click();
    const drawer = page.locator('#pane-assistant');
    await expect(drawer).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close the AI assistant' })).toBeFocused();
    const box = await drawer.boundingBox();
    if (!box) throw new Error('drawer has no box');
    // It sits against the right edge and the conversation underneath is still there.
    expect(Math.abs(box.x + box.width - 900)).toBeLessThan(2);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(toggle).toBeFocused();
  });

  test('under 768 px: the panes stack and nothing scrolls sideways', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await openWorkspace(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.getByRole('button', { name: 'AI assistant' })).toBeHidden();
  });
});

test.describe('installable app', () => {
  test('serves a web app manifest that opens on the queue', async ({ request }) => {
    const response = await request.get('/manifest.webmanifest');
    expect(response.status()).toBe(200);
    const manifest = (await response.json()) as {
      display: string;
      start_url: string;
      icons: unknown[];
    };
    expect(manifest).toMatchObject({ display: 'standalone', start_url: '/' });
    expect(manifest.icons.length).toBeGreaterThan(0);
  });

  test('serves the service worker uncached and registers it', async ({ page, request }) => {
    const response = await request.get('/sw.js');
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toContain('no-cache');
    expect(response.headers()['content-type']).toContain('javascript');

    await openWorkspace(page);
    const scope = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return registration.scope;
    });
    expect(scope).toBe(`${APP_ORIGIN}/`);
  });

  test('keeps nothing from the API in its caches', async ({ page }) => {
    await openWorkspace(page);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        urls.push(...(await cache.keys()).map((request) => request.url));
      }
      return urls;
    });
    // Only same-origin build output and the offline page: no API response, no page HTML.
    expect(cached.length).toBeGreaterThan(0);
    for (const url of cached) expect(new URL(url).origin).toBe(APP_ORIGIN);
    expect(cached.some((url) => url.endsWith('/offline.html'))).toBe(true);
  });
});

test.describe('accessibility (axe, WCAG 2.x A/AA)', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`login page has no violations in ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockBackend(page, {
        session: null,
        authConfig: { ...LIVE_CONFIG, devLoginEnabled: true },
      });
      await page.goto('/login');
      await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
      await page.getByText('Emergency administrator sign-in').click();
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(results.violations).toEqual([]);
    });

    test(`workspace with an open ticket has no violations in ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openWorkspace(
        page,
        {
          tickets: [
            makeTicket(1, {
              subject: 'Cannot log in',
              priority: 'P1',
              firstResponseDueAt: '2026-01-01T00:00:00.000Z',
              tags: ['vip'],
            }),
            makeTicket(2, { subject: 'Export is slow' }),
          ],
        },
        '/?ticket=OPS-1',
      );
      await expect(conversation(page).getByRole('textbox', { name: 'Public reply' })).toBeVisible();
      await queue(page)
        .getByRole('button', { name: /Filters/ })
        .click();
      await conversation(page).getByRole('button', { name: 'Internal note' }).click();
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(results.violations).toEqual([]);
    });

    test(`keyboard map has no violations in ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openWorkspace(page);
      await page.keyboard.press('Shift+?');
      await expect(page.getByRole('dialog')).toBeVisible();
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test('the AI drawer has no violations', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await openWorkspace(page);
    await page.getByRole('button', { name: 'AI assistant' }).click();
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });
});
