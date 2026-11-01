import { randomBytes, randomUUID } from 'node:crypto';

import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { createDomain, verifyCsatToken, type Domain } from '@watchtower/domain';
import { CSAT_JOBS, CSAT_LANDING_PATH, QUEUE_NAMES, parseRedisUrl } from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import { startWorker, type RunningWorker } from '../worker.js';

// The CSAT scheduler and the survey email, end to end on real Postgres, Redis and Mailpit: a ticket is
// resolved, the `csat` sweep queues the email in the outbox, the relay moves it to BullMQ and the
// email processor renders it (EN or TH) and sends it over SMTP to Mailpit. Nothing leaves the machine.
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
const owner = () => testDb.owner.db;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  config = {
    ...testConfig({ DATABASE_URL: testDb.appUrl, OUTBOX_POLL_INTERVAL_MS: '100' }),
    listenPort: 0,
  };
  appDb = createDatabase({ url: testDb.appUrl, max: 3, applicationName: 'wt-csat-test' });
  // The same keys the worker derives from its config.
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
  csatQueue = new Queue(QUEUE_NAMES.csat, { connection: parseRedisUrl(config.REDIS_URL), prefix });
  worker = await startWorker(config, createLogger(config), { queuePrefix: prefix });
});

afterAll(async () => {
  await worker.close();
  await csatQueue.obliterate({ force: true });
  await csatQueue.close();
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
  await fetch(`${mailpit}/api/v1/messages`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ IDs: mails.map((mail) => mail.id) }),
  });
}

/** A resolved portal ticket whose survey is due now. */
async function dueSurvey(locale?: 'th' | 'en') {
  const email = `csat-${randomBytes(4).toString('hex')}@example.com`;
  const ctx = domain.context({ actor: { type: 'user', id: null } });
  const { value } = await appDb.db.transaction((tx) =>
    domain.tickets.create(tx, ctx, {
      orgId,
      subject: 'Reports are empty',
      body: 'Nothing shows up.',
      requester: { email, name: 'Nok' },
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
const statusOf = async (ticketId: string) =>
  (
    await owner()
      .select({ status: schema.csatSurvey.status })
      .from(schema.csatSurvey)
      .where(eq(schema.csatSurvey.ticketId, ticketId))
  )[0]?.status;

describe('the csat queue in the worker', () => {
  it('sends the survey in English with five rating links that carry the token in the fragment', async () => {
    const s = await dueSurvey();
    await sweepNow();
    const [mail] = await waitFor(async () => {
      const mails = await mailsFor(s.email);
      return mails.length > 0 ? mails : undefined;
    }, 'the survey email in Mailpit');
    if (!mail) throw new Error('no mail');
    expect(mail.subject).toBe(`How did we do on OPS-${String(s.ticketNumber)}?`);
    const links = [...mail.text.matchAll(/(http\S+#token=\S+)/g)].map((match) => match[1] ?? '');
    expect(links).toHaveLength(5);
    const scores = links.map((link) => new URL(link).hash.match(/&score=(\d)$/)?.[1]);
    expect(scores).toEqual(['1', '2', '3', '4', '5']);
    for (const link of links) {
      expect(new URL(link).search).toBe('');
      expect(
        link.startsWith(`${new URL(CSAT_LANDING_PATH, config.APP_URL).toString()}#token=`),
      ).toBe(true);
    }
    const token = new URL(links[0] ?? '').hash.slice(1).split('&')[0]?.replace('token=', '') ?? '';
    const claims = verifyCsatToken(
      deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.csatLink),
      token,
      new Date(),
    );
    expect(claims?.surveyId).toBe(s.surveyId);
    expect(mail.html).not.toMatch(/<img|<script/i);
    expect(await statusOf(s.ticketId)).toBe('sent');

    // The link is a one-time secret: the outbox row is blanked once sent, and Redis never held it.
    await waitFor(async () => {
      const { rows } = await testDb.owner.pool.query<{ payload: unknown; status: string }>(
        `SELECT payload, status FROM outbox WHERE job_id = $1`,
        [`csat-survey-${s.surveyId}`],
      );
      return rows[0]?.status === 'sent' ? rows[0] : undefined;
    }, 'the outbox row to be marked sent');
    await cleanMail([mail]);
  });

  it('sends it in Thai to a contact who prefers Thai', async () => {
    const s = await dueSurvey('th');
    await sweepNow();
    const [mail] = await waitFor(async () => {
      const mails = await mailsFor(s.email);
      return mails.length > 0 ? mails : undefined;
    }, 'the Thai survey email in Mailpit');
    expect(mail?.subject).toBe(`เราให้บริการ OPS-${String(s.ticketNumber)} เป็นอย่างไรบ้าง`);
    expect(mail?.text).toContain('5 - พอใจมาก');
    if (mail) await cleanMail([mail]);
  });

  it('sends exactly one reminder with the same link when 48 hours pass unanswered', async () => {
    const s = await dueSurvey();
    await sweepNow();
    await waitFor(
      async () => ((await mailsFor(s.email)).length === 1 ? true : undefined),
      'the first email',
    );
    await owner()
      .update(schema.csatSurvey)
      .set({ reminderDueAt: new Date(Date.now() - 1000) })
      .where(eq(schema.csatSurvey.id, s.surveyId));
    await sweepNow();
    const mails = await waitFor(async () => {
      const found = await mailsFor(s.email);
      return found.length === 2 ? found : undefined;
    }, 'the reminder');
    const reminder = mails.find((mail) => mail.text.startsWith('A reminder'));
    const first = mails.find((mail) => !mail.text.startsWith('A reminder'));
    expect(reminder).toBeDefined();
    const tokenIn = (mail: Mail | undefined) => /#token=(\S+?)&score=1/.exec(mail?.text ?? '')?.[1];
    expect(tokenIn(reminder)).toBeDefined();
    expect(tokenIn(reminder)).toBe(tokenIn(first));
    // A third sweep sends nothing more.
    await sweepNow();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await mailsFor(s.email)).toHaveLength(2);
    await cleanMail(mails);
  });

  it('sends nothing for a ticket reopened before the survey was due', async () => {
    const s = await dueSurvey();
    const ctx = domain.context({ actor: { type: 'user', id: null } });
    await appDb.db.transaction((tx) =>
      domain.tickets.changeStatus(tx, ctx, { ref: s.ticketId, status: 'open' }),
    );
    await sweepNow();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await mailsFor(s.email)).toHaveLength(0);
    expect(await statusOf(s.ticketId)).toBe('voided');
  });
});
