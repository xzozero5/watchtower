import { randomBytes } from 'node:crypto';

import { CSRF_HEADER } from '@watchtower/shared';
import {
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
  test as base,
} from '@playwright/test';

/**
 * Helpers of the full-stack e2e: where the stack is, Mailpit, a REST client with the session's
 * CSRF token, and the sign-in flows. Nothing here mocks anything.
 */
export interface Stack {
  readonly webUrl: string;
  readonly apiUrl: string;
  readonly mailpitUrl: string;
  readonly breakGlassEmail: string;
  readonly breakGlassPassword: string;
}

export function stack(): Stack {
  const need = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set: the stack was not started (global-setup.ts)`);
    return value;
  };
  return {
    webUrl: need('E2E_WEB_URL'),
    apiUrl: need('E2E_API_URL'),
    mailpitUrl: need('E2E_MAILPIT_URL'),
    breakGlassEmail: need('E2E_BREAK_GLASS_EMAIL'),
    breakGlassPassword: need('E2E_BREAK_GLASS_PASSWORD'),
  };
}

/** Every page opens relative to the web app of this run. */
export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures take a destructured first argument
  baseURL: async ({}, provide) => {
    await provide(stack().webUrl);
  },
});
export { expect };

/** A fresh, unguessable local part: addresses are how parallel and repeated runs stay apart. */
export const unique = (prefix: string): string => `${prefix}-${randomBytes(4).toString('hex')}`;

/** Demo organizations the seed creates (packages/db/src/seed/demo-data.ts). */
export const ORGS = {
  acme: { name: 'Acme Logistics', domain: 'acme-logistics.example.com' },
  borealis: { name: 'Borealis Foods', domain: 'borealis-foods.example.org' },
} as const;

// ---------------------------------------------------------------- Mailpit

interface MailpitSummary {
  ID: string;
  Subject: string;
  Created: string;
  To: { Address: string }[];
}

export interface Email {
  id: string;
  subject: string;
  text: string;
  /** The first http(s) link in the text body. */
  link: string;
  receivedAt: number;
}

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/;

/**
 * The messages Mailpit holds for one address. `next` waits for a message with a matching subject
 * that an earlier call did not return, so two emails with the same subject are told apart in order.
 */
export class Mailbox {
  private readonly seen = new Set<string>();

  constructor(readonly address: string) {}

  private async search(): Promise<MailpitSummary[]> {
    const url = new URL('/api/v1/search', stack().mailpitUrl);
    url.searchParams.set('query', `to:"${this.address}"`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Mailpit search answered ${String(response.status)}`);
    const body = (await response.json()) as { messages: MailpitSummary[] | null };
    return (body.messages ?? []).slice().sort((a, b) => a.Created.localeCompare(b.Created));
  }

  async next(subject: RegExp, timeoutMs = 30_000): Promise<Email> {
    const deadline = Date.now() + timeoutMs;
    let subjects: string[] = [];
    while (Date.now() < deadline) {
      const messages = await this.search();
      subjects = messages.map((message) => message.Subject);
      const match = messages.find((m) => !this.seen.has(m.ID) && subject.test(m.Subject));
      if (match) {
        this.seen.add(match.ID);
        const detail = await fetch(new URL(`/api/v1/message/${match.ID}`, stack().mailpitUrl));
        const body = (await detail.json()) as { Text: string; Subject: string };
        const link = URL_PATTERN.exec(body.Text)?.[0];
        if (!link) throw new Error(`The email "${match.Subject}" has no link`);
        return {
          id: match.ID,
          subject: body.Subject,
          text: body.Text,
          link,
          receivedAt: Date.now(),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(
      `No email to ${this.address} with a subject matching ${String(subject)} in ${String(timeoutMs)} ms. ` +
        `Subjects seen: ${JSON.stringify(subjects)}`,
    );
  }

  /** Subjects of everything this address received (to assert that something was NOT sent). */
  async subjects(): Promise<string[]> {
    return (await this.search()).map((message) => message.Subject);
  }

  /** Removes this address's messages from Mailpit, so a run leaves the shared inbox as it found it. */
  async delete(): Promise<void> {
    const url = new URL('/api/v1/search', stack().mailpitUrl);
    url.searchParams.set('query', `to:"${this.address}"`);
    await fetch(url, { method: 'DELETE' }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- REST

export interface ApiResult<T = unknown> {
  status: number;
  json: T;
}

/**
 * The API as a browser tab uses it: the context's cookies, the Origin of the web app and, on unsafe
 * methods, the CSRF token of the session. Asking through the browser context means the REST calls
 * and the UI share one session.
 */
export class Api {
  private csrf: string | null = null;

  constructor(private readonly request: APIRequestContext) {}

  private url(path: string): string {
    return new URL(path, stack().apiUrl).toString();
  }

  private async csrfToken(): Promise<string> {
    if (this.csrf) return this.csrf;
    const session = await this.get<{ csrfToken: string }>('/v1/auth/session');
    this.csrf = session.json.csrfToken;
    return this.csrf;
  }

  async get<T = unknown>(path: string): Promise<ApiResult<T>> {
    const response = await this.request.get(this.url(path), {
      headers: { origin: stack().webUrl },
    });
    return { status: response.status(), json: (await response.json().catch(() => null)) as T };
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>> {
    const response = await this.request.post(this.url(path), {
      headers: { origin: stack().webUrl, [CSRF_HEADER]: await this.csrfToken() },
      ...(body === undefined ? {} : { data: body }),
    });
    return { status: response.status(), json: (await response.json().catch(() => null)) as T };
  }

  /** Every page of a list endpoint that answers `{ items, nextCursor }`. */
  async all<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | null = null;
    do {
      const separator = path.includes('?') ? '&' : '?';
      const page: ApiResult<{ items: T[]; nextCursor: string | null }> = await this.get(
        `${path}${separator}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(page.status, `GET ${path}`).toBe(200);
      items.push(...page.json.items);
      cursor = page.json.nextCursor;
    } while (cursor);
    return items;
  }
}

export interface StaffTicket {
  id: string;
  key: string;
  subject: string;
  status: string;
  priority: string;
  org: { id: string; name: string };
  intent: { id: string; key: string; name: string } | null;
  slaPolicyId: string | null;
  firstResponseDueAt: string | null;
  resolutionDueAt: string | null;
  channel: string;
  assignee: { id: string; name: string } | null;
  createdAt: string;
}

export interface TimelineEntryJson {
  kind: 'message' | 'event';
  visibility: 'public' | 'internal';
  bodyText?: string;
  /** Events only. */
  type?: string;
  actor?: { type: string; id: string | null; name: string | null };
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------- sign-in

/** Signs the break-glass administrator (role head) in through the login page. */
export async function signInStaff(page: Page): Promise<void> {
  const { breakGlassEmail, breakGlassPassword } = stack();
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
  await page.getByText('Emergency administrator sign-in').click();
  const form = page.locator('details', { hasText: 'Emergency administrator sign-in' });
  await form.getByLabel('Email address').fill(breakGlassEmail);
  await form.getByLabel('Password').fill(breakGlassPassword);
  await form.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/');
  await expect(page.getByRole('region', { name: 'Queue' })).toBeVisible();
}

/**
 * Magic-link sign-in of a client, end to end: request the link on the login page, read the email
 * from Mailpit, open the link. Returns the link so a test can try to use it a second time.
 */
export async function signInClient(page: Page, mailbox: Mailbox): Promise<string> {
  await page.goto('/login');
  const customers = page.getByRole('region', { name: 'Customers' });
  await customers.getByLabel('Email address').fill(mailbox.address);
  await customers.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(customers.getByText('Check your email')).toBeVisible();

  const email = await mailbox.next(/sign-in link/i);
  expect(new URL(email.link).origin, 'the link points at the web app').toBe(stack().webUrl);
  await page.goto(email.link);
  await page.waitForURL((url) => url.pathname === '/');
  await expect(page.getByRole('region', { name: 'Queue' })).toBeVisible();
  return email.link;
}

/** A new browser context (own cookies) and page. */
export async function newActor(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: stack().webUrl, locale: 'en-US' });
  return { context, page: await context.newPage() };
}
