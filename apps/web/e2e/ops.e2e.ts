import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { ALERT_CRITICAL, ALERT_UNMAPPED, INCIDENT_ID, mockOps, PUBLIC_TOKEN } from './ops-backend';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Staff pages: the console shell marks itself when React has taken over. */
async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
}

/** The colours have a short transition: axe must not read them half way (a false low-contrast hit). */
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

test.describe('Alerts: list, unmapped, acknowledge with A', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`shows severity in words, keeps unmapped alerts visible and acknowledges by keyboard (${scheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      const backend = await mockOps(page);
      await open(page, '/alerts');

      const list = page
        .getByRole('list')
        .filter({ has: page.getByRole('button', { name: /Checkout latency high 1/ }) });
      const critical = list.getByRole('listitem').filter({ hasText: ALERT_CRITICAL.title });
      await expect(critical).toContainText('P1');
      await expect(critical).toContainText('Critical');
      await expect(critical).toContainText('Open');

      // J opens the first row; A acknowledges it.
      await page.keyboard.press('j');
      await expect(page.getByRole('heading', { name: ALERT_CRITICAL.title })).toBeVisible();
      await expect(page.getByText(/Step 1: Whoever is on shift/)).toBeVisible();
      await expectNoViolations(page);

      await page.keyboard.press('a');
      await expect(page.getByText('Alert acknowledged.')).toBeVisible();
      expect(backend.to('POST', `/v1/alerts/${ALERT_CRITICAL.id}/ack`)).toHaveLength(1);
      await expect(page.getByText(/Acknowledged via the web app/)).toBeVisible();

      // The unmapped alert is still reachable and says so in words, not only in colour.
      await page.getByRole('radio', { name: 'Unmapped' }).click();
      await page.waitForURL('**/alerts?view=unmapped');
      const unmapped = page.getByRole('listitem').filter({ hasText: ALERT_UNMAPPED.title });
      await expect(unmapped).toContainText('No service');
      await expect(unmapped).toContainText('Severity unmapped');
      await expectNoViolations(page);
    });
  }
});

test.describe('Incident: customer update is drafted, previewed, confirmed and sent by a person (N3)', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`shows the exact count and refuses a stale one (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      const backend = await mockOps(page, { recipients: 7 });
      await open(page, `/incidents?incident=${INCIDENT_ID}`);

      await expect(page.getByRole('heading', { name: 'Checkout is slow' })).toBeVisible();
      await expect(page.getByRole('button', { name: /INC-12/ })).toContainText('SEV2');
      await page.getByRole('tab', { name: 'Customer updates' }).click();

      await page.getByLabel('Write an update').fill('We are looking into slow checkouts.');
      await page.getByRole('button', { name: 'Save draft' }).click();
      await expect(page.getByText('Draft saved. Nothing was sent.')).toBeVisible();
      expect(backend.to('POST', `/v1/incidents/${INCIDENT_ID}/comms`)).toHaveLength(1);

      await page.getByRole('button', { name: 'Review and send…' }).first().click();
      const dialog = page.getByRole('dialog', { name: 'Send this update to customers' });
      await expect(dialog.getByText('It reaches 7 customers now.')).toBeVisible();
      const send = dialog.getByRole('button', { name: 'Send to 7 customers' });
      await expect(send).toBeDisabled();
      await expectNoViolations(page);

      // The audience grows while the dialog is open: the send is refused and asks again.
      backend.state.recipients = 9;
      await dialog.getByRole('checkbox').check();
      await send.click();
      await expect(dialog.getByText(/The audience changed since you looked/)).toBeVisible();
      await expect(dialog.getByText('It reaches 9 customers now.')).toBeVisible();
      await expect(dialog.getByRole('checkbox')).not.toBeChecked();
      expect(backend.state.sent).toBeNull();

      await dialog.getByRole('checkbox').check();
      await dialog.getByRole('button', { name: 'Send to 9 customers' }).click();
      await expect(dialog.getByText('Sent to 9 of 9. 0 failed.')).toBeVisible();
      expect(backend.state.sent).toEqual({ confirmed: 9 });
    });
  }
});

test.describe('Public status page', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`shows components in words, takes no session and subscribes (${scheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      const backend = await mockOps(page, { role: 'agent' });
      await page.goto('/status');

      await expect(page.getByText('All systems are working.')).toBeVisible();
      await expect(page.getByText('Operational').first()).toBeVisible();
      expect(backend.to('GET', '/v1/auth/session')).toHaveLength(0);
      await expectNoViolations(page);

      await page.getByLabel('Email address').fill('person@example.com');
      await page.getByRole('button', { name: 'Subscribe' }).click();
      await expect(page.getByText('Check your email')).toBeVisible();
      expect(backend.to('POST', '/v1/status/subscriptions')[0]?.body).toEqual({
        email: 'person@example.com',
        locale: 'en',
      });
    });
  }

  test('renders the not-found page when the status page is switched off', async ({ page }) => {
    const backend = await mockOps(page, { statusPageOpen: false });
    await page.goto('/status');
    await expect(page.getByText('Page not found')).toBeVisible();
    expect(backend.to('GET', '/v1/auth/session')).toHaveLength(0);
    await expectNoViolations(page);
  });

  test('confirms a subscription from the link only when the button is pressed', async ({
    page,
  }) => {
    const backend = await mockOps(page);
    await page.goto(`/status/confirm#token=${PUBLIC_TOKEN}`);
    const button = page.getByRole('button', { name: 'Confirm subscription' });
    await expect(button).toBeVisible();
    await expect(page).toHaveURL(/\/status\/confirm$/);
    expect(backend.to('POST', '/v1/status/subscriptions/confirm')).toHaveLength(0);
    await button.click();
    await expect(page.getByText('You are subscribed.')).toBeVisible();
    expect(backend.to('POST', '/v1/status/subscriptions/confirm')[0]?.body).toEqual({
      token: PUBLIC_TOKEN,
    });
  });
});

test.describe('Staff admin: services and the status page', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`catalog and status page pass axe, and publishing asks first (${scheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      const backend = await mockOps(page);

      await open(page, '/alerts/services');
      await expect(page.getByText('Checkout API')).toBeVisible();
      await expectNoViolations(page);
      await page.getByRole('tab', { name: 'Heartbeats' }).click();
      await expect(page.getByText('Nightly export')).toBeVisible();
      await expectNoViolations(page);

      await open(page, '/status-page');
      await page.getByRole('button', { name: 'Publish' }).click();
      const dialog = page.getByRole('dialog', { name: 'Publish this post?' });
      await expect(dialog.getByText(/emailed to 12 confirmed subscribers/)).toBeVisible();
      await expectNoViolations(page);
      // Opening the dialog publishes nothing.
      expect(backend.requests.some((r) => r.path.endsWith('/publish'))).toBe(false);
    });
  }
});
