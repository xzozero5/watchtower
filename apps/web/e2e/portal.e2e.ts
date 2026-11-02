import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { makeView } from '../src/test/portal-fixtures';

import { APP_ORIGIN } from './backend';
import { E2E_API_URL } from './constants';
import { errorBody, mockPortal, SAMPLE_VALUE, type PortalOptions } from './portal-backend';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function openForm(page: Page, options: PortalOptions = {}) {
  const portal = await mockPortal(page, options);
  await page.goto('/portal');
  await expect(
    page.getByRole('heading', { name: /Contact support|ติดต่อทีมซัพพอร์ต/, level: 1 }),
  ).toBeVisible();
  return portal;
}

async function openTracking(
  page: Page,
  options: PortalOptions = {},
  hash = `#token=${SAMPLE_VALUE}`,
) {
  const portal = await mockPortal(page, options);
  await page.goto(`/portal/tickets/OPS-12${hash}`);
  return portal;
}

async function fillForm(page: Page) {
  await page.getByLabel('Your name').fill('Dana Demo');
  await page.getByLabel('Email address').fill('ada@example.com');
  await page.getByLabel('What is it about?').selectOption('api_error');
  await page.getByRole('radio', { name: /Something is broken/ }).check();
  await page.getByLabel('What happened?').fill('The export fails with a 500.');
}

// A colour-scheme switch starts colour transitions: axe measures contrast on still pixels only.
async function axe(page: Page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== 'running'),
  );
  return new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
}

