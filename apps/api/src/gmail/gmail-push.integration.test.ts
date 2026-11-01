import { randomBytes } from 'node:crypto';

import { schema } from '@watchtower/db';
import {
  GMAIL_JOBS,
  GMAIL_QUEUES,
  gmailSyncJobSchema,
  type pubsubPushEnvelopeSchema,
} from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { eq } from 'drizzle-orm';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
} from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { startHarness, type Harness } from '../testing/harness.js';
import { captureLogs } from '../testing/support.js';
import { GMAIL_PUSH_VERIFIER } from './gmail-push.service.js';
import {
  PushAuthError,
  PushKeysUnavailableError,
  createOidcPushVerifier,
} from './push-verifier.js';

// The Pub/Sub push receiver on the real application module, Postgres and Redis from docker compose.
// The OIDC token is signed by a key pair made here and checked through a local key set: nothing is
// fetched from Google. disableNetConnect allows loopback only and the last test shows nothing tried.
const AUDIENCE = 'https://watchtower.example.com/v1/inbound/gmail/push';
const SERVICE_ACCOUNT = 'pubsub-push@project-id.iam.gserviceaccount.example.com';
const MAILBOX = 'support@example.com';
const PATH = '/v1/inbound/gmail/push';

const net = disableNetConnect();
const logs = captureLogs();
let harness: Harness;
let privateKey: CryptoKey;
let accountId = '';
let counter = 0;

type Envelope = z.input<typeof pubsubPushEnvelopeSchema>;

function envelope(historyId: string, messageId?: string, address = MAILBOX): Envelope {
  counter += 1;
  return {
    message: {
      data: Buffer.from(JSON.stringify({ emailAddress: address, historyId })).toString('base64'),
      messageId: messageId ?? String(1_000_000 + counter),
      publishTime: '2026-11-01T03:00:00Z',
    },
    subscription: 'projects/project-id/subscriptions/watchtower-gmail',
  };
}

async function token(claims: Record<string, unknown> = {}, audience = AUDIENCE): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: SERVICE_ACCOUNT, email_verified: true, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuer('https://accounts.google.com')
    .setAudience(audience)
    .setIssuedAt(now - 30)
    .setExpirationTime(now + 3000)
    .sign(privateKey);
}

const bearer = async (claims?: Record<string, unknown>) => ({
  authorization: `Bearer ${await token(claims)}`,
});

async function outboxRows() {
  return harness.db.owner.db
    .select()
    .from(schema.outbox)
    .where(eq(schema.outbox.queue, GMAIL_QUEUES.gmail));
}

async function stateRow() {
  const [row] = await harness.db.owner.db
    .select()
    .from(schema.gmailAccountState)
    .where(eq(schema.gmailAccountState.channelAccountId, accountId));
  if (!row) throw new Error('state row missing');
  return row;
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'test-key-1', alg: 'RS256' };
  harness = await startHarness({
    logs,
    env: { LOG_LEVEL: 'info' },
    overrides: [
      {
        token: GMAIL_PUSH_VERIFIER,
        value: createOidcPushVerifier({
          audience: AUDIENCE,
          serviceAccountEmail: SERVICE_ACCOUNT,
          keys: createLocalJWKSet({ keys: [jwk] }),
        }),
      },
    ],
  });
  const [account] = await harness.db.owner.db
    .insert(schema.channelAccount)
    .values({ type: 'gmail', name: 'Support mailbox', health: 'unhealthy' })
    .returning({ id: schema.channelAccount.id });
  accountId = account?.id ?? '';
  await harness.db.owner.db
    .insert(schema.gmailAccountState)
    .values({ channelAccountId: accountId, emailAddress: MAILBOX, historyId: '1000' });
});

afterAll(async () => {
  await harness.close();
  net.restore();
});

