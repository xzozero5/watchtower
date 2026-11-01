import { gmail } from '@watchtower/channels';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import {
  PermanentIngestError,
  createGmailIngestor,
  createLineIngestor,
  type IngestAccount,
  type IngestSource,
} from './channels.js';

const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

const account: IngestAccount = { id: '00000000-0000-4000-8000-000000000001', type: 'gmail' };
const receivedAt = new Date('2026-11-02T03:00:00Z');

const source = (providerEventId: string, payload: Record<string, unknown>): IngestSource => ({
  providerEventId,
  payload,
  receivedAt,
});

function gmailPayload(
  options: Partial<Parameters<typeof gmail.buildFakeMime>[0]> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const mime = gmail.buildFakeMime({
    from: 'somchai@customer.example.test',
    fromName: 'สมชาย',
    subject: 'ระบบรายงานเปิดไม่ได้',
    body: 'สวัสดีครับ เปิดไม่ได้ตั้งแต่เช้า',
    messageId: 'Mail-1@Customer.example.test',
    ...options,
  });
  return {
    id: 'g-100',
    threadId: 'thread-100',
    labelIds: ['INBOX', 'UNREAD'],
    raw: mime.rawBase64Url,
    ...extra,
  };
}

describe('Gmail ingestor', () => {
  const ingestor = createGmailIngestor({ ticketKeyPrefix: 'OPS', allowEmbedded: true });

  it('normalises an embedded mail: Thai text, thread keys, stable ids, the raw bytes', async () => {
    const [item, ...rest] = await ingestor.ingest(
      account,
      source(
        'evt-1',
        gmailPayload({ inReplyTo: 'Parent@x.example.test', subject: 'Re: [OPS-12] ปัญหา' }),
      ),
    );
    expect(rest).toEqual([]);
    expect(item?.message).toMatchObject({
      channelAccountId: account.id,
      providerMessageId: 'g-100',
      rfc822MessageId: 'mail-1@customer.example.test',
      threadKey: 'gmail:thread-100',
      from: { address: 'somchai@customer.example.test', name: 'สมชาย', lineUserId: null },
      subject: 'Re: [OPS-12] ปัญหา',
      bodyText: 'สวัสดีครับ เปิดไม่ได้ตั้งแต่เช้า',
      receivedAt: new Date(receivedAt),
      automated: { disposition: 'human' },
    });
    expect(item?.message.threadCandidates).toEqual([
      { kind: 'gmail_thread_id', value: 'thread-100' },
      { kind: 'in_reply_to', value: 'parent@x.example.test' },
      { kind: 'subject_token', value: 'OPS-12' },
    ]);
    expect(item?.raw.contentType).toBe('message/rfc822');
    expect(Buffer.from(item?.raw.body ?? []).toString('utf8')).toContain(
      'Message-ID: <Mail-1@Customer.example.test>',
    );
  });

  it('takes the provider message id from the event when the payload has none', async () => {
    const payload = gmailPayload();
    delete payload.id;
    const [item] = await ingestor.ingest(account, source('evt-from-event', payload));
    expect(item?.message.providerMessageId).toBe('evt-from-event');
  });

  it('carries the header rules verdict', async () => {
    const [bounce] = await ingestor.ingest(
      account,
      source('e', gmailPayload({ headers: { 'Auto-Submitted': 'auto-replied' } })),
    );
    expect(bounce?.message.automated).toMatchObject({
      disposition: 'auto_reply',
      subtype: 'out_of_office',
    });
    const [news] = await ingestor.ingest(
      account,
      source('e', gmailPayload({ headers: { 'List-Unsubscribe': '<mailto:x@y.example.test>' } })),
    );
    expect(news?.message.automated).toMatchObject({
      disposition: 'noise',
      subtype: 'mailing_list',
    });
  });

  it('skips mail we sent ourselves', async () => {
    expect(
      await ingestor.ingest(account, source('e', gmailPayload({}, { labelIds: ['SENT'] }))),
    ).toEqual([]);
  });

  it('fetches by message id through the account transport', async () => {
    const transport = new gmail.FakeGmailTransport();
    const stored = transport.deliver(
      gmail.buildFakeMime({ from: 'a@customer.example.test', subject: 'Fetched', body: 'x' }).raw,
      { threadId: 'real-thread' },
    );
    const fetching = createGmailIngestor({
      ticketKeyPrefix: 'OPS',
      allowEmbedded: false,
      transportFor: () => transport,
    });
    const [item] = await fetching.ingest(account, source('pubsub-1', { messageId: stored.id }));
    expect(item?.message).toMatchObject({
      providerMessageId: stored.id,
      threadKey: 'gmail:real-thread',
      subject: 'Fetched',
    });
    expect(transport.calls.map((call) => call.op)).toEqual(['getMessage']);
  });

  it.each([
    [
      'a fetch with no transport for the account',
      createGmailIngestor({ ticketKeyPrefix: 'OPS', allowEmbedded: true }),
      { messageId: 'm1' },
      'gmail_transport_unavailable',
    ],
    [
      'an embedded payload in production',
      createGmailIngestor({ ticketKeyPrefix: 'OPS', allowEmbedded: false }),
      gmailPayload(),
      'embedded_payload_not_allowed',
    ],
    [
      'a payload nobody understands',
      createGmailIngestor({ ticketKeyPrefix: 'OPS', allowEmbedded: true }),
      { hello: 'world' },
      'gmail_payload_invalid',
    ],
  ])('refuses %s without retrying', async (_name, subject, payload, code) => {
    await expect(subject.ingest(account, source('e', payload))).rejects.toMatchObject({
      name: 'PermanentIngestError',
      code,
    });
    await expect(subject.ingest(account, source('e', payload))).rejects.toBeInstanceOf(
      PermanentIngestError,
    );
  });
});