test.describe('submit a request', () => {
  test('solves the check in a Web Worker, submits a valid proof and shows the confirmation', async ({
    page,
  }) => {
    const workers: string[] = [];
    page.on('worker', (worker) => workers.push(worker.url()));
    const sessionCalls: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/v1/auth/')) sessionCalls.push(request.url());
    });

    const portal = await openForm(page);
    await expect(page.getByText('Verified. You can submit your request.')).toBeVisible();
    expect(workers.length).toBeGreaterThan(0);

    await fillForm(page);
    await page.getByRole('button', { name: 'Submit request' }).click();

    await page.waitForURL('**/portal/submitted');
    await expect(
      page.getByRole('heading', { name: 'We received your request OPS-12', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText('We sent a tracking link to a***@example.com.')).toBeVisible();
    await expect(page.getByText(/We aim to reply by .*3:00\s?PM/)).toBeVisible();

    const [post] = portal.to('POST', '/v1/portal/tickets');
    expect(post?.body).toMatchObject({
      email: 'ada@example.com',
      category: 'api_error',
      urgency: 'something_broken',
      website: '',
      locale: 'en',
      verification: { provider: 'pow-sha256' },
    });
    // The mock verified the proof with SHA-256: reaching the confirmation means it was valid.
    // A public page never talks to the staff auth endpoints.
    expect(sessionCalls).toEqual([]);
  });

  test('keeps the form usable while the check runs and waits out the minimum fill time', async ({
    page,
  }) => {
    const portal = await openForm(page, { minFillSeconds: 2 });
    await fillForm(page);
    await page.getByRole('button', { name: 'Submit request' }).click();
    await page.waitForURL('**/portal/submitted');
    const [challenge] = portal.to('GET', '/v1/portal/challenge');
    const [post] = portal.to('POST', '/v1/portal/tickets');
    expect((post?.at ?? 0) - (challenge?.at ?? 0)).toBeGreaterThanOrEqual(2000);
  });

  test('shows errors inline and in a summary and sends nothing', async ({ page }) => {
    const portal = await openForm(page);
    await page.getByRole('button', { name: 'Submit request' }).click();
    const summary = page.getByRole('main').getByRole('alert');
    await expect(summary).toContainText('Please check the form');
    await expect(summary.getByRole('link', { name: 'Your name' })).toBeVisible();
    await expect(page.getByText('Enter your email address.', { exact: true })).toBeVisible();
    expect(portal.to('POST', '/v1/portal/tickets')).toHaveLength(0);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      expect((await axe(page)).violations, scheme).toEqual([]);
    }
  });

  test('the honeypot is never reached by keyboard or seen, and stays empty', async ({ page }) => {
    const portal = await openForm(page);
    await expect(page.getByTestId('portal-honeypot')).toHaveAttribute('aria-hidden', 'true');
    const box = await page.getByTestId('portal-honeypot').boundingBox();
    expect((box?.width ?? 0) <= 1 && (box?.height ?? 0) <= 1).toBe(true);
    const seen = new Set<string>();
    for (let step = 0; step < 25; step += 1) {
      await page.keyboard.press('Tab');
      seen.add(await page.evaluate(() => document.activeElement?.getAttribute('name') ?? ''));
    }
    expect(seen.has('website')).toBe(false);
    expect(seen.has('name')).toBe(true);
    await fillForm(page);
    await page.getByRole('button', { name: 'Submit request' }).click();
    await page.waitForURL('**/portal/submitted');
    expect((portal.to('POST', '/v1/portal/tickets')[0]?.body as { website: string }).website).toBe(
      '',
    );
  });

  test('a bot that fills the honeypot is refused and the page asks for a new challenge', async ({
    page,
  }) => {
    const portal = await openForm(page);
    await expect(page.getByText('Verified. You can submit your request.')).toBeVisible();
    await fillForm(page);
    await page.getByTestId('portal-honeypot').locator('input').fill('https://spam.example', {
      force: true,
    });
    await page.getByRole('button', { name: 'Submit request' }).click();
    await expect(page.getByText(/We couldn't verify your request/)).toBeVisible();
    await expect.poll(() => portal.to('GET', '/v1/portal/challenge').length).toBe(2);
    expect(page.url()).toMatch(/\/portal$/);
  });

  test('429 shows a friendly wait from Retry-After and blocks Submit', async ({ page }) => {
    await openForm(page, {
      submit: () => ({
        status: 429,
        json: errorBody(429, 'rate_limited'),
        headers: { 'retry-after': '1800' },
      }),
    });
    await fillForm(page);
    await page.getByRole('button', { name: 'Submit request' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'You have sent several requests recently. Please wait about 30 minutes and try again.',
    );
    await expect(page.getByRole('button', { name: 'Submit request' })).toBeDisabled();
    // The text the person typed is still there.
    await expect(page.getByLabel('What happened?')).toHaveValue('The export fails with a 500.');
  });

  test('says verification could not load when the challenge request fails', async ({ page }) => {
    await page.route(`${E2E_API_URL}/v1/portal/challenge`, (route) =>
      route.abort('connectionrefused'),
    );
    await page.goto('/portal');
    await expect(
      page.getByText("Verification couldn't load. Check your connection or try another browser."),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible();
  });

  test('sends no cookies to the api even when the browser holds some for the host', async ({
    page,
    context,
  }) => {
    await context.addCookies([{ name: 'wt_at', value: 'x', url: APP_ORIGIN }]);
    const portal = await openForm(page);
    await expect(page.getByText('Verified. You can submit your request.')).toBeVisible();
    await fillForm(page);
    await page.getByRole('button', { name: 'Submit request' }).click();
    await page.waitForURL('**/portal/submitted');
    for (const request of portal.requests) {
      expect(request.headers.cookie, request.path).toBeUndefined();
      expect(request.headers['x-csrf-token'], request.path).toBeUndefined();
    }
  });

  test('has no layout overflow on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await openForm(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`form and confirmation have no axe violations in ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openForm(page);
      await expect(page.getByText('Verified. You can submit your request.')).toBeVisible();
      expect((await axe(page)).violations).toEqual([]);
      await fillForm(page);
      await page.getByRole('button', { name: 'Submit request' }).click();
      await page.waitForURL('**/portal/submitted');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect((await axe(page)).violations).toEqual([]);
    });
  }
});

test.describe('Thai', () => {
  test('follows the browser language and the switch changes it', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'th-TH' });
    const page = await context.newPage();
    await mockPortal(page);
    await page.goto('/portal');
    await expect(page.locator('html')).toHaveAttribute('lang', 'th');
    await expect(page.getByRole('heading', { name: 'ติดต่อทีมซัพพอร์ต', level: 1 })).toBeVisible();
    await expect(page.getByText('ตรวจสอบแล้ว ส่งคำขอได้เลย')).toBeVisible();
    await page.getByLabel('ชื่อของคุณ').fill('อดา');
    await page.getByLabel('อีเมล').fill('ada@example.com');
    await page.getByLabel('เรื่องอะไร').selectOption('billing');
    await page.getByLabel('เกิดอะไรขึ้น').fill('ยอดเรียกเก็บไม่ตรง');
    await page.getByRole('button', { name: 'ส่งคำขอ' }).click();
    await page.waitForURL('**/portal/submitted');
    await expect(page.getByRole('heading', { name: 'เราได้รับคำขอ OPS-12 แล้ว' })).toBeVisible();

    // The language is two flags; the one for English is named in English.
    await page.getByRole('radio', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(
      page.getByRole('heading', { name: 'We received your request OPS-12' }),
    ).toBeVisible();
    await context.close();
  });

  test('sends the page language with the request and has no axe violations', async ({
    browser,
  }) => {
    const context = await browser.newContext({ locale: 'th-TH' });
    const page = await context.newPage();
    const portal = await mockPortal(page);
    await page.goto('/portal');
    await expect(page.getByText('ตรวจสอบแล้ว ส่งคำขอได้เลย')).toBeVisible();
    expect((await axe(page)).violations).toEqual([]);
    await page.getByLabel('ชื่อของคุณ').fill('อดา');
    await page.getByLabel('อีเมล').fill('ada@example.com');
    await page.getByLabel('เรื่องอะไร').selectOption('billing');
    await page.getByLabel('เกิดอะไรขึ้น').fill('ยอดเรียกเก็บไม่ตรง');
    await page.getByRole('button', { name: 'ส่งคำขอ' }).click();
    await page.waitForURL('**/portal/submitted');
    expect(portal.to('POST', '/v1/portal/tickets')[0]?.body).toMatchObject({ locale: 'th' });
    await context.close();
  });
});

