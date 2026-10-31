import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { ChannelError } from '../common/errors.js';
import { loadFixture } from './__fixtures__/load.js';
import { FakeGmailTransport } from './fake.js';
import { isHistoryExpired } from './transport.js';

const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

const text = (name: string): string => Buffer.from(loadFixture(name)).toString('latin1');

describe('FakeGmailTransport behaviour beyond the contract', () => {
  it('threads a delivered reply under its parent by In-Reply-To / References', () => {
    const fake = new FakeGmailTransport();
    const first = fake.deliver(text('plain-ascii.eml'));
    const reply = fake.deliver(
      'From: alice@customer.example.com\r\nMessage-ID: <r1@customer.example.com>\r\nIn-Reply-To: <CAF1234abcd@mail.customer.example.com>\r\n\r\nthanks',
    );
    const other = fake.deliver(text('newsletter.eml'));
    expect(reply.threadId).toBe(first.threadId);
    expect(other.threadId).not.toBe(first.threadId);
  });

  it('threads a sent reply into the parent thread', async () => {
    const fake = new FakeGmailTransport();
    const first = fake.deliver(text('plain-ascii.eml'));
    const raw = Buffer.from(
      'From: support@example.com\r\nMessage-ID: <s1@example.com>\r\nIn-Reply-To: <CAF1234abcd@mail.customer.example.com>\r\n\r\nhi',
    ).toString('base64url');
    const sent = await fake.sendMessage({ raw, threadId: first.threadId });
    expect(sent.threadId).toBe(first.threadId);
    expect(fake.sent).toHaveLength(1);
    expect(fake.calls.at(-1)).toEqual({ op: 'sendMessage', threadId: first.threadId });
  });

  it('rejects a send with a malformed raw payload', async () => {
    const fake = new FakeGmailTransport();
    const error = await fake.sendMessage({ raw: 'not base64url!!' }).catch((c: unknown) => c);
    expect(error).toMatchObject({ kind: 'client', status: 400 });
  });

  it('returns history ids that only grow, and a 404 once history is expired', async () => {
    const fake = new FakeGmailTransport({ initialHistoryId: 10 });
    const a = fake.deliver(text('plain-ascii.eml'));
    const start = fake.currentHistoryId;
    fake.deliver(text('newsletter.eml'));
    expect(Number(fake.currentHistoryId)).toBeGreaterThan(Number(start));
    expect((await fake.listHistory({ startHistoryId: '10' })).history).toHaveLength(2);

    fake.expireHistoryBefore(start);
    const error = await fake.listHistory({ startHistoryId: '10' }).catch((c: unknown) => c);
    expect(isHistoryExpired(error)).toBe(true);
    expect(a.id).not.toBe('');
    // A start id inside the retained range still works.
    expect((await fake.listHistory({ startHistoryId: start })).history).toHaveLength(1);
  });

  it('lists newest first, filters by label and hides spam unless asked', async () => {
    const fake = new FakeGmailTransport();
    const inbox = fake.deliver(text('plain-ascii.eml'));
    const spam = fake.deliver(text('newsletter.eml'), { labelIds: ['SPAM'] });
    const listed = await fake.listMessages({});
    expect(listed.messages.map((m) => m.id)).toEqual([inbox.id]);
    const all = await fake.listMessages({ includeSpamTrash: true });
    expect(all.messages.map((m) => m.id)).toEqual([spam.id, inbox.id]);
    expect((await fake.listMessages({ labelIds: ['UNREAD'] })).messages).toHaveLength(1);
  });

  it('can be told to fail the next call, once', async () => {
    const fake = new FakeGmailTransport();
    fake.failNext(
      'users.history.list',
      new ChannelError({
        provider: 'gmail',
        operation: 'users.history.list',
        kind: 'server',
        status: 503,
      }),
    );
    await expect(fake.listHistory({ startHistoryId: '1000' })).rejects.toMatchObject({
      kind: 'server',
    });
    await expect(fake.listHistory({ startHistoryId: '1000' })).resolves.toBeDefined();
  });

  it('keeps watch state and clears it on stop', async () => {
    const now = new Date('2025-10-14T00:00:00Z');
    const fake = new FakeGmailTransport({ now: () => now });
    const watch = await fake.watch({ topicName: 'projects/p/topics/t' });
    expect(Number(watch.expiration)).toBe(now.getTime() + 7 * 24 * 3600 * 1000);
    expect(fake.watchState?.topicName).toBe('projects/p/topics/t');
    await fake.stopWatch();
    expect(fake.watchState).toBeNull();
  });

  it('makes no network connection at all', async () => {
    const fake = new FakeGmailTransport();
    fake.deliver(text('plain-ascii.eml'));
    await fake.listMessages({});
    expect(net.blocked()).toEqual([]);
  });
});
