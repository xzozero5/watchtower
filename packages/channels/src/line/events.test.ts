import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { LineWebhookParseError, normalizeLineEvent, parseLineWebhook } from './events.js';

const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

const USER = 'Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const GROUP = 'Cbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const T0 = Date.UTC(2025, 9, 14, 2, 0, 0);

function event(extra: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    webhookEventId: '01HZZZZZZZZZZZZZZZZZZZZZZ1',
    deliveryContext: { isRedelivery: false },
    timestamp: T0,
    mode: 'active',
    source: { type: 'user', userId: USER },
    replyToken: 'reply-token-1',
    ...extra,
    ...overrides,
  };
}

const textMessage = (text = 'สวัสดีครับ') =>
  event({
    type: 'message',
    message: { type: 'text', id: '100001', quoteToken: 'q1', markAsReadToken: 'm1', text },
  });

function body(...events: unknown[]): string {
  return JSON.stringify({ destination: 'Udestination', events });
}

describe('parseLineWebhook: message events', () => {
  it('normalises a text message with all tokens', () => {
    const { events, destination, rejected } = parseLineWebhook(body(textMessage()));
    expect(destination).toBe('Udestination');
    expect(rejected).toEqual([]);
    expect(events).toEqual([
      {
        kind: 'message',
        providerEventId: '01HZZZZZZZZZZZZZZZZZZZZZZ1',
        occurredAt: '2025-10-14T02:00:00.000Z',
        isRedelivery: false,
        mode: 'active',
        source: { kind: 'user', userId: USER, groupId: null, roomId: null, conversationId: USER },
        replyToken: 'reply-token-1',
        messageId: '100001',
        quoteToken: 'q1',
        markAsReadToken: 'm1',
        content: { type: 'text', text: 'สวัสดีครับ' },
      },
    ]);
  });

  it('normalises an image sent by a user and one hosted elsewhere', () => {
    const { events } = parseLineWebhook(
      body(
        event({
          type: 'message',
          message: {
            type: 'image',
            id: '1',
            contentProvider: { type: 'line' },
            imageSet: { id: 'set1', index: 1, total: 2 },
          },
        }),
        event(
          {
            type: 'message',
            message: {
              type: 'image',
              id: '2',
              contentProvider: {
                type: 'external',
                originalContentUrl: 'https://cdn.example.com/a.png',
                previewImageUrl: 'https://cdn.example.com/p.png',
              },
            },
          },
          { webhookEventId: '01HZZZZZZZZZZZZZZZZZZZZZZ2' },
        ),
      ),
    );
    expect(events[0]).toMatchObject({
      content: { type: 'image', provider: 'line', imageSetId: 'set1' },
    });
    expect(events[1]).toMatchObject({
      content: { type: 'image', provider: 'external', imageSetId: null },
    });
    // The external URL is never surfaced: nothing may fetch it without an egress guard.
    expect(JSON.stringify(events)).not.toContain('cdn.example.com');
  });

  it('normalises video, audio, file, location and sticker', () => {
    const cases: [Record<string, unknown>, unknown][] = [
      [
        { type: 'video', id: '1', duration: 6000, contentProvider: { type: 'line' } },
        { type: 'video', provider: 'line', durationMs: 6000 },
      ],
      [
        { type: 'audio', id: '2', duration: 60000, contentProvider: { type: 'line' } },
        { type: 'audio', provider: 'line', durationMs: 60000 },
      ],
      [
        { type: 'file', id: '3', fileName: 'log.txt', fileSize: 2138 },
        { type: 'file', fileName: 'log.txt', fileSize: 2138 },
      ],
      [
        {
          type: 'location',
          id: '4',
          title: 'Office',
          address: '1 Example Road',
          latitude: 13.75,
          longitude: 100.5,
        },
        {
          type: 'location',
          title: 'Office',
          address: '1 Example Road',
          latitude: 13.75,
          longitude: 100.5,
        },
      ],
      [
        { type: 'location', id: '5', latitude: 1, longitude: 2 },
        { type: 'location', title: null, address: null, latitude: 1, longitude: 2 },
      ],
      [
        {
          type: 'sticker',
          id: '6',
          packageId: '446',
          stickerId: '1988',
          stickerResourceType: 'STATIC',
          keywords: ['Hi'],
        },
        {
          type: 'sticker',
          packageId: '446',
          stickerId: '1988',
          resourceType: 'STATIC',
          keywords: ['Hi'],
        },
      ],
    ];
    for (const [message, content] of cases) {
      const { events, rejected } = parseLineWebhook(body(event({ type: 'message', message })));
      expect(rejected).toEqual([]);
      expect(events[0]).toMatchObject({ kind: 'message', content });
    }
  });

  it('keeps a message type this version does not know, as unsupported', () => {
    const { events } = parseLineWebhook(
      body(
        event({ type: 'message', message: { type: 'hologram', id: '77', markAsReadToken: 'm' } }),
      ),
    );
    expect(events[0]).toMatchObject({
      kind: 'message',
      messageId: '77',
      markAsReadToken: 'm',
      content: { type: 'unsupported', messageType: 'hologram' },
    });
  });

  it('ignores unknown fields (the platform adds them)', () => {
    const { events } = parseLineWebhook(
      body(
        event({
          type: 'message',
          message: { type: 'text', id: '1', text: 'hi', futureField: { a: 1 } },
          futureTop: true,
        }),
      ),
    );
    expect(events).toHaveLength(1);
  });
});

