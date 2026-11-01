import { randomBytes, randomUUID } from 'node:crypto';

import { ChannelError, gmail } from '@watchtower/channels';
import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { createDomain, createPolicyGate, type Domain } from '@watchtower/domain';
import { AUDIT_ACTIONS, GMAIL_NOT_CONNECTED_CODE } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import { createMarkNotConnected } from './not-connected.js';
import {
  createGmailRuntime,
  type GmailCredentialSource,
  type GmailCredentials,
} from './runtime.js';
import { createGmailSync } from './sync.js';
import { createGmailWatch } from './watch.js';

// OAuth of the support mailbox on the worker side (T-102e): refresh, `invalid_grant`, and what it
// does to health, audit and the transport. Google is a scripted `fetch`; disableNetConnect proves
// that nothing left the machine. Markers let the tests search for leaks.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const net = disableNetConnect();

const CLIENT = {
  clientId: 'client-id-marker.example.test',
  clientSecret: 'CLIENT-SECRET-MARKER-31a',
};
const REFRESH = 'REFRESH-TOKEN-MARKER-c07e';
const REFRESH_NEW = 'REFRESH-TOKEN-MARKER-new-5b19';
const ACCESS = 'ACCESS-TOKEN-MARKER-8d42';
const MARKERS = [CLIENT.clientSecret, REFRESH, REFRESH_NEW, ACCESS];
const T0 = Date.UTC(2030, 0, 7, 3, 0, 0);
const TOPIC = 'projects/example-project/topics/example-topic';

const logLines: string[] = [];
const logger = createLogger(testConfig({ LOG_LEVEL: 'trace' }), {
  write: (chunk: string) => {
    logLines.push(chunk);
  },
});

let testDb: TestDatabase;
let database: Database;
let domain: Domain;
const clock = { now: T0 };

const owner = () => testDb.owner.db;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  database = createDatabase({ url: testDb.appUrl, max: 5, applicationName: 'wt-gmail-oauth-test' });
  domain = createDomain({
    ticketKeyPrefix: 'OPS',
    sealKey: randomBytes(32),
    portalUrl: 'https://desk.example.test/portal',
    policyGate: createPolicyGate({ db: database.db }),
    now: () => new Date(clock.now),
  });
});

afterAll(async () => {
  await database.close();
  await testDb.cleanup();
  expect(net.blocked()).toEqual([]);
  net.restore();
  const everything = logLines.join('');
  for (const marker of MARKERS) expect(everything, marker).not.toContain(marker);
});