test.describe('tracking page', () => {
  test('reads the link, removes it from the address bar, sends it as a header and shows the timeline', async ({
    page,
  }) => {
    const portal = await openTracking(page);
    await expect(page.getByRole('heading', { name: 'OPS-12', level: 1 })).toBeVisible();

    expect(page.url()).toBe(`${APP_ORIGIN}/portal/tickets/OPS-12`);
    expect(await page.evaluate(() => window.location.hash)).toBe('');
    const [read] = portal.to('GET', '/v1/portal/tickets/OPS-12');
    expect(read?.headers['x-portal-token']).toBe(SAMPLE_VALUE);
    for (const request of portal.requests) {
      expect(request.path + request.method).not.toContain(SAMPLE_VALUE);
    }

    await expect(page.getByText('Cannot log in', { exact: true })).toBeVisible();
    await expect(page.getByText('In progress').first()).toBeVisible();
    const items = page.getByRole('listitem').filter({ hasText: /./ });
    await expect(items.filter({ hasText: 'We are looking into it.' })).toContainText('Somchai');
    await expect(items.filter({ hasText: 'Error 500.' })).toContainText('You');
    // Nothing internal: only the three public entries.
    await expect(page.getByRole('list').getByRole('listitem')).toHaveCount(3);
  });

  test('reply goes out with the header, shows in the timeline and survives a reload', async ({
    page,
  }) => {
    const portal = await openTracking(page);
    await expect(page.getByRole('heading', { name: 'OPS-12', level: 1 })).toBeVisible();
    await page.getByLabel('Your message').fill('Still failing, now on Safari.');
    await page.getByRole('button', { name: 'Send reply' }).click();
    await expect(page.getByText('Your reply was sent.')).toBeVisible();
    await expect(page.getByText('Still failing, now on Safari.')).toBeVisible();
    const [post] = portal.to('POST', '/v1/portal/tickets/OPS-12/replies');
    expect(post?.body).toEqual({ body: 'Still failing, now on Safari.' });
    expect(post?.headers['x-portal-token']).toBe(SAMPLE_VALUE);

    // The fragment is gone, but this tab still holds the value: a reload keeps working.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'OPS-12', level: 1 })).toBeVisible();
    await expect(page.getByText('Still failing, now on Safari.')).toBeVisible();
  });

  test('a link opened in a new tab without the fragment shows the expired screen', async ({
    page,
  }) => {
    await openTracking(page, {}, '');
    await expect(
      page.getByRole('heading', { name: 'This link has expired', level: 1 }),
    ).toBeVisible();
  });

  test('a closed ticket takes no reply', async ({ page }) => {
    await openTracking(page, {
      view: makeView({ status: 'closed', statusLabel: 'Closed', canReply: false }),
    });
    await expect(page.getByRole('heading', { name: 'OPS-12', level: 1 })).toBeVisible();
    await expect(
      page.getByText('This request is closed, so it cannot take new replies.'),
    ).toBeVisible();
    await expect(page.getByLabel('Your message')).toHaveCount(0);
  });

  test('409 ticket_not_open after the ticket was closed meanwhile is explained', async ({
    page,
  }) => {
    await openTracking(page, {
      reply: () => ({ status: 409, json: errorBody(409, 'ticket_not_open') }),
    });
    await expect(page.getByRole('heading', { name: 'OPS-12', level: 1 })).toBeVisible();
    await page.getByLabel('Your message').fill('Hello?');
    await page.getByRole('button', { name: 'Send reply' }).click();
    await expect(
      page.getByText(
        'This request was closed or merged while you were writing. Your message was not sent.',
      ),
    ).toBeVisible();
  });

  test('a merged ticket says "Merged into OPS-30" and links to it', async ({ page }) => {
    await openTracking(page, {
      view: makeView({
        status: 'merged',
        statusLabel: 'Merged',
        mergedIntoKey: 'OPS-30',
        canReply: false,
      }),
    });
    await expect(page.getByRole('heading', { name: 'OPS-12', level: 1 })).toBeVisible();
    await expect(page.getByText('Merged into OPS-30').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open OPS-30' })).toHaveAttribute(
      'href',
      '/portal/tickets/OPS-30',
    );
    await expect(page.getByLabel('Your message')).toHaveCount(0);
  });

  test('Thai tracking page', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'th-TH' });
    const page = await context.newPage();
    await openTracking(page);
    await expect(page.getByRole('heading', { name: 'OPS-12', level: 1 })).toBeVisible();
    await expect(page.getByText('กำลังดำเนินการ').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'ส่งข้อความ' })).toBeVisible();
    await context.close();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no axe violations in ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openTracking(page, {
        view: makeView({
          status: 'merged',
          statusLabel: 'Merged',
          mergedIntoKey: 'OPS-30',
          canReply: true,
        }),
      });
      await expect(page.getByRole('heading', { name: 'OPS-12', level: 1 })).toBeVisible();
      expect((await axe(page)).violations).toEqual([]);
    });
  }
});