describe('POST /v1/inbound/gmail/push', () => {
  it('queues one sync job, records the push and marks the mailbox healthy', async () => {
    const client = harness.client();
    const response = await client.post(PATH, envelope('1234', '555000111'), {
      headers: await bearer(),
      origin: null,
      csrf: false,
    });
    expect(response.status).toBe(204);

    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      queue: GMAIL_QUEUES.gmail,
      jobName: GMAIL_JOBS.sync,
      jobId: `push-${accountId}-555000111`,
      status: 'pending',
    });
    expect(gmailSyncJobSchema.parse(rows[0]?.payload)).toEqual({
      channelAccountId: accountId,
      reason: 'push',
      pushHistoryId: '1234',
    });
    const state = await stateRow();
    expect(state.lastPushAt).toBeInstanceOf(Date);
    const [account] = await harness.db.owner.db
      .select({ health: schema.channelAccount.health })
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.id, accountId));
    expect(account?.health).toBe('healthy');
  });

  it('is idempotent: a redelivery of the same Pub/Sub message queues nothing new', async () => {
    const client = harness.client();
    const body = envelope('1300', '555000222');
    const headers = await bearer();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await client.post(PATH, body, { headers, origin: null, csrf: false });
      expect(response.status).toBe(204);
    }
    const rows = (await outboxRows()).filter((row) => row.jobId.endsWith('555000222'));
    expect(rows).toHaveLength(1);
  });

  it('answers 401 and writes nothing for a missing, malformed or rejected token', async () => {
    const before = (await outboxRows()).length;
    const lastPush = (await stateRow()).lastPushAt;
    const client = harness.client();
    const attempts: Record<string, string>[] = [
      {},
      { authorization: 'Bearer' },
      { authorization: 'Basic abcdefghijklmnopqrstuvwxyz' },
      { authorization: 'Bearer not.a.jwt-but-long-enough-to-pass-the-shape-check' },
      await bearer({ email: 'intruder@example.com' }),
      await bearer({ email_verified: false }),
      { authorization: `Bearer ${await token({}, 'https://other.example.com')}` },
    ];
    for (const headers of attempts) {
      const response = await client.post(PATH, envelope('1400'), {
        headers,
        origin: null,
        csrf: false,
      });
      expect(response.status).toBe(401);
    }
    expect((await outboxRows()).length).toBe(before);
    expect((await stateRow()).lastPushAt).toEqual(lastPush);
  });

  it('acknowledges but drops a message for an unknown or disabled mailbox', async () => {
    const before = (await outboxRows()).length;
    const client = harness.client();
    const unknown = await client.post(PATH, envelope('1500', undefined, 'nobody@example.com'), {
      headers: await bearer(),
      origin: null,
      csrf: false,
    });
    expect(unknown.status).toBe(204);

    await harness.db.owner.db
      .update(schema.gmailAccountState)
      .set({ enabled: false })
      .where(eq(schema.gmailAccountState.channelAccountId, accountId));
    const disabled = await client.post(PATH, envelope('1501'), {
      headers: await bearer(),
      origin: null,
      csrf: false,
    });
    expect(disabled.status).toBe(204);
    await harness.db.owner.db
      .update(schema.gmailAccountState)
      .set({ enabled: true })
      .where(eq(schema.gmailAccountState.channelAccountId, accountId));
    expect((await outboxRows()).length).toBe(before);
  });

  it('acknowledges but drops an authentic message it cannot read (no poison loop)', async () => {
    const before = (await outboxRows()).length;
    const client = harness.client();
    const headers = await bearer();
    const bodies: unknown[] = [
      {},
      { message: { data: '@@@', messageId: '77' } },
      { message: { data: Buffer.from('{"emailAddress":1}').toString('base64'), messageId: '78' } },
      {
        message: {
          data: Buffer.from(
            JSON.stringify({ emailAddress: MAILBOX, historyId: 'not-a-number' }),
          ).toString('base64'),
          messageId: '79',
        },
      },
    ];
    for (const body of bodies) {
      const response = await client.post(PATH, body, { headers, origin: null, csrf: false });
      expect(response.status).toBe(204);
    }
    expect((await outboxRows()).length).toBe(before);
  });

  it('never writes the token, the mailbox address or the body to the log', async () => {
    const client = harness.client();
    const secretToken = await token();
    await client.post(PATH, envelope('1600'), {
      headers: { authorization: `Bearer ${secretToken}` },
      origin: null,
      csrf: false,
    });
    await client.post(PATH, envelope('1601'), {
      headers: { authorization: `Bearer ${secretToken.slice(0, -4)}AAAA` },
      origin: null,
      csrf: false,
    });
    const raw = logs.raw();
    // Not vacuous: the rejection itself was logged.
    expect(raw).toContain('gmail push: token rejected');
    expect(raw).not.toContain(secretToken);
    expect(raw).not.toContain(secretToken.split('.')[1] ?? 'x');
    expect(raw).not.toContain(MAILBOX);
    expect(raw).not.toContain(SERVICE_ACCOUNT);
  });

  it('does not mark a mailbox healthy while the worker has an error recorded for it', async () => {
    const [account] = await harness.db.owner.db
      .insert(schema.channelAccount)
      .values({ type: 'gmail', name: 'Broken watch', health: 'unhealthy' })
      .returning({ id: schema.channelAccount.id });
    const id = account?.id ?? '';
    const address = 'broken@example.com';
    await harness.db.owner.db.insert(schema.gmailAccountState).values({
      channelAccountId: id,
      emailAddress: address,
      historyId: '1000',
      lastErrorCode: 'watch_failed',
    });
    const response = await harness.client().post(PATH, envelope('2000', undefined, address), {
      headers: await bearer(),
      origin: null,
      csrf: false,
    });
    expect(response.status).toBe(204);
    const [row] = await harness.db.owner.db
      .select({ health: schema.channelAccount.health })
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.id, id));
    expect(row?.health).toBe('unhealthy');
    const [state] = await harness.db.owner.db
      .select({ lastPushAt: schema.gmailAccountState.lastPushAt })
      .from(schema.gmailAccountState)
      .where(eq(schema.gmailAccountState.channelAccountId, id));
    expect(state?.lastPushAt).toBeInstanceOf(Date);
    // The sync is still queued: it is how the error gets cleared.
    const jobs = (await outboxRows()).filter((job) => job.jobId.startsWith(`push-${id}-`));
    expect(jobs).toHaveLength(1);
  });

  it('answers 503 (Pub/Sub retries), not 401, when Google keys cannot be fetched, and logs it apart from a rejected token', async () => {
    const down = await startHarness({
      logs,
      env: { LOG_LEVEL: 'info' },
      overrides: [
        {
          token: GMAIL_PUSH_VERIFIER,
          value: { verify: () => Promise.reject(new PushKeysUnavailableError()) },
        },
      ],
    });
    try {
      const response = await down.client().post(PATH, envelope('1'), {
        headers: await bearer(),
        origin: null,
        csrf: false,
      });
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ statusCode: 503, error: 'Service Unavailable' });
      expect(logs.raw()).toContain('verification keys unavailable');
    } finally {
      await down.close();
    }
  });

  it('made no outbound network connection', () => {
    expect(net.blocked()).toEqual([]);
  });
});

