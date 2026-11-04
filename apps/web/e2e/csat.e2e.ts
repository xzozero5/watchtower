import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { APP_ORIGIN } from './backend';
import { E2E_API_URL } from './constants';
import { errorBody } from './portal-backend';

// The public survey page `/csat` (T-110b, R-10.2; the email of T-174 links to it). The api is stood in
// for by page.route: these tests check what the page reads from the link, what it sends, and what it
// says, not the api itself (that is csat.integration.test.ts in apps/api).

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const TOKEN = 'wtc1.e2e-survey-token.0123456789abcdef';

const CORS = {
  'access-control-allow-origin': APP_ORIGIN,
  'access-control-allow-headers': 'content-type, x-csat-token',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-expose-headers': 'retry-after',
};

interface SurveyApi {
  /** Answers `GET /v1/csat/survey`. */
  readonly view?: { status: number; json: unknown };
  /** Answers `POST /v1/csat/responses`. */
  readonly answer?: { status: number; json: unknown };
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly token: string | undefined;
  readonly body: unknown;
}

const OPEN = {
  status: 200,
  json: { ticketKey: 'OPS-12', locale: 'en', expiresAt: '2026-12-01T00:00:00.000Z' },
};

async function mockSurveyApi(page: Page, api: SurveyApi = {}) {
  const calls: Call[] = [];
  await page.route(`${E2E_API_URL}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    calls.push({
      method: request.method(),
      path: url.pathname,
      token: request.headers()['x-csat-token'],
      body: request.postData() ? (request.postDataJSON() as unknown) : undefined,
    });
    const reply = (status: number, json: unknown) =>
      route.fulfill({
        status,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify(json),
      });
    if (request.method() === 'GET' && url.pathname === '/v1/csat/survey') {
      const view = api.view ?? OPEN;
      return reply(view.status, view.json);
    }
    if (request.method() === 'POST' && url.pathname === '/v1/csat/responses') {
      const answer = api.answer ?? { status: 200, json: { recorded: true } };
      return reply(answer.status, answer.json);
    }
    return reply(404, errorBody(404, 'not_found'));
  });
  return { calls, posts: () => calls.filter((call) => call.method === 'POST') };
}

// A colour-scheme switch starts colour transitions: axe measures contrast on still pixels only.
async function axe(page: Page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== 'running'),
  );
  return new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
}

test.describe('the survey page from the email link', () => {
  test.use({ locale: 'en-US' });

  test('opens with the rating from the email chosen, takes the token out of the address bar and records nothing yet', async ({
    page,
  }) => {
    const api = await mockSurveyApi(page);
    await page.goto(`/csat#token=${TOKEN}&score=4`);
    await expect(page.getByRole('heading', { name: 'How did we do?', level: 1 })).toBeVisible();
    await expect(page.getByText('Your request OPS-12 was resolved.')).toBeVisible();
    await expect(page.getByRole('radio', { name: '4 out of 5: Happy' })).toBeChecked();

    // The bearer token is in the fragment only; the page removes it from the address bar and history.
    await expect.poll(() => new URL(page.url()).hash).toBe('');
    // It went to the api in the header, never in a URL.
    const read = api.calls.find((call) => call.method === 'GET');
    expect(read?.token).toBe(TOKEN);
    expect(read?.path).toBe('/v1/csat/survey');
    expect(api.calls.every((call) => !call.path.includes(TOKEN))).toBe(true);
    // A mail scanner that opens the link answers nothing: no POST until the button is pressed.
    expect(api.posts()).toHaveLength(0);
  });

  test('sends the score, "not resolved" and the comment once, then says thank you', async ({
    page,
  }) => {
    const api = await mockSurveyApi(page);
    await page.goto(`/csat#token=${TOKEN}&score=2`);
    await expect(page.getByRole('radio', { name: '2 out of 5: Unhappy' })).toBeChecked();
    // The customer can change the rating chosen in the email.
    await page.getByRole('radio', { name: '1 out of 5: Very unhappy' }).check();
    await page.getByRole('radio', { name: 'No, I still need help' }).check();
    await page.getByLabel('Anything you would like to add?').fill('Still failing after the fix.');
    await page.getByRole('button', { name: 'Send my answer' }).click();

    await expect(page.getByRole('heading', { name: 'Thank you', level: 1 })).toBeVisible();
    expect(api.posts()).toHaveLength(1);
    expect(api.posts()[0]).toMatchObject({
      path: '/v1/csat/responses',
      token: TOKEN,
      body: { score: 1, resolved: false, comment: 'Still failing after the fix.' },
    });
    // The page never says whether the answer reopened the request.
    await expect(page.getByText(/reopen/i)).toHaveCount(0);
  });

  test('a link without a rating asks for one and sends nothing until it has one', async ({
    page,
  }) => {
    const api = await mockSurveyApi(page);
    await page.goto(`/csat#token=${TOKEN}`);
    await expect(page.getByRole('heading', { name: 'How did we do?' })).toBeVisible();
    await page.getByRole('button', { name: 'Send my answer' }).click();
    await expect(page.getByText('Please choose a rating from 1 to 5.')).toBeVisible();
    expect(api.posts()).toHaveLength(0);

    await page.getByRole('radio', { name: '5 out of 5: Very happy' }).check();
    await page.getByRole('button', { name: 'Send my answer' }).click();
    await expect(page.getByRole('heading', { name: 'Thank you' })).toBeVisible();
    // Resolved and comment are optional: left out of the request, not sent empty.
    expect(api.posts()[0]?.body).toEqual({ score: 5 });
  });

  test('a link that expired, or never worked, says so without saying which', async ({ page }) => {
    await mockSurveyApi(page, {
      view: { status: 401, json: errorBody(401, 'invalid_or_expired_link') },
    });
    await page.goto(`/csat#token=${TOKEN}&score=3`);
    await expect(page.getByRole('heading', { name: 'This link does not work' })).toBeVisible();
    await expect(page.locator('form')).toHaveCount(0);
  });

  test('opened with no link at all shows the same page', async ({ page }) => {
    const api = await mockSurveyApi(page);
    await page.goto('/csat');
    await expect(page.getByRole('heading', { name: 'This link does not work' })).toBeVisible();
    expect(api.calls).toHaveLength(0);
  });

  test('a survey that was already answered says so, once the link is used', async ({ page }) => {
    await mockSurveyApi(page, { view: { status: 409, json: errorBody(409, 'ticket_not_open') } });
    await page.goto(`/csat#token=${TOKEN}&score=5`);
    await expect(page.getByRole('heading', { name: 'Already answered' })).toBeVisible();
  });

  test('a second tap on the button while sending does not send twice, and a conflict after it shows "already answered"', async ({
    page,
  }) => {
    const api = await mockSurveyApi(page, {
      answer: { status: 409, json: errorBody(409, 'ticket_not_open') },
    });
    await page.goto(`/csat#token=${TOKEN}&score=5`);
    await page.getByRole('button', { name: 'Send my answer' }).dblclick();
    await expect(page.getByRole('heading', { name: 'Already answered' })).toBeVisible();
    expect(api.posts()).toHaveLength(1);
  });

  test('a rate limit shows when to try again and keeps what was typed', async ({ page }) => {
    await mockSurveyApi(page, {
      answer: { status: 429, json: errorBody(429, 'rate_limited') },
    });
    await page.goto(`/csat#token=${TOKEN}&score=4`);
    await page.getByLabel('Anything you would like to add?').fill('Thanks');
    await page.getByRole('button', { name: 'Send my answer' }).click();
    await expect(page.getByText(/Too many attempts/)).toBeVisible();
    await expect(page.getByLabel('Anything you would like to add?')).toHaveValue('Thanks');
    await expect(page.getByRole('radio', { name: '4 out of 5: Happy' })).toBeChecked();
  });

  test('has no axe violations, form and thank-you', async ({ page }) => {
    await mockSurveyApi(page);
    await page.goto(`/csat#token=${TOKEN}&score=4`);
    await expect(page.getByRole('heading', { name: 'How did we do?' })).toBeVisible();
    expect((await axe(page)).violations).toEqual([]);
    await page.getByRole('button', { name: 'Send my answer' }).click();
    await expect(page.getByRole('heading', { name: 'Thank you' })).toBeVisible();
    expect((await axe(page)).violations).toEqual([]);
  });
});

test.describe('in Thai', () => {
  test.use({ locale: 'th-TH' });

  test('follows the browser language, labels the five ratings and has no axe violations', async ({
    page,
  }) => {
    await mockSurveyApi(page, { view: { ...OPEN, json: { ...OPEN.json, locale: 'th' } } });
    await page.goto(`/csat#token=${TOKEN}&score=5`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'th');
    await expect(
      page.getByRole('heading', { name: 'เราให้บริการเป็นอย่างไรบ้าง', level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole('radio', { name: '5 จาก 5: พอใจมาก' })).toBeChecked();
    await expect(page.locator('form').getByRole('radio')).toHaveCount(7);
    expect((await axe(page)).violations).toEqual([]);
  });
});
