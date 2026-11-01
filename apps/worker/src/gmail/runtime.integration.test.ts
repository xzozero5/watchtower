import { generateKeyPairSync, randomUUID } from 'node:crypto';

import { ChannelError, gmail } from '@watchtower/channels';
import { createDatabase, schema, type Database } from '@watchtower/db';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import { createGmailRuntime, type GmailCredentialSource } from './runtime.js';
import { GOOGLE_TOKEN_URL } from './service-account.js';

// Mock or live: which transport the worker builds for a mailbox, decided by the gmail credential
// of the store. Live code is exercised with a scripted `fetch` only; disableNetConnect proves that
// nothing left the machine, and the mock cases prove that no live transport is even constructed.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const net = disableNetConnect();
const logger = createLogger(testConfig());
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_JSON = JSON.stringify({
  client_email: 'watchtower@project-id.iam.gserviceaccount.example.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
});

let testDb: TestDatabase;
let database: Database;
let accountId: string;
const MAILBOX = `${randomUUID().slice(0, 8)}@desk.example.test`;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  database = createDatabase({ url: testDb.appUrl, max: 3, applicationName: 'wt-gmail-rt-test' });
  const [account] = await testDb.owner.db
    .insert(schema.channelAccount)
    .values({ type: 'gmail', name: 'Support mailbox' })
    .returning({ id: schema.channelAccount.id });
  accountId = account?.id ?? '';
  await testDb.owner.db
    .insert(schema.gmailAccountState)
    .values({ channelAccountId: accountId, emailAddress: MAILBOX });
});