function lineEvent(message: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    type: 'message',
    mode: 'active',
    timestamp: Date.parse('2026-11-02T03:00:00Z'),
    webhookEventId: '01EVENT',
    deliveryContext: { isRedelivery: false },
    source: { type: 'user', userId: 'U-user-1' },
    replyToken: 'reply-1',
    message,
    ...extra,
  };
}

describe('LINE ingestor', () => {
  const ingestor = createLineIngestor();
  const lineAccount: IngestAccount = { id: account.id, type: 'line' };

  it('turns a text message into a message of the conversation', async () => {
    const [item] = await ingestor.ingest(
      lineAccount,
      source('01EVENT', lineEvent({ type: 'text', id: 'L-1', text: 'ระบบล่มครับ' })),
    );
    expect(item?.message).toMatchObject({
      providerMessageId: 'L-1',
      threadKey: 'line:U-user-1',
      threadCandidates: [{ kind: 'line_conversation', value: 'U-user-1' }],
      from: { address: null, lineUserId: 'U-user-1' },
      subject: '',
      bodyText: 'ระบบล่มครับ',
      receivedAt: new Date('2026-11-02T03:00:00.000Z'),
      automated: { disposition: 'human' },
    });
    expect(item?.raw.contentType).toBe('application/json');
  });

  it('keeps the reply token out of the raw copy that goes to object storage, and in the message', async () => {
    const [item] = await ingestor.ingest(
      lineAccount,
      source('01EVENT', lineEvent({ type: 'text', id: 'L-9', text: 'hi' })),
    );
    expect(item?.message.replyToken).toBe('reply-1');
    const raw = Buffer.from(item?.raw.body ?? []).toString('utf8');
    expect(raw).not.toContain('reply-1');
    expect(raw).not.toContain('replyToken');
    expect(JSON.parse(raw)).toMatchObject({ webhookEventId: '01EVENT', message: { id: 'L-9' } });
  });

  it('keeps other content as text placeholders, and stickers as noise', async () => {
    const [image] = await ingestor.ingest(
      lineAccount,
      source('e', lineEvent({ type: 'image', id: 'L-2' })),
    );
    expect(image?.message.bodyText).toBe('[image]');
    const [file] = await ingestor.ingest(
      lineAccount,
      source('e', lineEvent({ type: 'file', id: 'L-3', fileName: 'รายงาน.pdf', fileSize: 10 })),
    );
    expect(file?.message.bodyText).toBe('[file] รายงาน.pdf');
    const [sticker] = await ingestor.ingest(
      lineAccount,
      source('e', lineEvent({ type: 'sticker', id: 'L-4', packageId: '1', stickerId: '2' })),
    );
    expect(sticker?.message.automated).toMatchObject({ disposition: 'noise', subtype: 'sticker' });
  });

  it('treats a sender LINE did not reveal as noise instead of inventing a contact', async () => {
    const [item] = await ingestor.ingest(
      lineAccount,
      source(
        'e',
        lineEvent(
          { type: 'text', id: 'L-5', text: 'hi' },
          { source: { type: 'group', groupId: 'G1' } },
        ),
      ),
    );
    expect(item?.message).toMatchObject({
      threadKey: 'line:G1',
      from: { lineUserId: null },
      automated: { disposition: 'noise', subtype: 'line_sender_hidden' },
    });
  });

  it('records events that are not messages, or that belong to another module, and nothing more', async () => {
    expect(
      await ingestor.ingest(lineAccount, source('e', lineEvent({}, { type: 'follow' }))),
    ).toEqual([]);
    expect(
      await ingestor.ingest(lineAccount, source('e', lineEvent({}, { type: 'unfollow' }))),
    ).toEqual([]);
    expect(
      await ingestor.ingest(
        lineAccount,
        source('e', lineEvent({ type: 'text', id: 'L-6', text: 'x' }, { mode: 'standby' })),
      ),
    ).toEqual([]);
  });

  it('refuses an event that does not fit the schema, without retrying', async () => {
    await expect(
      ingestor.ingest(
        lineAccount,
        source('e', { type: 'message', webhookEventId: '01X', timestamp: 'soon' }),
      ),
    ).rejects.toMatchObject({ name: 'PermanentIngestError', code: 'line_invalid_event' });
  });
});