describe('parseLineWebhook: sources', () => {
  it('maps group and room sources, with or without a consenting user', () => {
    const { events } = parseLineWebhook(
      body(
        event({
          type: 'message',
          message: { type: 'text', id: '1', text: 'a' },
          source: { type: 'group', groupId: GROUP, userId: USER },
        }),
        event(
          {
            type: 'message',
            message: { type: 'text', id: '2', text: 'b' },
            source: { type: 'room', roomId: 'Rccc' },
          },
          { webhookEventId: 'E2' },
        ),
      ),
    );
    expect(events[0]?.source).toEqual({
      kind: 'group',
      userId: USER,
      groupId: GROUP,
      roomId: null,
      conversationId: GROUP,
    });
    expect(events[1]?.source).toEqual({
      kind: 'room',
      userId: null,
      groupId: null,
      roomId: 'Rccc',
      conversationId: 'Rccc',
    });
  });
});

describe('parseLineWebhook: follow, unfollow and others', () => {
  it('normalises follow (with unblock flag) and unfollow', () => {
    const { events } = parseLineWebhook(
      body(
        event({ type: 'follow', follow: { isUnblocked: true } }),
        event({ type: 'unfollow', replyToken: undefined }, { webhookEventId: 'E2' }),
        event({ type: 'follow' }, { webhookEventId: 'E3' }),
      ),
    );
    expect(events[0]).toMatchObject({
      kind: 'follow',
      isUnblocked: true,
      replyToken: 'reply-token-1',
    });
    expect(events[1]).toMatchObject({ kind: 'unfollow', replyToken: null });
    expect(events[2]).toMatchObject({ kind: 'follow', isUnblocked: false });
  });

  it('records events it does not act on, so redelivery stays deduplicated', () => {
    const { events } = parseLineWebhook(body(event({ type: 'postback', postback: { data: 'x' } })));
    expect(events[0]).toMatchObject({ kind: 'unsupported', eventType: 'postback' });
  });
});

describe('parseLineWebhook: dedupe, redelivery and mode', () => {
  it('exposes webhookEventId as the dedupe key and the redelivery flag', () => {
    const original = parseLineWebhook(body(textMessage())).events[0];
    const redelivered = parseLineWebhook(
      body(event({ type: 'message', message: { type: 'text', id: '100001', text: 'สวัสดีครับ' } })),
    ).events[0];
    const flagged = parseLineWebhook(
      body({
        ...(textMessage() as object),
        deliveryContext: { isRedelivery: true },
        timestamp: T0,
      }),
    ).events[0];
    expect(original?.providerEventId).toBe(flagged?.providerEventId);
    expect(original?.isRedelivery).toBe(false);
    expect(flagged?.isRedelivery).toBe(true);
    // occurredAt is the event time even for a redelivery (LINE: "not the time it was redelivered").
    expect(flagged?.occurredAt).toBe(original?.occurredAt);
    expect(redelivered?.providerEventId).toBe(original?.providerEventId);
  });

  it('defaults a missing deliveryContext to not redelivered', () => {
    const raw = { ...(textMessage() as Record<string, unknown>) };
    delete raw['deliveryContext'];
    expect(parseLineWebhook(body(raw)).events[0]?.isRedelivery).toBe(false);
  });

  it('standby mode drops the reply token and is flagged so nothing is sent', () => {
    const { events } = parseLineWebhook(
      body(textMessage()).replace('"mode":"active"', '"mode":"standby"'),
    );
    expect(events[0]).toMatchObject({ mode: 'standby', replyToken: null });
  });

  it('treats an unknown mode as standby (do not send)', () => {
    const { events } = parseLineWebhook(body(event({ type: 'unfollow' }, { mode: 'paused' })));
    expect(events[0]).toMatchObject({ mode: 'standby', replyToken: null });
  });
});

describe('parseLineWebhook: bad input', () => {
  it('accepts the empty events array sent by the console verify button', () => {
    expect(parseLineWebhook('{"destination":"U1","events":[]}')).toEqual({
      destination: 'U1',
      events: [],
      rejected: [],
    });
  });

  it('rejects an event without webhookEventId or with a broken shape, by index, without content', () => {
    const noId = { ...(textMessage() as Record<string, unknown>) };
    delete noId['webhookEventId'];
    const badMessage = event(
      { type: 'message', message: { type: 'text', id: '1' } },
      { webhookEventId: 'E9' },
    );
    const { events, rejected } = parseLineWebhook(body(noId, textMessage(), badMessage));
    expect(events).toHaveLength(1);
    expect(rejected).toEqual([
      { index: 0, reason: 'missing_event_id' },
      { index: 2, reason: 'invalid_event' },
    ]);
    expect(JSON.stringify(rejected)).not.toContain('สวัสดี');
  });

  it('throws for non-JSON, a non-object, or a body without an events array', () => {
    for (const bad of ['', 'not json', '[]', '"x"', '{"events":"nope"}', '{"destination":"U1"}']) {
      expect(() => parseLineWebhook(bad)).toThrow(LineWebhookParseError);
    }
  });

  it('accepts bytes as well as a string', () => {
    expect(parseLineWebhook(Uint8Array.from(Buffer.from(body(textMessage())))).events).toHaveLength(
      1,
    );
  });

  it('normalizeLineEvent reports a non-object as missing_event_id', () => {
    expect(normalizeLineEvent(null)).toBe('missing_event_id');
    expect(normalizeLineEvent('x')).toBe('missing_event_id');
  });
});
