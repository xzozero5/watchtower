import { createECDH } from 'node:crypto';

import { webpush } from '@watchtower/channels';
import { schema, type Database } from '@watchtower/db';
import type { WebPushStatus } from '@watchtower/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import { apiOrg, signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';
import { MAX_SUBSCRIPTIONS_PER_USER } from './web-push.service.js';

// Web Push subscriptions of the caller on the real application (T-105): only an allow-listed push
// service is accepted, the endpoint is never returned, one person cannot touch another's, and it is off
// until the VAPID credential is complete.

const keys = webpush.generateVapidKeys();
let on: Harness;
let off: Harness;
let agent: Persona;
let other: Persona;
let client: Persona;
let lead: Persona;
const owner = (): Database['db'] => on.db.owner.db;

function browser() {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  return {
    keys: {
      p256dh: webpush.b64urlEncode(ua.getPublicKey()),
      auth: webpush.b64urlEncode(Buffer.alloc(16, 5)),
    },
  };
}
const fcm = (id: string) => `https://fcm.googleapis.com/fcm/send/${id}`;

beforeAll(async () => {
  on = await startHarness({
    env: {
      WEB_PUSH_VAPID_PUBLIC: keys.publicKey,
      WEB_PUSH_VAPID_PRIVATE: keys.privateKey,
      WEB_PUSH_SUBJECT: 'mailto:ops@example.test',
    },
  });
  off = await startHarness();
  agent = await signIn(on, 'agent');
  other = await signIn(on, 'agent');
  lead = await signIn(on, 'lead');
  client = await signIn(on, 'client', (await apiOrg(lead, { name: 'Push Org' })).id);
});
afterAll(async () => {
  await on.close();
  await off.close();
});

describe('status', () => {
  it('offers the public key (never the private one) when the credential is complete', async () => {
    const response = await agent.client.get<WebPushStatus>('/v1/notifications/push');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ enabled: true, publicKey: keys.publicKey, subscribed: 0 });
    expect(JSON.stringify(response.body)).not.toContain(keys.privateKey);
  });

  it('is off, with no key, when nothing is configured', async () => {
    const someone = await signIn(off, 'agent');
    const response = await someone.client.get<WebPushStatus>('/v1/notifications/push');
    expect(response.body).toEqual({ enabled: false, publicKey: null, subscribed: 0 });
    const refused = await someone.client.post<ApiErrorBody>(
      '/v1/notifications/push/subscriptions',
      {
        endpoint: fcm('a'),
        ...browser(),
      },
    );
    expect(refused.status).toBe(409);
  });

  it('is off when the keys are not a pair', async () => {
    const mismatched = await startHarness({
      env: {
        WEB_PUSH_VAPID_PUBLIC: webpush.generateVapidKeys().publicKey,
        WEB_PUSH_VAPID_PRIVATE: keys.privateKey,
        WEB_PUSH_SUBJECT: 'mailto:ops@example.test',
      },
    });
    try {
      const someone = await signIn(mismatched, 'agent');
      const response = await someone.client.get<WebPushStatus>('/v1/notifications/push');
      expect(response.body.enabled).toBe(false);
    } finally {
      await mismatched.close();
    }
  });

  it('refuses a client user and an anonymous caller', async () => {
    expect((await client.client.get('/v1/notifications/push')).status).toBe(403);
    const anonymous = await on.client().get('/v1/notifications/push');
    expect(anonymous.status).toBe(401);
  });
});

describe('subscribing', () => {
  it('saves a subscription, counts it, and never returns the endpoint', async () => {
    const endpoint = fcm('save-1');
    const response = await agent.client.post<WebPushStatus>(
      '/v1/notifications/push/subscriptions',
      { endpoint, ...browser(), userAgent: 'test-browser' },
    );
    expect(response.status).toBe(200);
    expect(response.body.subscribed).toBe(1);
    expect(JSON.stringify(response.body)).not.toContain('save-1');
    // The same browser again is one subscription, not two.
    const again = await agent.client.post<WebPushStatus>('/v1/notifications/push/subscriptions', {
      endpoint,
      ...browser(),
    });
    expect(again.body.subscribed).toBe(1);
  });

  it.each([
    'http://fcm.googleapis.com/fcm/send/x',
    'https://169.254.169.254/latest/meta-data',
    'https://127.0.0.1/x',
    'https://localhost/x',
    'https://evil.example/push',
    'https://fcm.googleapis.com.evil.example/x',
    'https://user:pw@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
    'not a url',
  ])('refuses the endpoint %s with 400 and stores nothing', async (endpoint) => {
    const before = (await agent.client.get<WebPushStatus>('/v1/notifications/push')).body
      .subscribed;
    const response = await agent.client.post<ApiErrorBody>('/v1/notifications/push/subscriptions', {
      endpoint,
      ...browser(),
    });
    expect(response.status).toBe(400);
    expect((await agent.client.get<WebPushStatus>('/v1/notifications/push')).body.subscribed).toBe(
      before,
    );
  });

  it('refuses keys that are not a P-256 point', async () => {
    const response = await agent.client.post<ApiErrorBody>('/v1/notifications/push/subscriptions', {
      endpoint: fcm('bad-keys'),
      keys: { p256dh: 'A'.repeat(87), auth: webpush.b64urlEncode(Buffer.alloc(16)) },
    });
    expect(response.status).toBe(400);
  });

  it('moves a browser to whoever signs in on it next, and cannot be removed by someone else', async () => {
    const endpoint = fcm('shared-browser');
    await agent.client.post('/v1/notifications/push/subscriptions', { endpoint, ...browser() });
    await other.client.post('/v1/notifications/push/subscriptions', { endpoint, ...browser() });
    const rows = await owner()
      .select()
      .from(schema.webPushSubscription)
      .where(eq(schema.webPushSubscription.endpoint, endpoint));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(other.userId);
    // The first person asks to remove it: it is not theirs any more, nothing happens to it.
    await agent.client.delete('/v1/notifications/push/subscriptions', { body: { endpoint } });
    expect(
      await owner()
        .select()
        .from(schema.webPushSubscription)
        .where(eq(schema.webPushSubscription.endpoint, endpoint)),
    ).toHaveLength(1);
  });

  it('keeps at most 10 browsers per person, dropping the oldest', async () => {
    const heavy = await signIn(on, 'agent');
    for (let index = 0; index < MAX_SUBSCRIPTIONS_PER_USER + 2; index += 1) {
      const response = await heavy.client.post('/v1/notifications/push/subscriptions', {
        endpoint: fcm(`many-${index.toString()}`),
        ...browser(),
      });
      expect(response.status).toBe(200);
    }
    const status = await heavy.client.get<WebPushStatus>('/v1/notifications/push');
    expect(status.body.subscribed).toBe(MAX_SUBSCRIPTIONS_PER_USER);
  });
});

describe('unsubscribing', () => {
  it("removes the caller's own subscription, and a repeat is fine", async () => {
    const mine = await signIn(on, 'agent');
    const endpoint = fcm('remove-me');
    await mine.client.post('/v1/notifications/push/subscriptions', { endpoint, ...browser() });
    const removed = await mine.client.delete<WebPushStatus>(
      '/v1/notifications/push/subscriptions',
      {
        body: { endpoint },
      },
    );
    expect(removed.status).toBe(200);
    expect(removed.body.subscribed).toBe(0);
    const again = await mine.client.delete('/v1/notifications/push/subscriptions', {
      body: { endpoint },
    });
    expect(again.status).toBe(200);
  });
});