test.describe('expired link', () => {
  test('a refused link shows the expired screen and the resend form says nothing about the address', async ({
    page,
  }) => {
    const portal = await openTracking(page, {}, '#token=b2xkLWxpbmstdmFsdWU');
    await expect(
      page.getByRole('heading', { name: 'This link has expired', level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText("This link has expired. Enter your email and we'll send a new one."),
    ).toBeVisible();
    await expect(page.getByLabel('Request number')).toHaveValue('OPS-12');

    await page.getByLabel('Email address you used').fill('someone@example.com');
    await page.getByRole('button', { name: 'Send a new link' }).click();
    await expect(
      page.getByText("If this matches our records, we've sent a new link."),
    ).toBeVisible();
    const [post] = portal.to('POST', '/v1/portal/track/resend');
    expect(post?.body).toEqual({ ticketKey: 'OPS-12', email: 'someone@example.com' });
  });

  test('resend shows a wait on 429 and checks the email first', async ({ page }) => {
    await openTracking(
      page,
      {
        resend: () => ({
          status: 429,
          json: errorBody(429, 'rate_limited'),
          headers: { 'retry-after': '120' },
        }),
      },
      '#token=b2xkLWxpbmstdmFsdWU',
    );
    await page.getByRole('button', { name: 'Send a new link' }).click();
    await expect(page.getByText('Enter your email address.')).toBeVisible();
    await page.getByLabel('Email address you used').fill('someone@example.com');
    await page.getByRole('button', { name: 'Send a new link' }).click();
    await expect(
      page.getByText('Too many requests. Please wait about 2 minutes and try again.'),
    ).toBeVisible();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no axe violations in ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openTracking(page, {}, '#token=b2xkLWxpbmstdmFsdWU');
      await expect(
        page.getByRole('heading', { name: 'This link has expired', level: 1 }),
      ).toBeVisible();
      expect((await axe(page)).violations).toEqual([]);
    });
  }
});

test.describe('caching and referrers', () => {
  test('portal pages are never cached and send no referrer', async ({ request }) => {
    for (const path of ['/portal', '/portal/submitted', '/portal/tickets/OPS-12']) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      expect(response.headers()['cache-control'], path).toBe('no-store');
      expect(response.headers()['referrer-policy'], path).toBe('no-referrer');
    }
    // The rest of the app keeps its usual policy.
    const home = await request.get('/health');
    expect(home.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  test('the service worker stores nothing of the portal', async ({ page }) => {
    await openTracking(page);
    await expect(page.getByRole('heading', { name: 'OPS-12', level: 1 })).toBeVisible();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'OPS-12', level: 1 })).toBeVisible();
    const stored = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const entry of await cache.keys()) urls.push(entry.url);
      }
      return urls;
    });
    expect(stored.filter((url) => /\/portal|\/v1\//.test(url))).toEqual([]);
  });
});
