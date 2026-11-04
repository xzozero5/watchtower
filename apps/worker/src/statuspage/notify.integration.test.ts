import { randomBytes, randomUUID } from 'node:crypto';

import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { createDomain, newStatusNonce, type Domain } from '@watchtower/domain';
import { CSAT_LANDING_PATH, STATUSPAGE_JOBS } from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';
import { UnrecoverableError, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../logger.js';
import type { Mailer, OutboundMessage } from '../mailer.js';
import type { ProcessorContext } from '../processors/index.js';
import { testConfig } from '../testing/support.js';
import { createStatusPageRegistration } from './index.js';

// The notice job on its own, against a real Postgres and a fake mailer: a closed page mails nobody, and one
// reader the mail server refuses never stops the others from being told.
let testDb: TestDatabase;
let appDb: Database;
let domain: Domain;
let postId: string;
const owner = () => testDb.owner.db;

beforeAll(async () => {
  testDb = await createTestDatabase(
    process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower',
  );
  appDb = createDatabase({ url: testDb.appUrl, max: 3, applicationName: 'wt-notify-test' });
  const config = testConfig({ DATABASE_URL: testDb.appUrl });
  domain = createDomain({
    ticketKeyPrefix: config.TICKET_KEY_PREFIX,
    sealKey: deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.outboxSecret),
    csat: {
      signingKey: deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.csatLink),
      landingUrl: new URL(CSAT_LANDING_PATH, config.APP_URL).toString(),
    },
  });
  const [lead] = await owner()
    .insert(schema.users)
    .values({ email: `lead-${randomUUID()}@example.test`, name: 'Lead', role: 'lead' })
    .returning({ id: schema.users.id });
  const ctx = domain.context({ actor: { type: 'user', id: lead?.id ?? null } });
  const drafted = await appDb.db.transaction((tx) =>
    domain.statusPage.draftPost(tx, ctx, {
      title: 'We are investigating an issue',
      body: 'Some requests are slow.',
      phase: 'investigating',
      impact: 'minor',
      componentIds: [],
      incidentId: null,
    }),
  );
  postId = drafted.value.id;
  await appDb.db.transaction((tx) => domain.statusPage.publishPost(tx, ctx, postId));
});
afterAll(async () => {
  await appDb.close();
  await testDb.cleanup();
});

async function addReader(label: string): Promise<string> {
  const email = `${label}-${randomBytes(3).toString('hex')}@example.test`;
  await owner().insert(schema.statusSubscription).values({
    email,
    state: 'confirmed',
    confirmedAt: new Date(),
    confirmNonce: newStatusNonce(),
    unsubscribeNonce: newStatusNonce(),
  });
  return email;
}

function processor(open: boolean, send: (message: OutboundMessage) => Promise<void>) {
  const config = testConfig({
    DATABASE_URL: testDb.appUrl,
    STATUS_PAGE_PUBLIC: open ? 'true' : 'false',
  });
  const mailer: Mailer = { send, close: () => undefined };
  // Only the parts the statuspage consumer reads.
  const context = {
    config,
    logger: createLogger(config),
    database: appDb,
    mailer,
    domain,
  } as unknown as ProcessorContext;
  const run = createStatusPageRegistration(context);
  return () =>
    run({
      name: STATUSPAGE_JOBS.notify,
      data: { kind: 'post', refId: postId },
    } as Job);
}

const claims = async () =>
  (await owner().select().from(schema.statusNotification)).filter((row) => row.refId === postId);

