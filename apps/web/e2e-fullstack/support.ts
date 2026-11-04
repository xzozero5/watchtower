import { spawnSync } from 'node:child_process';
import { createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/**
 * http(s) requests a browser of this run sent to anything but this machine (T-113). A mock stack
 * must not make the browser reach out either: fonts, analytics and CDNs would show up here. Every
 * test fails when the list is not empty at its end.
 */
const foreignRequests: string[] = [];

export function watchBrowserRequests(context: BrowserContext): void {
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return;
    foreignRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
  });
}

/** Every page opens relative to the web app of this run. */
export const test = base.extend<{ noForeignRequests: undefined }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures take a destructured first argument
  baseURL: async ({}, provide) => {
    await provide(stack().webUrl);
  },
  noForeignRequests: [
    async ({ context }, provide) => {
      watchBrowserRequests(context);
      await provide(undefined);
      const seen = foreignRequests.splice(0);
      expect(seen, 'the browser reached outside this machine').toEqual([]);
    },
    { auto: true },
  ],
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
  /** Response headers, lower-cased names. */
  headers: Record<string, string>;
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
    return {
      status: response.status(),
      json: (await response.json().catch(() => null)) as T,
      headers: response.headers(),
    };
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>> {
    return this.send('post', path, body);
  }

  async put<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>> {
    return this.send('put', path, body);
  }

  async patch<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>> {
    return this.send('patch', path, body);
  }

  async delete<T = unknown>(path: string): Promise<ApiResult<T>> {
    return this.send('delete', path);
  }

  private async send<T>(
    method: 'post' | 'put' | 'patch' | 'delete',
    path: string,
    body?: unknown,
  ): Promise<ApiResult<T>> {
    const response = await this.request[method](this.url(path), {
      headers: { origin: stack().webUrl, [CSRF_HEADER]: await this.csrfToken() },
      ...(body === undefined ? {} : { data: body }),
    });
    return {
      status: response.status(),
      json: (await response.json().catch(() => null)) as T,
      headers: response.headers(),
    };
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
  /** Messages only. */
  direction?: 'inbound' | 'outbound';
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
  // A head starts on the team overview (lib/role-home.ts). Tests that follow expect the queue, so
  // the helper opens it afterwards.
  await page.waitForURL((url) => url.pathname === '/home');
  await page.goto('/');
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
  watchBrowserRequests(context);
  return { context, page: await context.newPage() };
}

export type DevRole = 'agent' | 'lead' | 'head' | 'dev';

/**
 * Signs a staff member of the given role in through the mock identity provider of the stack (the
 * "Development sign-in" form of the login page; the Google credentials are empty in this stack, so
 * it is the only way to an agent, a lead or a developer). The address is made up per call.
 */
export async function signInDev(
  page: Page,
  role: DevRole,
  name = unique(role),
): Promise<{ email: string }> {
  const email = `${name}@example.com`;
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
  const form = page.locator('section', {
    has: page.getByRole('heading', { name: /Development sign-in/ }),
  });
  await form.getByLabel('Email address').fill(email);
  await form.getByLabel('Role').selectOption(role);
  await form.getByRole('button', { name: 'Sign in for development' }).click();
  // Each role starts on its own page (lib/role-home.ts): lead and head on the overview, the rest on `/`.
  const home = role === 'lead' || role === 'head' ? '/home' : '/';
  await page.waitForURL((url) => url.pathname === home);
  return { email };
}