describe('POST /v1/inbound/gmail/push without push authentication configured', () => {
  it('answers 503 and queues nothing, even with a token', async () => {
    const bare = await startHarness({});
    try {
      const response = await bare.client().post(PATH, envelope('1'), {
        headers: await bearer(),
        origin: null,
        csrf: false,
      });
      expect(response.status).toBe(503);
      // An unauthenticated caller learns nothing about the configuration.
      expect(response.body).toEqual({ statusCode: 503, error: 'Service Unavailable' });
    } finally {
      await bare.close();
    }
  });
});

describe('POST /v1/inbound/gmail/push rate limit', () => {
  it('answers 429 with Retry-After beyond the per-IP limit, before looking at the token', async () => {
    const limited = await startHarness({
      env: {
        GMAIL_PUSH_RATE_PER_MINUTE: '3',
        RATE_LIMIT_NAMESPACE: `rl-${randomBytes(3).toString('hex')}`,
      },
      overrides: [
        {
          token: GMAIL_PUSH_VERIFIER,
          value: {
            verify: () => Promise.reject(new PushAuthError()),
          },
        },
      ],
    });
    try {
      const client = limited.client();
      const statuses: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        const response = await client.post(PATH, envelope('1'), {
          headers: { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz012345' },
          origin: null,
          csrf: false,
        });
        statuses.push(response.status);
        if (response.status === 429) {
          expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
        }
      }
      expect(statuses).toEqual([401, 401, 401, 429, 429]);
    } finally {
      await limited.close();
    }
  });
});