afterAll(async () => {
  await database.close();
  await testDb.cleanup();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

function source(configured: boolean, impersonateUser = MAILBOX) {
  const counts = { configured: 0, read: 0 };
  const credentials: GmailCredentialSource = {
    configured: () => {
      counts.configured += 1;
      return Promise.resolve(configured);
    },
    read: () => {
      counts.read += 1;
      return Promise.resolve({ serviceAccountJson: KEY_JSON, impersonateUser });
    },
  };
  return { credentials, counts };
}

describe('gmail runtime', () => {
  it('is mock without a credential source: the in-memory mailbox, no live transport', async () => {
    const runtime = createGmailRuntime({ database, logger, allowMock: true });
    expect(await runtime.mode()).toBe('mock');
    const transport = await runtime.transportFor({ id: accountId });
    expect(transport).toBeInstanceOf(gmail.FakeGmailTransport);
    expect(transport).not.toBeInstanceOf(gmail.LiveGmailTransport);
    expect(await runtime.transportFor({ id: accountId })).toBe(transport);
    expect(
      (await runtime.senderFor({ id: accountId, type: 'gmail', name: 'x' }))?.from.address,
    ).toBe(MAILBOX);
  });

  it('is mock while the gmail credential is incomplete, and never reads its values', async () => {
    const { credentials, counts } = source(false);
    const fetched: string[] = [];
    const runtime = createGmailRuntime({
      database,
      logger,
      allowMock: true,
      credentials,
      fetch: (url) => {
        fetched.push(url);
        return Promise.reject(new Error('mock mode must not use the network'));
      },
    });
    expect(await runtime.mode()).toBe('mock');
    expect(await runtime.transportFor({ id: accountId })).toBeInstanceOf(gmail.FakeGmailTransport);
    expect(counts.read).toBe(0);
    expect(fetched).toEqual([]);
  });

  it('falls back to mock, never to live, when the credential store cannot be read', async () => {
    const runtime = createGmailRuntime({
      database,
      logger,
      allowMock: true,
      credentials: {
        configured: () => Promise.reject(new Error('database unavailable')),
        read: () => Promise.reject(new Error('unreachable')),
      },
    });
    expect(await runtime.mode()).toBe('mock');
  });

  it('is live with a complete credential: a live transport for the delegated mailbox only, built without touching the network', async () => {
    const { credentials, counts } = source(true);
    const requests: { url: string; authorization: string | null }[] = [];
    const runtime = createGmailRuntime({
      database,
      logger,
      allowMock: true,
      credentials,
      now: () => Date.UTC(2030, 0, 7),
      fetch: (url, init) => {
        const headers = new Headers(init?.headers);
        requests.push({ url, authorization: headers.get('authorization') });
        if (url === GOOGLE_TOKEN_URL) {
          return Promise.resolve(
            new Response(JSON.stringify({ access_token: 'scripted-token', expires_in: 3600 }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ id: 'm1', threadId: 't1', labelIds: ['INBOX'] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    });
    expect(await runtime.mode()).toBe('live');
    const transport = await runtime.transportFor({ id: accountId });
    expect(transport).toBeInstanceOf(gmail.LiveGmailTransport);
    expect(requests).toEqual([]); // constructing it called nobody

    const message = await transport?.getMessage({ id: 'm1', format: 'minimal' });
    expect(message?.id).toBe('m1');
    expect(requests.map((request) => request.url)).toEqual([
      GOOGLE_TOKEN_URL,
      expect.stringContaining('https://gmail.googleapis.com/gmail/v1/users/me/messages/m1'),
    ]);
    expect(requests[1]?.authorization).toBe('Bearer scripted-token');
    expect(counts.read).toBeGreaterThan(0);

    // Another mailbox is not the one the credential delegates to: no transport, no sender.
    const [other] = await testDb.owner.db
      .insert(schema.channelAccount)
      .values({ type: 'gmail', name: 'Another mailbox' })
      .returning({ id: schema.channelAccount.id });
    await testDb.owner.db
      .insert(schema.gmailAccountState)
      .values({ channelAccountId: other?.id ?? '', emailAddress: `other-${MAILBOX}` });
    expect(await runtime.transportFor({ id: other?.id ?? '' })).toBeUndefined();
    expect(
      await runtime.senderFor({ id: other?.id ?? '', type: 'gmail', name: 'x' }),
    ).toBeUndefined();
    expect(
      (await runtime.senderFor({ id: accountId, type: 'gmail', name: 'x' }))?.from.address,
    ).toBe(MAILBOX);
  });

  it('looks at the credential again after the refresh interval', async () => {
    let configured = false;
    let clock = 0;
    const runtime = createGmailRuntime({
      database,
      logger,
      allowMock: true,
      refreshMs: 1000,
      now: () => clock,
      credentials: {
        configured: () => Promise.resolve(configured),
        read: () => Promise.resolve({ serviceAccountJson: KEY_JSON, impersonateUser: MAILBOX }),
      },
      fetch: () => Promise.reject(new Error('not used')),
    });
    expect(await runtime.mode()).toBe('mock');
    configured = true;
    clock = 500;
    expect(await runtime.mode()).toBe('mock');
    clock = 1500;
    expect(await runtime.mode()).toBe('live');
  });

  it('keeps the live transport (and its token) while the credential is unchanged, and builds a new one for a rotated key', async () => {
    let clock = 0;
    let json = KEY_JSON;
    let reads = 0;
    const tokenRequests: string[] = [];
    const runtime = createGmailRuntime({
      database,
      logger,
      refreshMs: 1000,
      now: () => clock,
      credentials: {
        configured: () => Promise.resolve(true),
        read: () => {
          reads += 1;
          return Promise.resolve({ serviceAccountJson: json, impersonateUser: MAILBOX });
        },
      },
      fetch: (url) => {
        if (url === GOOGLE_TOKEN_URL) {
          tokenRequests.push(url);
          return Promise.resolve(
            new Response(JSON.stringify({ access_token: 'scripted-token', expires_in: 3600 }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ id: 'm1', threadId: 't1', labelIds: ['INBOX'] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    });
    const first = await runtime.transportFor({ id: accountId });
    await first?.getMessage({ id: 'm1', format: 'minimal' });
    // Five refresh intervals later (the credential is read again each time): same transport, no new token.
    for (let step = 1; step <= 5; step += 1) {
      clock = step * 1500;
      expect(await runtime.transportFor({ id: accountId })).toBe(first);
      await first?.getMessage({ id: 'm1', format: 'minimal' });
    }
    expect(reads).toBeGreaterThan(5);
    expect(tokenRequests).toHaveLength(1);

    // A rotated key is a different credential: a new transport.
    const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    json = JSON.stringify({
      client_email: 'watchtower@project-id.iam.gserviceaccount.example.com',
      private_key: rotated.export({ type: 'pkcs8', format: 'pem' }).toString(),
    });
    clock = 20_000;
    const next = await runtime.transportFor({ id: accountId });
    expect(next).toBeInstanceOf(gmail.LiveGmailTransport);
    expect(next).not.toBe(first);
  });
});

describe('gmail runtime in production (fakes not allowed)', () => {
  const account = () => ({ id: accountId, type: 'gmail', name: 'x' });

  it('has no transport and no sender without a credential source', async () => {
    const runtime = createGmailRuntime({ database, logger });
    expect(await runtime.transportFor({ id: accountId })).toBeUndefined();
    expect(await runtime.senderFor(account())).toBeUndefined();
  });

  it('has no transport and no sender while the gmail credential is incomplete', async () => {
    const { credentials, counts } = source(false);
    const runtime = createGmailRuntime({ database, logger, credentials });
    expect(await runtime.transportFor({ id: accountId })).toBeUndefined();
    expect(await runtime.senderFor(account())).toBeUndefined();
    expect(counts.read).toBe(0);
  });

  it('answers a retryable error, not a fake, when the credential store cannot be read at boot', async () => {
    let failing = true;
    const runtime = createGmailRuntime({
      database,
      logger,
      credentials: {
        configured: () =>
          failing ? Promise.reject(new Error('database unavailable')) : Promise.resolve(false),
        read: () => Promise.reject(new Error('unreachable')),
      },
    });
    for (const call of [
      () => runtime.transportFor({ id: accountId }),
      () => runtime.senderFor(account()),
      () => runtime.mode(),
    ]) {
      const error = await call().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ChannelError);
      expect((error as ChannelError).retryable).toBe(true);
    }
    // The store comes back: the next call decides from it (nothing was cached from the failure).
    failing = false;
    expect(await runtime.transportFor({ id: accountId })).toBeUndefined();
  });

  it('keeps its earlier decision when the store fails after it had answered', async () => {
    let clock = 0;
    let failing = false;
    const { credentials } = source(true);
    const runtime = createGmailRuntime({
      database,
      logger,
      refreshMs: 1000,
      now: () => clock,
      credentials: {
        configured: () =>
          failing ? Promise.reject(new Error('database unavailable')) : credentials.configured(),
        read: () => credentials.read(),
      },
      fetch: () => Promise.reject(new Error('not used')),
    });
    expect(await runtime.mode()).toBe('live');
    failing = true;
    clock = 5000;
    expect(await runtime.mode()).toBe('live');
  });
});

describe('gmail runtime never falls back from live to mock (N-1)', () => {
  const account = () => ({ id: accountId, type: 'gmail', name: 'x' });

  it('answers "not connected" when the credential is revoked after it was live, even with the mock opt-in', async () => {
    let clock = 0;
    let configured = true;
    const runtime = createGmailRuntime({
      database,
      logger,
      allowMock: true,
      refreshMs: 1000,
      now: () => clock,
      credentials: {
        configured: () => Promise.resolve(configured),
        read: () => Promise.resolve({ serviceAccountJson: KEY_JSON, impersonateUser: MAILBOX }),
      },
      fetch: () => Promise.reject(new Error('not used')),
    });
    expect(await runtime.mode()).toBe('live');
    expect(await runtime.transportFor({ id: accountId })).toBeInstanceOf(gmail.LiveGmailTransport);
    expect(await runtime.senderFor(account())).toBeDefined();

    configured = false; // revoked or half-edited in the admin page
    clock = 5000;
    expect(await runtime.transportFor({ id: accountId })).toBeUndefined();
    expect(await runtime.senderFor(account())).toBeUndefined();
    // Not the fake either, whatever the state of the store says from now on.
    configured = true;
    clock = 10_000;
    expect(await runtime.transportFor({ id: accountId })).toBeInstanceOf(gmail.LiveGmailTransport);
  });

  it('still starts on the mock when it is opted in and no credential has ever been seen', async () => {
    const runtime = createGmailRuntime({
      database,
      logger,
      allowMock: true,
      credentials: source(false).credentials,
    });
    expect(await runtime.transportFor({ id: accountId })).toBeInstanceOf(gmail.FakeGmailTransport);
  });

  it('includes the mailbox address in the transport key: a mismatch is re-evaluated when the address is fixed', async () => {
    const target = `target-${randomUUID().slice(0, 8)}@desk.example.test`;
    const [other] = await testDb.owner.db
      .insert(schema.channelAccount)
      .values({ type: 'gmail', name: 'Address changes' })
      .returning({ id: schema.channelAccount.id });
    const id = other?.id ?? '';
    await testDb.owner.db
      .insert(schema.gmailAccountState)
      .values({ channelAccountId: id, emailAddress: `wrong-${target}` });
    let clock = 0;
    const runtime = createGmailRuntime({
      database,
      logger,
      refreshMs: 1000,
      now: () => clock,
      credentials: source(true, target).credentials,
      fetch: () => Promise.reject(new Error('not used')),
    });
    expect(await runtime.transportFor({ id })).toBeUndefined(); // the credential delegates to `target`
    clock = 1500;
    expect(await runtime.transportFor({ id })).toBeUndefined();

    await testDb.owner.db
      .update(schema.gmailAccountState)
      .set({ emailAddress: target })
      .where(eq(schema.gmailAccountState.channelAccountId, id));
    clock = 3000;
    expect(await runtime.transportFor({ id })).toBeInstanceOf(gmail.LiveGmailTransport);
  });
});