// ---------------------------------------------------------------- mock integrations

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: the stack was not started by global-setup.ts`);
  return value;
}

/** `X-Line-Signature`: base64 HMAC-SHA256 of the exact body with the channel secret of the stack. */
export function lineSignature(rawBody: string): string {
  return createHmac('sha256', need('E2E_LINE_CHANNEL_SECRET')).update(rawBody).digest('base64');
}

export interface LineCall {
  at: number;
  call: 'reply' | 'push';
  ok: boolean;
  texts?: string[];
  to?: string;
  code?: string;
}

function jsonLines<T>(file: string): T[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}

/** What the stack's worker sent to the (in-memory) LINE Messaging API, oldest first. */
export function lineCalls(): LineCall[] {
  return jsonLines<LineCall>(need('E2E_LINE_LOG'));
}

/** Outbound connections the guard of the stack refused (host and port only). Must stay empty. */
export function refusedConnections(): { pid: number; host: string; port: number }[] {
  return jsonLines<{ pid: number; host: string; port: number }>(need('E2E_NET_LOG'));
}

/**
 * Puts a fake inbound message into the stack the way the Gmail receiver would (an `inbound_event`
 * and an `ingest` outbox job), with the CLI of the api (`inbound:fake`) against the throwaway
 * database. Gmail's push receiver only accepts Google-signed tokens, so this is the mock path
 * (T-122c). Returns the CLI's JSON answer.
 */
export function fakeGmail(input: {
  from: string;
  subject: string;
  body: string;
  threadId?: string;
  messageId?: string;
  inReplyTo?: string;
  kind?: 'auto_reply' | 'newsletter';
}): { inboundEventId: string; providerEventId: string; duplicate: boolean } {
  const args = ['gmail', '--from', input.from, '--subject', input.subject, '--body', input.body];
  if (input.threadId) args.push('--thread', input.threadId);
  if (input.messageId) args.push('--message-id', input.messageId);
  if (input.inReplyTo) args.push('--in-reply-to', input.inReplyTo);
  if (input.kind) args.push('--kind', input.kind);
  const result = spawnSync(
    process.execPath,
    [join(need('E2E_API_DIST'), 'cli', 'inbound-fake.js'), ...args],
    {
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH ?? '',
        DATABASE_URL: need('E2E_DATABASE_URL'),
      },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) throw new Error(`inbound-fake failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim()) as {
    inboundEventId: string;
    providerEventId: string;
    duplicate: boolean;
  };
}

/**
 * Opens the staff composer in the given mode. With an AI brief on the ticket (T-128) the composer
 * sits behind a dock ("Write a reply" / "Internal note" buttons); without one it is already open
 * with Reply / Internal note radios.
 */
export async function openComposer(page: Page, mode: 'reply' | 'note'): Promise<void> {
  // The dock buttons carry their shortcut in the accessible name ("Write a reply C").
  const dock = page.getByRole('button', {
    name: mode === 'reply' ? /^Write a reply\b/ : /^Internal note\b/,
  });
  const radio = page.getByRole('radio', { name: mode === 'reply' ? 'Reply' : 'Internal note' });
  await dock.or(radio).first().waitFor();
  if (await dock.isVisible()) await dock.click();
  if (mode === 'note' && (await radio.isVisible())) await radio.click();
}

export interface GmailSend {
  at: number;
  requestedThreadId: string | null;
  gmailThreadId: string;
  messageId: string;
  headers: Record<string, unknown>;
}

/** What the stack's worker sent through the (in-memory) Gmail API: thread id and headers, never a body. */
export function gmailSends(): GmailSend[] {
  return jsonLines<GmailSend>(need('E2E_GMAIL_LOG'));
}

// ---------------------------------------------------------------- alerts and Discord (T-207)

/** `X-Watchtower-Signature` of the machine-alert webhook: `t=<unix s>,v1=HMAC-SHA256("<t>.alerts-webhook." + body)`. */
export function alertSignature(
  rawBody: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
): string {
  const mac = createHmac('sha256', need('E2E_ALERT_WEBHOOK_SECRET'))
    .update(`${String(timestampSeconds)}.alerts-webhook.`)
    .update(rawBody)
    .digest('hex');
  return `t=${String(timestampSeconds)},v1=${mac}`;
}

/** An Alertmanager v4 notification with one alert. `startsAt` differs per real fire; `fingerprint` is the dedupe key. */
export function alertmanagerBody(input: {
  alertname: string;
  fingerprint: string;
  status?: 'firing' | 'resolved';
  startsAt?: string;
  labels?: Record<string, string>;
}): string {
  const status = input.status ?? 'firing';
  return JSON.stringify({
    version: '4',
    groupKey: '{}:{}',
    status,
    receiver: 'watchtower',
    externalURL: 'https://alertmanager.example.invalid',
    alerts: [
      {
        status,
        labels: { alertname: input.alertname, severity: 'critical', ...input.labels },
        annotations: { summary: 'Error rate above 5%' },
        startsAt: input.startsAt ?? new Date().toISOString(),
        endsAt: status === 'resolved' ? new Date().toISOString() : '0001-01-01T00:00:00Z',
        generatorURL: 'https://prometheus.example.invalid/graph',
        fingerprint: input.fingerprint,
      },
    ],
  });
}

