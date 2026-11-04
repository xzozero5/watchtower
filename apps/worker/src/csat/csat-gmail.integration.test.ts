import { randomBytes, randomUUID } from 'node:crypto';

import { ChannelError, gmail } from '@watchtower/channels';
import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { createDomain, type Domain } from '@watchtower/domain';
import { CSAT_JOBS, CSAT_LANDING_PATH, QUEUE_NAMES, parseRedisUrl } from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../logger.js';
import type { GmailSender, OutboundChannels } from '../outbound/channels.js';
import { testConfig } from '../testing/support.js';
import { startWorker, type RunningWorker } from '../worker.js';

// T-174: a survey for a ticket that came in through a Gmail mailbox leaves from that support mailbox
// (the Gmail adapter, here over the in-memory transport), not over SMTP. Real Postgres, Redis and
// Mailpit: Mailpit must stay empty, because SMTP is not the way this survey goes.
const prefix = `wt-test-${randomBytes(4).toString('hex')}`;
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const mailpit = process.env.MAILPIT_URL ?? 'http://localhost:8025';

let testDb: TestDatabase;
let config: ReturnType<typeof testConfig>;
let worker: RunningWorker;
let csatQueue: Queue;
let appDb: Database;
let domain: Domain;
let orgId: string;
let accountId: string;
let transport: gmail.FakeGmailTransport;
let connected = true;
const owner = () => testDb.owner.db;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  config = {
    ...testConfig({ DATABASE_URL: testDb.appUrl, OUTBOX_POLL_INTERVAL_MS: '100' }),
    listenPort: 0,
  };
  appDb = createDatabase({ url: testDb.appUrl, max: 3, applicationName: 'wt-csat-gmail-test' });
  domain = createDomain({
    ticketKeyPrefix: config.TICKET_KEY_PREFIX,
    sealKey: deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.outboxSecret),
    csat: {
      signingKey: deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.csatLink),
      landingUrl: new URL(CSAT_LANDING_PATH, config.APP_URL).toString(),
    },
  });
  const [org] = await owner()
    .insert(schema.organization)
    .values({ name: `Org ${randomUUID()}` })
    .returning({ id: schema.organization.id });
  orgId = org?.id ?? '';
  const [account] = await owner()
    .insert(schema.channelAccount)
    .values({ type: 'gmail', name: 'Support mailbox' })
    .returning({ id: schema.channelAccount.id });
  accountId = account?.id ?? '';
  transport = new gmail.FakeGmailTransport();
  const adapter = new gmail.GmailAdapter({ transport });
  const sender: GmailSender = {
    from: { address: 'support@desk.example.test', name: 'Support' },
    send: (input) => adapter.send(input),
  };
  const channels: OutboundChannels = {
    gmail: () => (connected ? sender : undefined),
    line: () => undefined,
  };
  csatQueue = new Queue(QUEUE_NAMES.csat, { connection: parseRedisUrl(config.REDIS_URL), prefix });
  worker = await startWorker(config, createLogger(config), {
    queuePrefix: prefix,
    overrides: { outbound: { channels } },
  });
});

afterAll(async () => {
  await worker.close();
  await csatQueue.obliterate({ force: true });
  await csatQueue.close();
  await appDb.close();
  await testDb.cleanup();
});

