import { randomBytes, randomUUID } from 'node:crypto';

import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { createDomain, type Domain } from '@watchtower/domain';
import { CSAT_LANDING_PATH } from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import { startWorker, type RunningWorker } from '../worker.js';

// T-204c end to end on real Postgres, Redis and Mailpit: a request to subscribe becomes a confirmation email
// (double opt-in), a published post becomes a notice to the confirmed subscribers only, every notice carries
// an unsubscribe link, and nothing but the published text is in it. Nothing leaves the machine.
const prefix = `wt-test-${randomBytes(4).toString('hex')}`;
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const mailpit = process.env.MAILPIT_URL ?? 'http://localhost:8025';

let testDb: TestDatabase;
let config: ReturnType<typeof testConfig>;
let worker: RunningWorker;
let appDb: Database;
let domain: Domain;
let leadId: string;
const owner = () => testDb.owner.db;
const ANONYMOUS = { type: 'anonymous', id: null } as const;
const key = () => deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.csatLink);

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  config = {
    ...testConfig({ DATABASE_URL: testDb.appUrl, OUTBOX_POLL_INTERVAL_MS: '100' }),
    listenPort: 0,
  };
  appDb = createDatabase({ url: testDb.appUrl, max: 3, applicationName: 'wt-statuspage-test' });
  domain = createDomain({
    ticketKeyPrefix: config.TICKET_KEY_PREFIX,
    sealKey: deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.outboxSecret),
    csat: {
      signingKey: key(),
      landingUrl: new URL(CSAT_LANDING_PATH, config.APP_URL).toString(),
    },
  });
  const [lead] = await owner()
    .insert(schema.users)
    .values({ email: `lead-${randomUUID()}@example.test`, name: 'Lead', role: 'lead' })
    .returning({ id: schema.users.id });
  leadId = lead?.id ?? '';
  worker = await startWorker(config, createLogger(config), { queuePrefix: prefix });
});
afterAll(async () => {
  await worker.close();
  await appDb.close();
  await testDb.cleanup();
});

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Mail {
  readonly id: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

async function mailsFor(recipient: string): Promise<Mail[]> {
  const search = await fetch(
    `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${recipient}`)}`,
  );
  const found = (await search.json()) as { messages: { ID: string; Subject: string }[] };
  const mails: Mail[] = [];
  for (const entry of found.messages) {
    const full = (await (await fetch(`${mailpit}/api/v1/message/${entry.ID}`)).json()) as {
      Text: string;
      HTML: string;
    };
    mails.push({ id: entry.ID, subject: entry.Subject, text: full.Text, html: full.HTML });
  }
  return mails;
}

async function cleanMail(mails: readonly Mail[]): Promise<void> {
  if (mails.length === 0) return;
  await fetch(`${mailpit}/api/v1/messages`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ IDs: mails.map((mail) => mail.id) }),
  });
}

const address = (label: string) => `${label}-${randomBytes(4).toString('hex')}@example.test`;
const tokenIn = (text: string): string => /#token=([A-Za-z0-9._-]+)/.exec(text)?.[1] ?? '';
const ctx = (actor: { type: 'anonymous' | 'user'; id: string | null }) => domain.context({ actor });

const subscribe = (email: string, locale: 'en' | 'th' = 'en') =>
  appDb.db.transaction((tx) =>
    domain.statusPage.requestSubscription(tx, ctx(ANONYMOUS), { email, locale }),
  );
const confirm = (token: string) =>
  appDb.db.transaction((tx) => domain.statusPage.confirmSubscription(tx, ctx(ANONYMOUS), key(), token));

async function confirmedReader(label: string, locale: 'en' | 'th' = 'en'): Promise<string> {
  const email = address(label);
  await subscribe(email, locale);
  const [mail] = await waitFor(async () => {
    const mails = await mailsFor(email);
    return mails.length > 0 ? mails : undefined;
  }, `the confirmation email to ${email}`);
  const outcome = await confirm(tokenIn(mail?.text ?? ''));
  expect(outcome.value.outcome).toBe('confirmed');
  await cleanMail(await mailsFor(email));
  return email;
}

async function publishedPost(title: string, body: string, componentName: string): Promise<string> {
  const lead = { type: 'user', id: leadId } as const;
  const component = await appDb.db.transaction((tx) =>
    domain.statusPage.createComponent(tx, ctx(lead), {
      slug: `c-${randomBytes(3).toString('hex')}`,
      name: componentName,
      description: null,
      serviceId: null,
      public: true,
      position: 0,
    }),
  );
  const drafted = await appDb.db.transaction((tx) =>
    domain.statusPage.draftPost(tx, ctx(lead), {
      title,
      body,
      phase: 'investigating',
      impact: 'minor',
      componentIds: [component.value.id],
      incidentId: null,
    }),
  );
  await appDb.db.transaction((tx) => domain.statusPage.publishPost(tx, ctx(lead), drafted.value.id));
  return drafted.value.id;
}

describe('the double opt-in email', () => {
  it('sends the confirmation to the address, subscribes nobody until the link is followed, and expires', async () => {
    const email = address('reader');
    await subscribe(email);
    const [mail] = await waitFor(async () => {
      const mails = await mailsFor(email);
      return mails.length > 0 ? mails : undefined;
    }, 'the confirmation email');
    expect(mail?.subject).toBe('Confirm your subscription to status updates');
    const token = tokenIn(mail?.text ?? '');
    expect(token).toMatch(/^wts1\.c\./);
    // The link sits behind the fragment: the server never sees it in a request line.
    expect(mail?.text).toContain('/status/confirm#token=');
    const [row] = await owner().select().from(schema.statusSubscription);
    expect(row?.state).toBe('pending');

    // The token itself is not stored anywhere: only the row's nonce, which is not the link.
    expect(JSON.stringify(await owner().select().from(schema.outbox))).not.toContain(token);

    expect((await confirm(token)).value.outcome).toBe('confirmed');
    await cleanMail(await mailsFor(email));
  });

  it('writes the confirmation in Thai for a reader who asked in Thai', async () => {
    const email = address('thai');
    await subscribe(email, 'th');
    const [mail] = await waitFor(async () => {
      const mails = await mailsFor(email);
      return mails.length > 0 ? mails : undefined;
    }, 'the Thai confirmation');
    expect(mail?.subject).toBe('ยืนยันการติดตามสถานะบริการ');
    await cleanMail(await mailsFor(email));
  });
});

describe('notices of a published post', () => {
  it('goes to every confirmed subscriber once, never to a pending or unsubscribed one, with an unsubscribe link', async () => {
    const reader = await confirmedReader('told');
    const quitter = await confirmedReader('quitter');
    const pending = address('pending');
    await subscribe(pending);
    await waitFor(async () => ((await mailsFor(pending)).length > 0 ? true : undefined), 'pending confirmation');

    // The quitter follows the unsubscribe link of an earlier notice before the next post.
    await publishedPost('Earlier issue', 'We looked into an earlier issue.', 'Earlier component');
    const [earlier] = await waitFor(async () => {
      const mails = await mailsFor(quitter);
      return mails.length > 0 ? mails : undefined;
    }, 'the earlier notice to the quitter');
    await waitFor(async () => ((await mailsFor(reader)).length > 0 ? true : undefined), 'the earlier notice to the reader');
    const unsubscribeToken = tokenIn(earlier?.text ?? '');
    expect(unsubscribeToken).toMatch(/^wts1\.u\./);
    const unsubscribed = await appDb.db.transaction((tx) =>
      domain.statusPage.unsubscribe(tx, ctx(ANONYMOUS), key(), unsubscribeToken),
    );
    expect(unsubscribed.value.outcome).toBe('unsubscribed');
    await cleanMail([...(await mailsFor(quitter)), ...(await mailsFor(reader))]);

    const postId = await publishedPost(
      'We are investigating an issue',
      'Some requests are slow for Checkout.',
      'Checkout',
    );
    const [notice] = await waitFor(async () => {
      const mails = await mailsFor(reader);
      return mails.length > 0 ? mails : undefined;
    }, 'the notice to the confirmed reader');
    expect(notice?.subject).toBe('We are investigating an issue');
    expect(notice?.text).toContain('Some requests are slow for Checkout.');
    expect(notice?.text).toContain('Affected: Checkout');
    expect(notice?.text).toContain('/status/unsubscribe#token=wts1.u.');
    expect(notice?.text).toContain(`${config.APP_URL}/status`);

    // Let the worker finish the batch, then check who was told, and how many times.
    await waitFor(async () => {
      const rows = await owner().select().from(schema.statusNotification);
      return rows.filter((row) => row.refId === postId).length >= 1 ? true : undefined;
    }, 'the claim rows');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await mailsFor(reader)).toHaveLength(1);
    expect(await mailsFor(quitter)).toHaveLength(0);
    // The reader who never confirmed got the confirmation only.
    const pendingMails = await mailsFor(pending);
    expect(pendingMails.map((mail) => mail.subject)).toEqual(['Confirm your subscription to status updates']);
    const claims = (await owner().select().from(schema.statusNotification)).filter(
      (row) => row.refId === postId,
    );
    // One claim per person who was confirmed and had not left: the earlier reader and this one, no one else.
    const confirmed = (await owner().select().from(schema.statusSubscription)).filter(
      (row) => row.state === 'confirmed',
    );
    expect(claims.map((row) => row.subscriptionId).toSorted()).toEqual(
      confirmed.map((row) => row.id).toSorted(),
    );
    expect(confirmed.length).toBeGreaterThanOrEqual(2);
    await cleanMail([...(await mailsFor(reader)), ...pendingMails]);
  });

  it('a draft, or a post nobody published, tells nobody', async () => {
    const reader = await confirmedReader('quiet');
    const lead = { type: 'user', id: leadId } as const;
    await appDb.db.transaction((tx) =>
      domain.statusPage.draftPost(tx, ctx(lead), {
        title: 'Never published',
        body: 'A draft.',
        phase: 'investigating',
        impact: 'none',
        componentIds: [],
        incidentId: null,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await mailsFor(reader)).toHaveLength(0);
  });
});