/** A fresh mailbox, so one case's health and audit do not leak into the next. */
async function mailbox() {
  const address = `${randomUUID().slice(0, 8)}@desk.example.test`;
  const [account] = await owner()
    .insert(schema.channelAccount)
    .values({ type: 'gmail', name: address })
    .returning({ id: schema.channelAccount.id });
  const id = account?.id ?? '';
  await owner()
    .insert(schema.gmailAccountState)
    .values({ channelAccountId: id, emailAddress: address });
  return { id, address };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Request {
  readonly url: string;
  readonly form: URLSearchParams;
  readonly authorization: string | null;
}

/** Google, scripted: the token endpoint answers from `token()`, every Gmail call from `api()`. */
function google() {
  const requests: Request[] = [];
  const script = {
    token: (): Response => json({ access_token: ACCESS, expires_in: 3600, token_type: 'Bearer' }),
    api: (): Response => json({}),
  };
  const fetch = (url: string, init?: RequestInit): Promise<Response> => {
    requests.push({
      url,
      form: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    return Promise.resolve(url === gmail.GOOGLE_OAUTH_TOKEN_URL ? script.token() : script.api());
  };
  return { requests, script, fetch };
}

function source(credentials: () => GmailCredentials) {
  const result: GmailCredentialSource = {
    configured: () => Promise.resolve(true),
    read: () => Promise.resolve(credentials()),
  };
  return result;
}

const oauth = (mail: string, refreshToken = REFRESH): GmailCredentials => ({
  method: 'oauth',
  ...CLIENT,
  refreshToken,
  mailbox: mail,
});

function runtimeFor(
  credentials: () => GmailCredentials,
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
  refreshMs?: number,
) {
  return createGmailRuntime({
    database,
    logger,
    allowMock: true,
    credentials: source(credentials),
    fetch,
    now: () => clock.now,
    onNotConnected: createMarkNotConnected({
      database,
      domain,
      logger,
      now: () => new Date(clock.now),
    }),
    ...(refreshMs === undefined ? {} : { refreshMs }),
  });
}

async function healthOf(id: string) {
  const [account] = await owner()
    .select({ health: schema.channelAccount.health })
    .from(schema.channelAccount)
    .where(eq(schema.channelAccount.id, id));
  const [state] = await owner()
    .select({ code: schema.gmailAccountState.lastErrorCode })
    .from(schema.gmailAccountState)
    .where(eq(schema.gmailAccountState.channelAccountId, id));
  return { health: account?.health, code: state?.code };
}

async function auditCount(action: string, id: string): Promise<number> {
  const rows = await owner()
    .select({ target: schema.auditLog.targetId })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, action));
  return rows.filter((row) => row.target === id).length;
}

describe('OAuth transport', () => {
  it('is live, mints an access token from the refresh token only when used, caches it, and mints again after it expires', async () => {
    const { id, address } = await mailbox();
    const g = google();
    clock.now = T0;
    const runtime = runtimeFor(() => oauth(address), g.fetch);
    expect(await runtime.mode()).toBe('live');
    const transport = await runtime.transportFor({ id });
    expect(transport).toBeInstanceOf(gmail.LiveGmailTransport);
    expect(g.requests).toEqual([]); // building it called nobody

    await transport?.listMessages({ maxResults: 1 });
    await transport?.listMessages({ maxResults: 1 });
    const tokenCalls = g.requests.filter((request) => request.url === gmail.GOOGLE_OAUTH_TOKEN_URL);
    expect(tokenCalls).toHaveLength(1);
    expect(Object.fromEntries(tokenCalls[0]?.form ?? [])).toEqual({
      grant_type: 'refresh_token',
      refresh_token: REFRESH,
      client_id: CLIENT.clientId,
      client_secret: CLIENT.clientSecret,
    });
    const apiCalls = g.requests.filter((request) => request.url !== gmail.GOOGLE_OAUTH_TOKEN_URL);
    expect(apiCalls).toHaveLength(2);
    for (const call of apiCalls) {
      expect(call.authorization).toBe(`Bearer ${ACCESS}`);
      expect(new URL(call.url).host).toBe('gmail.googleapis.com');
    }

    // Past the lifetime the next call refreshes again.
    clock.now = T0 + 2 * 3600_000;
    await transport?.listMessages({ maxResults: 1 });
    expect(
      g.requests.filter((request) => request.url === gmail.GOOGLE_OAUTH_TOKEN_URL),
    ).toHaveLength(2);

    // Only the mailbox that was granted gets a transport or a sender.
    const other = await mailbox();
    expect(await runtime.transportFor({ id: other.id })).toBeUndefined();
    expect(await runtime.senderFor({ id: other.id, type: 'gmail', name: 'x' })).toBeUndefined();
    expect((await runtime.senderFor({ id, type: 'gmail', name: 'x' }))?.from.address).toBe(address);
    // Healthy: nothing was marked.
    expect((await healthOf(id)).code).toBeNull();
  });

  it('picks up a replaced refresh token on the next refresh of the credential', async () => {
    const { id, address } = await mailbox();
    const g = google();
    let token = REFRESH;
    clock.now = T0;
    const runtime = runtimeFor(() => oauth(address, token), g.fetch, 1000);
    const first = await runtime.transportFor({ id });
    await first?.listMessages({ maxResults: 1 });
    token = REFRESH_NEW;
    clock.now = T0 + 5000; // the transport and the cached access token are looked at again
    const second = await runtime.transportFor({ id });
    expect(second).not.toBe(first);
    clock.now = T0 + 2 * 3600_000;
    await second?.listMessages({ maxResults: 1 });
    const used = g.requests
      .filter((request) => request.url === gmail.GOOGLE_OAUTH_TOKEN_URL)
      .map((request) => request.form.get('refresh_token'));
    expect(used).toEqual([REFRESH, REFRESH_NEW]);
  });
});

describe('invalid_grant', () => {
  it('fails as oauth2.token / auth / invalid_grant, marks the mailbox not connected ONCE, never becomes the mock, and the sync fails visibly', async () => {
    const { id, address } = await mailbox();
    const g = google();
    g.script.token = () =>
      json({ error: 'invalid_grant', error_description: `leak ${REFRESH}` }, 400);
    clock.now = T0;
    const runtime = runtimeFor(() => oauth(address), g.fetch);
    const sync = createGmailSync({
      database,
      domain,
      runtime,
      logger,
      now: () => new Date(clock.now),
      settings: { fullSyncDays: 7, fullSyncMaxMessages: 10, topicName: undefined },
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const error = await sync.syncAccount(id, 'push').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ChannelError);
      const failure = error as ChannelError;
      expect(failure.operation).toBe('oauth2.token');
      expect(failure.kind).toBe('auth');
      expect(failure.code).toBe('invalid_grant');
      expect(failure.outcomeUnknown).toBe(false);
      expect(failure.message).not.toContain(REFRESH);
    }

    // Visible: unhealthy, a code, and ONE audit entry for the outage (not one per retry).
    expect(await healthOf(id)).toEqual({ health: 'unhealthy', code: GMAIL_NOT_CONNECTED_CODE });
    expect(await auditCount(AUDIT_ACTIONS.gmailNotConnected, id)).toBe(1);
    const [entry] = await owner()
      .select({ outcome: schema.auditLog.outcome, metadata: schema.auditLog.metadata })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, AUDIT_ACTIONS.gmailNotConnected));
    expect(entry).toEqual({ outcome: 'failure', metadata: { code: 'invalid_grant' } });

    // Not the mock: still the live transport, and a send fails the same way (a certain non-delivery).
    expect(await runtime.transportFor({ id })).toBeInstanceOf(gmail.LiveGmailTransport);
    expect(await runtime.transportFor({ id })).not.toBeInstanceOf(gmail.FakeGmailTransport);
    const sender = await runtime.senderFor({ id, type: 'gmail', name: 'x' });
    expect(sender).toBeDefined();
    const sendError = await sender
      ?.send({
        from: { address },
        inReplyTo: { messageId: null, references: [], subject: 'Hello', from: null, replyTo: [] },
        to: [{ address: 'customer@example.org', name: null }],
        textBody: 'hi',
        messageId: `${randomUUID()}@desk.example.test`,
        ticketKey: 'OPS-1',
        subjectMode: 'reuse',
        automatic: false,
      })
      .catch((caught: unknown) => caught);
    expect(sendError).toBeInstanceOf(ChannelError);
    expect((sendError as ChannelError).operation).toBe('oauth2.token');
    expect((sendError as ChannelError).outcomeUnknown).toBe(false);
    // Nothing was ever sent to the Gmail API.
    expect(g.requests.every((request) => request.url === gmail.GOOGLE_OAUTH_TOKEN_URL)).toBe(true);
  });

  it('does not add a "watch failed" entry on top of "not connected"', async () => {
    const { id, address } = await mailbox();
    const g = google();
    g.script.token = () => json({ error: 'invalid_grant' }, 400);
    clock.now = T0;
    const runtime = runtimeFor(() => oauth(address), g.fetch);
    const watch = createGmailWatch({
      database,
      domain,
      runtime,
      topicName: TOPIC,
      logger,
      now: () => new Date(clock.now),
    });
    await expect(watch.renewAccount(id)).rejects.toMatchObject({ code: 'invalid_grant' });
    expect(await healthOf(id)).toEqual({ health: 'unhealthy', code: GMAIL_NOT_CONNECTED_CODE });
    expect(await auditCount(AUDIT_ACTIONS.gmailNotConnected, id)).toBe(1);
    expect(await auditCount(AUDIT_ACTIONS.gmailWatchFailed, id)).toBe(0);
  });

  it('recovers once a head connects again: the new refresh token is used and the next sync clears the code', async () => {
    const { id, address } = await mailbox();
    const g = google();
    let token = REFRESH;
    g.script.token = () => {
      // Google refuses the old token and accepts the new one.
      const body = g.requests.at(-1)?.form.get('refresh_token');
      return body === REFRESH
        ? json({ error: 'invalid_grant' }, 400)
        : json({ access_token: ACCESS, expires_in: 3600 });
    };
    clock.now = T0;
    const runtime = runtimeFor(() => oauth(address, token), g.fetch, 1000);
    const sync = createGmailSync({
      database,
      domain,
      runtime,
      logger,
      now: () => new Date(clock.now),
      settings: { fullSyncDays: 7, fullSyncMaxMessages: 10, topicName: undefined },
    });
    await expect(sync.syncAccount(id, 'push')).rejects.toMatchObject({ code: 'invalid_grant' });
    expect((await healthOf(id)).code).toBe(GMAIL_NOT_CONNECTED_CODE);

    token = REFRESH_NEW;
    clock.now = T0 + 5000;
    const result = await sync.syncAccount(id, 'manual');
    expect(result.status).toBe('synced');
    expect((await healthOf(id)).code).toBeNull();
  });

  it('is idempotent and ignores a mailbox that has no state row', async () => {
    const mark = createMarkNotConnected({ database, domain, logger });
    await expect(mark(randomUUID())).resolves.toBeUndefined();
  });
});

describe('other token failures are not "not connected"', () => {
  it.each([
    ['a 503', () => json({}, 503), 'server'],
    ['invalid_client', () => json({ error: 'invalid_client' }, 401), 'auth'],
  ])('%s does not mark the mailbox', async (_name, token, kind) => {
    const { id, address } = await mailbox();
    const g = google();
    g.script.token = token;
    clock.now = T0;
    const runtime = runtimeFor(() => oauth(address), g.fetch);
    const transport = await runtime.transportFor({ id });
    const error = await transport
      ?.listMessages({ maxResults: 1 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChannelError);
    expect((error as ChannelError).operation).toBe('oauth2.token');
    expect((error as ChannelError).kind).toBe(kind);
    expect(await healthOf(id)).toEqual({ health: 'unknown', code: null });
  });
});