/** POSTs a signed alert body to the real public webhook of the api (no session, no browser). */
export async function postAlertWebhook(
  rawBody: string,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(new URL('/v1/inbound/alerts/webhook', stack().apiUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-watchtower-signature': alertSignature(rawBody),
    },
    body: rawBody,
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

export interface DiscordCall {
  op: 'postMessage' | 'editMessage' | 'createThread' | 'postInThread';
  target: string;
  payload: {
    content?: string;
    name?: string;
    components?: { components: { custom_id: string; label: string }[] }[];
  };
  at: number;
}

/** What the stack's worker "sent" to Discord (the in-memory bot records the JSON a live bot would send), oldest first. */
export function discordCalls(): DiscordCall[] {
  return jsonLines<DiscordCall>(need('E2E_DISCORD_LOG'));
}

/** The `custom_id`s of the buttons on a recorded message. */
export function buttonIds(call: DiscordCall): string[] {
  return (call.payload.components ?? []).flatMap((row) => row.components.map((b) => b.custom_id));
}

let discordSnowflake = 700_000_000_000_000_000n;
export const nextSnowflake = (): string => String(++discordSnowflake);

/**
 * Links a staff user to a made-up Discord account (`users.discord_user_id`). There is no api for it yet
 * (the linking flow is a later task), so this is a direct write against the throwaway database.
 */
export function linkDiscordAccount(userId: string, discordUserId: string): void {
  const script = `
    const { createRequire } = require('node:module');
    const req = createRequire(process.env.PG_FROM);
    const { Client } = req('pg');
    (async () => {
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      const r = await client.query('UPDATE users SET discord_user_id = $1 WHERE id = $2', [process.env.DISCORD_ID, process.env.USER_ID]);
      await client.end();
      if (r.rowCount !== 1) process.exit(3);
    })().catch(() => process.exit(1));`;
  const result = spawnSync(process.execPath, ['-e', script], {
    env: {
      NODE_ENV: 'test',
      PATH: process.env.PATH ?? '',
      DATABASE_URL: need('E2E_DATABASE_URL'),
      PG_FROM: join(need('E2E_API_DIST'), '..', 'package.json'),
      DISCORD_ID: discordUserId,
      USER_ID: userId,
    },
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error(`linking a Discord account failed (exit ${String(result.status)})`);
}

/** A Discord button press (interaction type 3) signed with the private key of the stack's Discord application. */
export async function pressDiscordButton(
  discordUserId: string,
  customId: string,
  options: { interactionId?: string } = {},
): Promise<{ status: number; json: { type: number; data?: { content: string } } | null }> {
  const raw = JSON.stringify({
    id: options.interactionId ?? nextSnowflake(),
    type: 3,
    member: { user: { id: discordUserId } },
    data: { custom_id: customId, component_type: 2 },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(timestamp), Buffer.from(raw)]),
    createPrivateKey(need('E2E_DISCORD_PRIVATE_KEY')),
  ).toString('hex');
  const response = await fetch(new URL('/v1/inbound/discord/interactions', stack().apiUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature-ed25519': signature,
      'x-signature-timestamp': timestamp,
    },
    body: raw,
  });
  return {
    status: response.status,
    json: (await response.json().catch(() => null)) as {
      type: number;
      data?: { content: string };
    } | null,
  };
}

/** The id of a demo organization by name (staff REST). */
export async function findOrgId(api: Api, name: string): Promise<string> {
  const orgs = await api.all<{ id: string; name: string }>('/v1/orgs');
  const found = orgs.find((org) => org.name === name);
  if (!found) throw new Error(`no organization named ${name}`);
  return found.id;
}
