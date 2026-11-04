import { createECDH, createDecipheriv, hkdfSync, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { webpush } from '@watchtower/channels';
import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { createDomain, type Domain } from '@watchtower/domain';
import { QUEUE_NAMES, webPushPayloadSchema } from '@watchtower/shared';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import { createWebPushProcessor, type VapidConfig } from './processor.js';
import { createHttpsPushTransport, type PushTransport } from './transport.js';

// The Web Push consumer against a real Postgres and a fake push service on a local port. Nothing here
// reaches a real push service: the "public" address the resolver returns is dialled to 127.0.0.1.
let testDb: TestDatabase;
let appDb: Database;
let domain: Domain;
let server: http.Server;
let serverPort = 0;
const owner = () => testDb.owner.db;

interface Seen {
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}
const seen: Seen[] = [];
let answer: { status: number; headers?: Record<string, string> } = { status: 201 };

const vapid: VapidConfig = {
  keys: webpush.generateVapidKeys(),
  subject: 'mailto:ops@example.test',
};

// The browser's side: a key pair and an auth secret that the subscription carries.
const ua = createECDH('prime256v1');
ua.generateKeys();
const authSecret = Buffer.alloc(16, 9);
const keysOf = () => ({
  p256dh: webpush.b64urlEncode(ua.getPublicKey()),
  auth: webpush.b64urlEncode(authSecret),
});

/** RFC 8291 section 3.4 from the browser's side: what the service worker would get. */
function decrypt(body: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLen = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + idLen);
  const record = body.subarray(21 + idLen);
  const shared = ua.computeSecret(senderPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
  );
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([
    decipher.update(record.subarray(0, record.length - 16)),
    decipher.final(),
  ]);
  expect(padded.at(-1)).toBe(2);
  return padded.subarray(0, padded.length - 1).toString('utf8');
}

beforeAll(async () => {
  testDb = await createTestDatabase(
    process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower',
  );
  appDb = createDatabase({ url: testDb.appUrl, max: 3, applicationName: 'wt-webpush-test' });
  const config = testConfig({ DATABASE_URL: testDb.appUrl });
  domain = createDomain({
    ticketKeyPrefix: config.TICKET_KEY_PREFIX,
    sealKey: Buffer.alloc(32, 1),
    csat: { signingKey: Buffer.alloc(32, 2), landingUrl: 'http://localhost:3000/csat' },
  });
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({ url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks) });
      response.writeHead(answer.status, answer.headers);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  serverPort = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  await appDb.close();
  await testDb.cleanup();
});
beforeEach(() => {
  seen.length = 0;
  answer = { status: 201 };
});

const fakeTransport = (resolveTo: string[] = ['8.8.8.8']): PushTransport =>
  createHttpsPushTransport({
    resolve: () => Promise.resolve(resolveTo),
    request: http.request,
    dial: () => ({ address: '127.0.0.1', port: serverPort }),
    timeoutMs: 2000,
  });

function processor(options: { vapidOn?: boolean; transport?: PushTransport } = {}) {
  const config = testConfig({ DATABASE_URL: testDb.appUrl });
  return createWebPushProcessor({
    database: appDb,
    logger: createLogger(config),
    transport: options.transport ?? fakeTransport(),
    vapid: () => Promise.resolve(options.vapidOn === false ? null : vapid),
    ticketKeyPrefix: 'OPS',
  });
}

async function makeUser(role: 'agent' | 'head' = 'agent'): Promise<string> {
  const [row] = await owner()
    .insert(schema.users)
    .values({ email: `u-${randomUUID()}@example.test`, name: 'U', role })
    .returning({ id: schema.users.id });
  return row?.id ?? '';
}

async function makeSubscription(
  userId: string,
  endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
  failureCount = 0,
): Promise<string> {
  const [row] = await owner()
    .insert(schema.webPushSubscription)
    .values({ userId, endpoint, ...keysOf(), failureCount })
    .returning({ id: schema.webPushSubscription.id });
  return row?.id ?? '';
}

