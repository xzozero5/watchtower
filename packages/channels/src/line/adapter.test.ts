import { randomBytes, randomUUID } from 'node:crypto';

import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { channelCapabilitiesSchema } from '../common/adapter.js';
import { LINE_CAPABILITIES, LineAdapter, LineSignatureError } from './adapter.js';
import { LineWebhookParseError } from './events.js';
import { FakeLineTransport } from './fake.js';
import { computeLineSignature } from './signature.js';

const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

const channelSecret = randomBytes(16).toString('hex');

function setup() {
  const transport = new FakeLineTransport();
  const adapter = new LineAdapter({
    transport,
    getChannelSecret: () => Promise.resolve(channelSecret),
  });
  return { transport, adapter };
}

const webhook = JSON.stringify({
  destination: 'Udestination',
  events: [
    {
      type: 'message',
      webhookEventId: '01HZZZZZZZZZZZZZZZZZZZZZZ1',
      timestamp: Date.UTC(2025, 9, 14, 2),
      mode: 'active',
      deliveryContext: { isRedelivery: false },
      source: { type: 'user', userId: 'Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      replyToken: 'reply-token-1',
      message: { type: 'text', id: '1', text: 'ระบบเข้าไม่ได้' },
    },
  ],
});

describe('LineAdapter', () => {
  it('declares capabilities that validate against the shared schema', () => {
    const { adapter } = setup();
    expect(channelCapabilitiesSchema.parse(adapter.capabilities())).toEqual(LINE_CAPABILITIES);
    expect(adapter.capabilities()).toMatchObject({
      channel: 'line',
      replyToken: true,
      markRead: true,
      maxTextLength: 5000,
    });
  });

  it('verifies the signature, then normalises the events', async () => {
    const { adapter } = setup();
    const events = await adapter.ingest({
      rawBody: webhook,
      signature: computeLineSignature(webhook, channelSecret),
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'message',
      providerEventId: '01HZZZZZZZZZZZZZZZZZZZZZZ1',
      content: { type: 'text', text: 'ระบบเข้าไม่ได้' },
      replyToken: 'reply-token-1',
    });
  });

  it('refuses a missing or wrong signature before parsing anything', async () => {
    const { adapter } = setup();
    await expect(adapter.ingest({ rawBody: webhook, signature: null })).rejects.toBeInstanceOf(
      LineSignatureError,
    );
    const wrong = computeLineSignature(webhook, randomBytes(16).toString('hex'));
    await expect(adapter.ingest({ rawBody: webhook, signature: wrong })).rejects.toBeInstanceOf(
      LineSignatureError,
    );
    // Signed garbage is a parse error, not a signature error.
    const garbage = 'not json';
    await expect(
      adapter.ingest({ rawBody: garbage, signature: computeLineSignature(garbage, channelSecret) }),
    ).rejects.toBeInstanceOf(LineWebhookParseError);
  });

  it('reads the channel secret on every call, so rotation takes effect without a restart', async () => {
    const transport = new FakeLineTransport();
    let secret = channelSecret;
    const adapter = new LineAdapter({ transport, getChannelSecret: () => Promise.resolve(secret) });
    const signature = computeLineSignature(webhook, channelSecret);
    await expect(adapter.ingest({ rawBody: webhook, signature })).resolves.toHaveLength(1);
    secret = randomBytes(16).toString('hex');
    await expect(adapter.ingest({ rawBody: webhook, signature })).rejects.toBeInstanceOf(
      LineSignatureError,
    );
  });

  it('sends a reply with a token and a push with a retry key', async () => {
    const { adapter, transport } = setup();
    const token = transport.issueReplyToken();
    const reply = await adapter.send({
      route: 'reply',
      replyToken: token,
      texts: ['รับเรื่องแล้ว #OPS-1'],
    });
    expect(reply.alreadyAccepted).toBe(false);
    const retryKey = randomUUID();
    await adapter.send({ route: 'push', to: 'U1', texts: ['a', 'b'], retryKey });
    await adapter.send({ route: 'push', to: 'U1', texts: ['a', 'b'], retryKey });
    expect(transport.replies[0]?.texts).toEqual(['รับเรื่องแล้ว #OPS-1']);
    expect(transport.pushes).toHaveLength(1);
    expect(transport.pushes[0]?.texts).toEqual(['a', 'b']);
  });

  it('marks as read with the token from the message event', async () => {
    const { adapter, transport } = setup();
    const readToken = transport.issueMarkAsReadToken();
    await adapter.markRead({ markAsReadToken: readToken });
    expect(transport.readMarks).toEqual([readToken]);
  });
});