async function waitFor<T>(
  read: () => Promise<T | undefined> | T | undefined,
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

async function smtpMailsFor(recipient: string): Promise<number> {
  const search = await fetch(
    `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${recipient}`)}`,
  );
  return ((await search.json()) as { messages: unknown[] }).messages.length;
}

/** A resolved Gmail ticket whose survey is due now. */
async function dueSurvey(locale?: 'th' | 'en') {
  const email = `csat-gmail-${randomBytes(4).toString('hex')}@example.com`;
  const ctx = domain.context({ actor: { type: 'user', id: null } });
  const { value } = await appDb.db.transaction((tx) =>
    domain.tickets.create(tx, ctx, {
      orgId,
      subject: 'Reports are empty',
      body: 'Nothing shows up.',
      requester: { email, name: 'Nok' },
      channel: 'gmail',
      channelAccountId: accountId,
    }),
  );
  const ticket = value.ticket;
  if (locale !== undefined && ticket.requesterContactId !== null) {
    await owner()
      .update(schema.contact)
      .set({ notificationPrefs: { locale } })
      .where(eq(schema.contact.id, ticket.requesterContactId));
  }
  for (const status of ['open', 'resolved'] as const) {
    await appDb.db.transaction((tx) =>
      domain.tickets.changeStatus(tx, ctx, { ref: ticket.id, status }),
    );
  }
  await owner()
    .update(schema.csatSurvey)
    .set({ sendAfter: new Date(Date.now() - 60_000) })
    .where(eq(schema.csatSurvey.ticketId, ticket.id));
  const [survey] = await owner()
    .select()
    .from(schema.csatSurvey)
    .where(eq(schema.csatSurvey.ticketId, ticket.id));
  return { email, ticketNumber: ticket.number, surveyId: survey?.id ?? '', ticketId: ticket.id };
}

const sweepNow = () => csatQueue.add(CSAT_JOBS.sweep, {}, { removeOnComplete: true });

interface Sent {
  readonly headers: string;
  readonly text: string;
  readonly html: string;
}

/** Splits a message built by the adapter: its headers and its base64 text and HTML parts. */
function readRaw(raw: string): Sent {
  const source = Buffer.from(raw.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString(
    'utf8',
  );
  const part = (type: string): string => {
    const start = source.indexOf(`Content-Type: ${type}`);
    if (start < 0) return '';
    const body = source.slice(start).split('\r\n\r\n')[1] ?? '';
    const encoded = body.split('\r\n--')[0] ?? '';
    return Buffer.from(encoded.replaceAll('\r\n', ''), 'base64').toString('utf8');
  };
  return {
    headers: source.split('\r\n\r\n')[0] ?? '',
    text: part('text/plain'),
    html: part('text/html'),
  };
}

const sentTo = (email: string): Sent[] =>
  transport.sent
    .map((message) => readRaw(message.raw ?? ''))
    .filter((m) => m.headers.includes(email));

const dispatchOf = async (surveyId: string, kind: 'survey' | 'reminder') =>
  (
    await owner()
      .select()
      .from(schema.csatEmailDispatch)
      .where(eq(schema.csatEmailDispatch.surveyId, surveyId))
  ).find((row) => row.kind === kind);

describe('the CSAT survey of a Gmail ticket', () => {
  it('leaves from the support mailbox as a new thread with an HTML and a plain-text part, not over SMTP', async () => {
    const s = await dueSurvey();
    await sweepNow();
    const [mail] = await waitFor(() => {
      const found = sentTo(s.email);
      return found.length > 0 ? found : undefined;
    }, 'the survey in the Gmail mailbox');
    if (!mail) throw new Error('no mail');
    expect(mail.headers).toContain('From: Support <support@desk.example.test>');
    expect(mail.headers).toContain(`To: ${s.email}`);
    expect(mail.headers).toContain(`Subject: How did we do on OPS-${String(s.ticketNumber)}?`);
    expect(mail.headers).toContain('Auto-Submitted: auto-generated');
    expect(mail.headers).toContain(`Message-ID: <wt.csat-${s.surveyId}-survey@`);
    // A new thread: nothing to reply to, no References, no [OPS-n] token that would route a reply back.
    expect(mail.headers).not.toMatch(/^(In-Reply-To|References):/m);
    expect(mail.headers).not.toContain('[OPS-');
    for (const score of [1, 2, 3, 4, 5]) {
      expect(mail.text).toContain(`&score=${String(score)}`);
      expect(mail.html).toContain(`&amp;score=${String(score)}`);
    }
    expect(mail.html).not.toMatch(/<img|<script|<style|<link/i);

    const row = await waitFor(async () => {
      const found = await dispatchOf(s.surveyId, 'survey');
      return found?.state === 'sent' ? found : undefined;
    }, 'the dispatch ledger to say sent');
    expect(row.channelAccountId).toBe(accountId);
    expect(row.providerMessageId).toBeTruthy();
    expect(await smtpMailsFor(s.email)).toBe(0);
  });

  it('is written in Thai for a Thai contact', async () => {
    const s = await dueSurvey('th');
    await sweepNow();
    const [mail] = await waitFor(() => {
      const found = sentTo(s.email);
      return found.length > 0 ? found : undefined;
    }, 'the Thai survey in the Gmail mailbox');
    expect(mail?.text).toContain('5 - พอใจมาก');
    expect(mail?.html).toContain('lang="th"');
  });

  it('sends the one reminder from the mailbox too, and never a third message', async () => {
    const s = await dueSurvey();
    await sweepNow();
    await waitFor(() => (sentTo(s.email).length === 1 ? true : undefined), 'the survey');
    await owner()
      .update(schema.csatSurvey)
      .set({ reminderDueAt: new Date(Date.now() - 1000) })
      .where(eq(schema.csatSurvey.id, s.surveyId));
    await sweepNow();
    const both = await waitFor(() => {
      const found = sentTo(s.email);
      return found.length === 2 ? found : undefined;
    }, 'the reminder');
    expect(both.some((mail) => mail.text.startsWith('A reminder'))).toBe(true);
    await waitFor(async () => {
      const row = await dispatchOf(s.surveyId, 'reminder');
      return row?.state === 'sent' ? row : undefined;
    }, 'the reminder to be recorded as sent');
    await sweepNow();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(sentTo(s.email)).toHaveLength(2);
  });

  it('a send that certainly did not leave is released and retried, and goes out once', async () => {
    const s = await dueSurvey();
    transport.failNext(
      'users.messages.send',
      new ChannelError({
        provider: 'gmail',
        operation: 'users.messages.send',
        kind: 'rate_limited',
        status: 429,
      }),
    );
    await sweepNow();
    await waitFor(
      () => (sentTo(s.email).length === 1 ? true : undefined),
      'the retried send',
      30_000,
    );
    const row = await dispatchOf(s.surveyId, 'survey');
    expect(row?.state).toBe('sent');
    expect(row?.attempts).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(sentTo(s.email)).toHaveLength(1);
  });

  it('a send that may have left is never repeated', async () => {
    const s = await dueSurvey();
    transport.failNext(
      'users.messages.send',
      new ChannelError({
        provider: 'gmail',
        operation: 'users.messages.send',
        kind: 'timeout',
      }),
    );
    await sweepNow();
    await waitFor(async () => {
      const row = await dispatchOf(s.surveyId, 'survey');
      return row === undefined ? undefined : true;
    }, 'the claim');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(sentTo(s.email)).toHaveLength(0);
    const row = await dispatchOf(s.surveyId, 'survey');
    expect(row?.state).toBe('claimed');
    expect(row?.attempts).toBe(1);
  });

  it('waits while the mailbox is not connected and sends when it is, without SMTP', async () => {
    const s = await dueSurvey();
    connected = false;
    await sweepNow();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(sentTo(s.email)).toHaveLength(0);
    expect(await dispatchOf(s.surveyId, 'survey')).toBeUndefined();
    connected = true;
    await waitFor(() => (sentTo(s.email).length === 1 ? true : undefined), 'the late send', 30_000);
    expect(await smtpMailsFor(s.email)).toBe(0);
  });
});
