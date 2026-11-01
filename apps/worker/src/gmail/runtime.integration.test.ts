import { generateKeyPairSync, randomUUID } from 'node:crypto';

import { gmail } from '@watchtower/channels';
import { createDatabase, schema, type Database } from '@watchtower/db';
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
    const runtime = createGmailRuntime({ database, logger });
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
});
