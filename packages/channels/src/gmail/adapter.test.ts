import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { channelCapabilitiesSchema } from '../common/adapter.js';
import { ChannelError } from '../common/errors.js';
import { loadFixture } from './__fixtures__/load.js';
import { GMAIL_CAPABILITIES, GmailAdapter, gmailInboundSchema } from './adapter.js';
import { FakeGmailTransport } from './fake.js';
import { parentFromEmail } from './reply.js';
import { decodeGmailPushData } from './transport.js';

const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

function setup() {
  const transport = new FakeGmailTransport();
  const adapter = new GmailAdapter({ transport, ticketKeyPrefix: 'OPS' });
  const deliver = (name: string, labelIds?: string[]) =>
    transport.deliver(loadFixture(name), labelIds === undefined ? {} : { labelIds });
  return { transport, adapter, deliver };
}

describe('GmailAdapter', () => {
  it('declares capabilities that validate against the shared schema', () => {
    const adapter = setup().adapter;
    expect(channelCapabilitiesSchema.parse(adapter.capabilities())).toEqual(GMAIL_CAPABILITIES);
    expect(adapter.capabilities()).toMatchObject({
      channel: 'gmail',
      threading: 'native',
      markRead: false,
    });
  });

  it('ingests a message: normalised, classified, with thread keys and a schema-valid result', async () => {
    const { adapter, deliver } = setup();
    const message = deliver('plain-ascii.eml');
    const [inbound] = await adapter.ingest({ messageId: message.id });
    expect(inbound).toBeDefined();
    if (inbound === undefined) return;
    expect(gmailInboundSchema.safeParse(inbound).success).toBe(true);
    expect(inbound).toMatchObject({
      providerMessageId: message.id,
      gmailThreadId: message.threadId,
      email: { subject: 'Cannot log in to the dashboard' },
      automated: { disposition: 'human' },
      threadKey: `gmail:${message.threadId}`,
      messageIdKey: 'caf1234abcd@mail.customer.example.com',
    });
    expect(inbound.receivedAt).toBe(new Date(Number(message.internalDate)).toISOString());
    expect(inbound.threadCandidates[0]).toEqual({
      kind: 'gmail_thread_id',
      value: message.threadId,
    });
  });

  it('puts attachments in attachmentData and keeps them out of the serialisable part', async () => {
    const { adapter, deliver } = setup();
    const message = deliver('inline-image-attachment.eml');
    const [inbound] = await adapter.ingest({ messageId: message.id });
    expect(inbound?.attachmentData.size).toBe(2);
    expect(JSON.stringify(gmailInboundSchema.parse(inbound))).not.toContain('PNG');
  });

  it('flags a bounce, an out-of-office and a newsletter without creating tickets', async () => {
    const { adapter, deliver } = setup();
    const verdicts = await Promise.all(
      ['bounce-dsn.eml', 'out-of-office.eml', 'newsletter.eml'].map(async (name) => {
        const message = deliver(name);
        const [inbound] = await adapter.ingest({ messageId: message.id });
        return inbound?.automated;
      }),
    );
    expect(verdicts.map((v) => v?.subtype)).toEqual(['bounce', 'out_of_office', 'mailing_list']);
    expect(verdicts.every((v) => v?.suppressAutoAck === true)).toBe(true);
  });

  it('uses Gmail labels in the verdict', async () => {
    const { adapter, deliver } = setup();
    const message = deliver('plain-ascii.eml', ['INBOX', 'CATEGORY_PROMOTIONS']);
    const [inbound] = await adapter.ingest({ messageId: message.id });
    expect(inbound?.automated).toMatchObject({ disposition: 'noise', subtype: 'gmail_category' });
  });

  it('links an inbound customer reply to the thread of the message we sent', async () => {
    const { adapter, deliver, transport } = setup();
    const first = deliver('plain-ascii.eml');
    const [original] = await adapter.ingest({ messageId: first.id });
    if (original === undefined) throw new Error('no inbound');

    const sent = await adapter.send({
      from: { address: 'support@example.com' },
      inReplyTo: parentFromEmail(original.email),
      textBody: 'Please try again.',
      messageId: 'wt.delivery1@example.com',
      threadId: original.gmailThreadId,
      ticketKey: 'OPS-1234',
    });
    expect(sent.gmailThreadId).toBe(first.threadId);
    expect(sent.built.subject).toBe('Cannot log in to the dashboard [OPS-1234]');

    // The customer answers; the fake threads it from the headers like Gmail does.
    const answer = deliver('reply-in-thread.eml');
    expect(answer.threadId).toBe(first.threadId);
    const [reply] = await adapter.ingest({ messageId: answer.id });
    expect(reply?.threadKey).toBe(original.threadKey);
    expect(reply?.threadCandidates.map((c) => c.kind)).toEqual([
      'gmail_thread_id',
      'in_reply_to',
      'references',
      'references',
      'subject_token',
    ]);
    expect(transport.sent).toHaveLength(1);
  });

  it('rejects markRead because Gmail does not offer it', async () => {
    const error = await setup()
      .adapter.markRead()
      .catch((c: unknown) => c);
    expect(error).toBeInstanceOf(ChannelError);
    expect(error).toMatchObject({ kind: 'unsupported' });
  });

  it('propagates a missing message as not_found', async () => {
    await expect(setup().adapter.ingest({ messageId: 'nope' })).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('rejects a message that is too large before parsing it', async () => {
    const transport = new FakeGmailTransport();
    const adapter = new GmailAdapter({ transport, mimeLimits: { maxMessageBytes: 100 } });
    const message = transport.deliver(loadFixture('plain-ascii.eml'));
    await expect(adapter.ingest({ messageId: message.id })).rejects.toThrow(/message_too_large/);
  });
});

describe('Pub/Sub push payload', () => {
  it('decodes the base64url notification data', () => {
    const data = Buffer.from(
      JSON.stringify({ emailAddress: 'support@example.com', historyId: 9876543210 }),
    ).toString('base64url');
    expect(decodeGmailPushData(data)).toEqual({
      emailAddress: 'support@example.com',
      historyId: '9876543210',
    });
  });

  it('rejects data that is not a notification', () => {
    expect(() => decodeGmailPushData(Buffer.from('{"x":1}').toString('base64url'))).toThrow();
    expect(() => decodeGmailPushData('%%%')).toThrow();
  });
});