async function makeNotification(
  userId: string,
  extra: Partial<typeof schema.notification.$inferInsert> = {},
): Promise<string> {
  const [row] = await owner()
    .insert(schema.notification)
    .values({
      userId,
      kind: 'ticket.p1',
      severity: 'critical',
      dedupeKey: randomUUID(),
      ...extra,
    })
    .returning({ id: schema.notification.id });
  return row?.id ?? '';
}

const job = (notificationId: string, subscriptionId: string, extra: object = {}) =>
  ({
    name: 'send',
    data: { notificationId, subscriptionId, ...extra },
    moveToDelayed: (): Promise<void> => {
      delayed.push(1);
      return Promise.resolve();
    },
  }) as unknown as Job;
const delayed: number[] = [];

const subscriptionRow = async (id: string) =>
  (
    await owner()
      .select()
      .from(schema.webPushSubscription)
      .where(eq(schema.webPushSubscription.id, id))
  )[0];

describe('sending', () => {
  it('sends an encrypted, customer-free message with TTL, urgency and topic, and notes the success', async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user);
    const note = await makeNotification(user);
    expect(await processor()(job(note, sub))).toEqual({ status: 'sent' });

    expect(seen).toHaveLength(1);
    const request = seen[0];
    expect(request?.url).toMatch(/^\/fcm\/send\//);
    expect(request?.headers).toMatchObject({
      'content-encoding': 'aes128gcm',
      ttl: '14400',
      urgency: 'high',
      topic: 'wt-ticket_p1',
    });
    expect(request?.headers.authorization).toMatch(/^vapid t=.+, k=.+$/);
    const plain = decrypt(request?.body ?? Buffer.alloc(0));
    expect(webPushPayloadSchema.parse(JSON.parse(plain))).toEqual({
      v: 1,
      kind: 'ticket.p1',
      severity: 'critical',
      notificationId: note,
      url: '/',
    });
    expect(Object.keys(JSON.parse(plain) as object).toSorted()).toEqual([
      'kind',
      'notificationId',
      'severity',
      'url',
      'v',
    ]);
    const row = await subscriptionRow(sub);
    expect(row?.lastSuccessAt).not.toBeNull();
    expect(row?.failureCount).toBe(0);
  });

  it('deletes the subscription on 410 and on 404', async () => {
    for (const status of [410, 404]) {
      const user = await makeUser();
      const sub = await makeSubscription(user);
      const note = await makeNotification(user);
      answer = { status };
      expect(await processor()(job(note, sub))).toEqual({
        status: 'subscription_removed',
        reason: 'gone',
      });
      expect(await subscriptionRow(sub)).toBeUndefined();
    }
  });

  it('retries 5xx and 429 (a thrown error, BullMQ backs off) and keeps the subscription', async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user);
    const note = await makeNotification(user);
    answer = { status: 503 };
    await expect(processor()(job(note, sub))).rejects.toThrow(/503/);
    answer = { status: 429 };
    await expect(processor()(job(note, sub))).rejects.toThrow(/429/);
    expect(await subscriptionRow(sub)).toBeDefined();
  });

  it('moves the job to the time `Retry-After` names, without using up an attempt', async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user);
    const note = await makeNotification(user);
    answer = { status: 429, headers: { 'Retry-After': '30' } };
    delayed.length = 0;
    await expect(processor()(job(note, sub), 'token')).rejects.toBeInstanceOf(DelayedError);
    expect(delayed).toHaveLength(1);
  });

  it('does not retry a 413 or a 400; the fifth in a row drops the subscription', async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, undefined, 3);
    const note = await makeNotification(user);
    answer = { status: 413 };
    expect(await processor()(job(note, sub))).toEqual({
      status: 'rejected',
      httpStatus: 413,
      removed: false,
    });
    expect((await subscriptionRow(sub))?.failureCount).toBe(4);
    answer = { status: 400 };
    expect(await processor()(job(note, sub))).toEqual({
      status: 'rejected',
      httpStatus: 400,
      removed: true,
    });
    expect(await subscriptionRow(sub)).toBeUndefined();
  });

  it('is off without a complete VAPID credential: nothing is sent', async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user);
    const note = await makeNotification(user);
    expect(await processor({ vapidOn: false })(job(note, sub))).toEqual({
      status: 'skipped',
      reason: 'disabled',
    });
    expect(seen).toHaveLength(0);
  });

  it("skips a notification already read, an expired job, a missing row and another person's subscription", async () => {
    const user = await makeUser();
    const other = await makeUser();
    const sub = await makeSubscription(user);
    const otherSub = await makeSubscription(other);
    const read = await makeNotification(user, { readAt: new Date() });
    const unread = await makeNotification(user);
    const run = processor();
    expect(await run(job(read, sub))).toEqual({ status: 'skipped', reason: 'read' });
    expect(await run(job(unread, sub, { notAfter: Date.now() - 1000 }))).toEqual({
      status: 'skipped',
      reason: 'expired',
    });
    expect(await run(job(randomUUID(), sub))).toEqual({
      status: 'skipped',
      reason: 'gone_notification',
    });
    // The job names someone else's browser for this person's notification: nothing is sent to it.
    expect(await run(job(unread, otherSub))).toEqual({
      status: 'skipped',
      reason: 'gone_subscription',
    });
    expect(seen).toHaveLength(0);
  });

  it('removes a stored subscription whose endpoint is not an allowed push service, and sends nothing', async () => {
    const user = await makeUser();
    const note = await makeNotification(user);
    for (const endpoint of [
      'https://evil.example/push',
      'https://169.254.169.254/latest/meta-data',
      'https://fcm.googleapis.com.evil.example/x',
    ]) {
      const sub = await makeSubscription(user, endpoint);
      expect(await processor()(job(note, sub))).toEqual({
        status: 'subscription_removed',
        reason: 'endpoint',
      });
      expect(await subscriptionRow(sub)).toBeUndefined();
    }
    expect(seen).toHaveLength(0);
  });

  it('refuses to connect when an allowed host resolves to a private address (no retry)', async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user);
    const note = await makeNotification(user);
    for (const address of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '::1']) {
      await expect(
        processor({ transport: fakeTransport([address]) })(job(note, sub)),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    }
    // One public and one private answer is refused too (a sign of rebinding).
    await expect(
      processor({ transport: fakeTransport(['8.8.8.8', '10.0.0.5']) })(job(note, sub)),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(seen).toHaveLength(0);
  });

  it('times out on a push service that does not answer, and the job fails (retried by BullMQ)', async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user);
    const note = await makeNotification(user);
    const silent = http.createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const transport = createHttpsPushTransport({
      resolve: () => Promise.resolve(['8.8.8.8']),
      request: http.request,
      dial: () => ({ address: '127.0.0.1', port: (silent.address() as AddressInfo).port }),
      timeoutMs: 300,
    });
    await expect(processor({ transport })(job(note, sub))).rejects.toMatchObject({
      reason: 'timeout',
    });
    silent.closeAllConnections();
    await new Promise<void>((resolve) =>
      silent.close(() => {
        resolve();
      }),
    );
  });

  it('refuses a payload job with bad data for good', async () => {
    await expect(
      processor()({ name: 'send', data: { notificationId: 'x' } } as Job),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

describe('what raises a push job', () => {
  it('writes one outbox job per browser of each person told, in the same transaction, and none for a person with no browser', async () => {
    const head = await makeUser('head');
    const lonelyHead = await makeUser('head');
    const subA = await makeSubscription(head);
    const subB = await makeSubscription(head);
    await owner().delete(schema.outbox);
    const result = await domain.notifications.opsAlert(
      appDb.db,
      domain.context({ actor: { type: 'system', id: null } }),
      { kind: 'ops.outbox_dead', data: { count: 3 } },
    );
    expect(result.created).toBeGreaterThanOrEqual(2);
    const jobs = (await owner().select().from(schema.outbox)).filter(
      (row) => row.queue === QUEUE_NAMES.webPush,
    );
    expect(
      jobs.map((row) => (row.payload as { subscriptionId: string }).subscriptionId).toSorted(),
    ).toEqual([subA, subB].toSorted());
    expect(jobs.every((row) => row.jobId.startsWith('push-'))).toBe(true);
    // Ids only: the job holds no text of any kind.
    expect(Object.keys(jobs[0]?.payload ?? {}).toSorted()).toEqual([
      'notificationId',
      'subscriptionId',
    ]);
    expect(lonelyHead).toBeTruthy();
  });
});