describe('the notice job', () => {
  it('mails nobody while the page is closed, and claims nobody', async () => {
    await addReader('closed');
    const sent: string[] = [];
    const result = await processor(false, (message) => {
      sent.push(message.to);
      return Promise.resolve();
    })();
    expect(result).toEqual({ sent: 0, skipped: 'page_closed' });
    expect(sent).toEqual([]);
    expect(await claims()).toHaveLength(0);
    await owner().delete(schema.statusSubscription);
  });

  it('keeps going past a reader the mail server refuses for good, and does not mail that reader again', async () => {
    const readers = [await addReader('a'), await addReader('b'), await addReader('c')];
    const refused = readers[1] ?? '';
    const sent: string[] = [];
    const run = processor(true, (message) => {
      if (message.to === refused) {
        return Promise.reject(
          Object.assign(new Error('mailbox unavailable'), { responseCode: 550 }),
        );
      }
      sent.push(message.to);
      return Promise.resolve();
    });
    expect(await run()).toMatchObject({ sent: 2, bounced: 1 });
    expect(sent.toSorted()).toEqual(readers.filter((email) => email !== refused).toSorted());
    // A second run finds everyone claimed: the refused address is not tried again.
    expect(await run()).toMatchObject({ sent: 0 });
    expect(sent).toHaveLength(2);
    await owner().delete(schema.statusSubscription);
  });

  it('T-207a C-7: every notice carries List-Unsubscribe and List-Unsubscribe-Post (RFC 8058) with a link that only unsubscribes', async () => {
    await addReader('headers');
    const messages: OutboundMessage[] = [];
    await processor(true, (message) => {
      messages.push(message);
      return Promise.resolve();
    })();
    expect(messages).toHaveLength(1);
    const headers = messages[0]?.headers ?? {};
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const link = /^<(https?:\/\/[^>]+)>$/.exec(headers['List-Unsubscribe'] ?? '')?.[1] ?? '';
    const url = new URL(link);
    expect(url.pathname).toBe('/v1/status/subscriptions/unsubscribe/one-click');
    expect(url.searchParams.get('token')?.length ?? 0).toBeGreaterThan(20);
    await owner().delete(schema.statusSubscription);
    await owner().delete(schema.statusNotification);
  });

  it('T-207a C-7: the third hard bounce in a row suppresses the address, and a delivery starts the count again', async () => {
    const bouncing = await addReader('bouncing');
    const healthy = await addReader('healthy');
    await owner()
      .update(schema.statusSubscription)
      .set({ bounceCount: 2 })
      .where(eq(schema.statusSubscription.email, bouncing));
    await owner()
      .update(schema.statusSubscription)
      .set({ bounceCount: 2 })
      .where(eq(schema.statusSubscription.email, healthy));
    await processor(true, (message) =>
      message.to === bouncing
        ? Promise.reject(Object.assign(new Error('no such user'), { responseCode: 550 }))
        : Promise.resolve(),
    )();
    const rows = await owner().select().from(schema.statusSubscription);
    const row = (email: string) => rows.find((r) => r.email === email);
    expect(row(bouncing)).toMatchObject({ bounceCount: 3, state: 'unsubscribed' });
    expect(row(bouncing)?.suppressedAt).toBeInstanceOf(Date);
    expect(row(healthy)).toMatchObject({ bounceCount: 0, state: 'confirmed', suppressedAt: null });
    await owner().delete(schema.statusSubscription);
    await owner().delete(schema.statusNotification);
  });

  it('tells everyone else first when one send fails for a reason that may pass, then retries only that reader', async () => {
    const readers = [await addReader('x'), await addReader('y'), await addReader('z')];
    const flaky = readers[0] ?? '';
    const sent: string[] = [];
    let failing = true;
    const run = processor(true, (message) => {
      if (message.to === flaky && failing) return Promise.reject(new Error('connection reset'));
      sent.push(message.to);
      return Promise.resolve();
    });
    await expect(run()).rejects.toThrow('connection reset');
    expect(sent.toSorted()).toEqual(readers.filter((email) => email !== flaky).toSorted());
    // The failed reader has no claim, so the retry of the job reaches exactly that reader.
    expect(await claims()).toHaveLength(readers.length - 1);
    failing = false;
    expect(await run()).toMatchObject({ sent: 1 });
    expect(sent).toHaveLength(readers.length);
    expect(sent.at(-1)).toBe(flaky);
    expect(await claims()).toHaveLength(readers.length);
    const row = await owner()
      .select()
      .from(schema.statusSubscription)
      .where(eq(schema.statusSubscription.email, flaky));
    expect(row[0]?.state).toBe('confirmed');
  });

  it('535 (our login refused) ends the job at once without retrying, marks nobody rejected and keeps no claim (T-125a)', async () => {
    await owner().delete(schema.statusSubscription);
    await owner().delete(schema.statusNotification);
    const readers = [await addReader('au1'), await addReader('au2'), await addReader('au3')];
    let attempts = 0;
    const run = processor(true, () => {
      attempts += 1;
      return Promise.reject(
        Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 }),
      );
    });
    const error: unknown = await run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnrecoverableError);
    // It did not hammer the server once per reader, and nobody was written off as a bounce.
    expect(attempts).toBe(1);
    expect(await claims()).toHaveLength(0);
    // After the credentials are fixed, the next run reaches everyone.
    const sent: string[] = [];
    const fixed = processor(true, (message) => {
      sent.push(message.to);
      return Promise.resolve();
    });
    expect(await fixed()).toMatchObject({ sent: 3 });
    expect(sent.toSorted()).toEqual(readers.toSorted());
    await owner().delete(schema.statusSubscription);
  });

  it('451 is temporary even when the transport calls it an envelope error: not a bounce, the job retries (T-125a)', async () => {
    await owner().delete(schema.statusNotification);
    const readers = [await addReader('tm1'), await addReader('tm2')];
    const later = readers[0] ?? '';
    const sent: string[] = [];
    let greylisted = true;
    const run = processor(true, (message) => {
      if (message.to === later && greylisted) {
        return Promise.reject(
          Object.assign(new Error('Try again later'), { code: 'EENVELOPE', responseCode: 451 }),
        );
      }
      sent.push(message.to);
      return Promise.resolve();
    });
    const error: unknown = await run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(sent).toEqual(readers.filter((email) => email !== later));
    greylisted = false;
    expect(await run()).toMatchObject({ sent: 1 });
    expect(sent.at(-1)).toBe(later);
    await owner().delete(schema.statusSubscription);
  });
});
