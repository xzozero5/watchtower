import { describe, expect, it } from 'vitest';

import { ChannelError } from '../common/errors.js';
import { isHistoryExpired, type GmailMessageRef, type GmailTransport } from './transport.js';

/**
 * One behavioural contract for every `GmailTransport`. It runs against `FakeGmailTransport` on
 * every test run, and against `LiveGmailTransport` only when `CONTRACT_LIVE=1` (`[ASK-HUMAN]`).
 *
 * A live run is read-only unless `CONTRACT_LIVE_WRITE=1` is also set, because sending mail and
 * registering a watch change a real mailbox. Neither variable is set by any script in this repo.
 */

export interface GmailContractHarness {
  readonly name: string;
  /** True for a real mailbox: seeding is impossible and writes need an explicit opt-in. */
  readonly live: boolean;
  readonly allowWrites: boolean;
  /** Fresh transport. */
  create(): GmailTransport;
  /** Puts a message in the mailbox. Only fakes can; live runs use what is already there. */
  seed?(transport: GmailTransport, raw: string): Promise<GmailMessageRef>;
  /** Topic for watch tests (live: `GMAIL_CONTRACT_TOPIC`). */
  readonly topicName: string;
}

const SAMPLE = [
  'From: Alice Example <alice@customer.example.com>',
  'To: support@example.com',
  'Subject: Contract test message',
  'Message-ID: <contract-1@customer.example.com>',
  'Date: Tue, 14 Oct 2025 09:11:58 +0700',
  'Content-Type: text/plain; charset=UTF-8',
  '',
  'hello',
  '',
].join('\r\n');

function toBase64Url(text: string): string {
  return Buffer.from(text, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function gmailTransportContract(harness: GmailContractHarness): void {
  const seedable = harness.seed !== undefined;
  const seed = async (transport: GmailTransport, raw = SAMPLE): Promise<GmailMessageRef> => {
    if (harness.seed === undefined) throw new Error('harness cannot seed');
    return harness.seed(transport, raw);
  };

  describe(`GmailTransport contract: ${harness.name}`, () => {
    it('listMessages returns a well-formed page', async () => {
      const transport = harness.create();
      if (seedable) await seed(transport);
      const page = await transport.listMessages({ maxResults: 5 });
      expect(Array.isArray(page.messages)).toBe(true);
      for (const message of page.messages) {
        expect(message.id).not.toBe('');
        expect(message.threadId).not.toBe('');
      }
    });

    it('getMessage(raw) returns the RFC 822 source as base64url', async () => {
      const transport = harness.create();
      if (seedable) await seed(transport);
      const [first] = (await transport.listMessages({ maxResults: 1 })).messages;
      if (first === undefined) return; // live mailbox with no mail: nothing to read
      const message = await transport.getMessage({ id: first.id, format: 'raw' });
      expect(message.id).toBe(first.id);
      expect(message.threadId).toBe(first.threadId);
      expect(message.raw).toMatch(/^[A-Za-z0-9_-]+={0,2}$/);
      const text = Buffer.from(message.raw ?? '', 'base64url').toString('latin1');
      expect(text).toMatch(/^[A-Za-z-]+: /m);
    });

    it('getMessage(minimal) does not carry the body', async () => {
      const transport = harness.create();
      if (seedable) await seed(transport);
      const [first] = (await transport.listMessages({ maxResults: 1 })).messages;
      if (first === undefined) return;
      const message = await transport.getMessage({ id: first.id, format: 'minimal' });
      expect(message.raw).toBeUndefined();
    });

    it('getMessage of an unknown id rejects with not_found', async () => {
      const transport = harness.create();
      const error = await transport
        .getMessage({ id: 'ffffffffffffffff', format: 'minimal' })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ChannelError);
      expect((error as ChannelError).kind).toBe('not_found');
      expect((error as ChannelError).status).toBe(404);
    });

    it('listHistory reports the current historyId and returns later changes only', async () => {
      const transport = harness.create();
      if (!seedable) {
        const [first] = (await transport.listMessages({ maxResults: 1 })).messages;
        if (first === undefined) return;
        const { historyId } = await transport.getMessage({ id: first.id, format: 'minimal' });
        if (historyId === undefined) return;
        const page = await transport.listHistory({ startHistoryId: historyId });
        expect(page.historyId).not.toBe('');
        return;
      }
      const before = await seed(transport);
      const start =
        (await transport.getMessage({ id: before.id, format: 'minimal' })).historyId ?? '';
      const after = await seed(transport, SAMPLE.replace('contract-1', 'contract-2'));
      const page = await transport.listHistory({
        startHistoryId: start,
        historyTypes: ['messageAdded'],
      });
      const added = page.history
        .flatMap((record) => record.messagesAdded ?? [])
        .map((m) => m.message.id);
      expect(added).toEqual([after.id]);
      expect(Number(page.historyId)).toBeGreaterThanOrEqual(Number(start));
    });

    it('listHistory pages with nextPageToken', async () => {
      if (!seedable) return;
      const transport = harness.create();
      const first = await seed(transport);
      const start =
        (await transport.getMessage({ id: first.id, format: 'minimal' })).historyId ?? '';
      for (const n of [2, 3, 4])
        await seed(transport, SAMPLE.replace('contract-1', `contract-${String(n)}`));
      const one = await transport.listHistory({ startHistoryId: start, maxResults: 2 });
      expect(one.history).toHaveLength(2);
      expect(one.nextPageToken).toBeDefined();
      const two = await transport.listHistory({
        startHistoryId: start,
        maxResults: 2,
        ...(one.nextPageToken === undefined ? {} : { pageToken: one.nextPageToken }),
      });
      expect(two.history).toHaveLength(1);
      expect(two.nextPageToken).toBeUndefined();
    });

    it('listHistory with a start id outside retention is the "run a full sync" signal', async () => {
      const transport = harness.create();
      const outcome = await transport.listHistory({ startHistoryId: '1' }).then(
        () => 'resolved' as const,
        (error: unknown) => (isHistoryExpired(error) ? ('expired' as const) : error),
      );
      // Google documents 404 "typically"; a real mailbox may still answer, but never with another error.
      if (harness.live) expect(['resolved', 'expired']).toContain(outcome);
      else expect(outcome).toBe('expired');
    });

    it.skipIf(harness.live && !harness.allowWrites)(
      'sendMessage returns ids, keeps the requested thread and stores a SENT copy',
      async () => {
        const transport = harness.create();
        const parent = seedable
          ? await seed(transport)
          : (await transport.listMessages({ maxResults: 1 })).messages[0];
        if (parent === undefined) return;
        const reply = await transport.sendMessage({
          raw: toBase64Url(
            [
              'From: support@example.com',
              'To: alice@customer.example.com',
              'Subject: Contract test message',
              'Message-ID: <contract-reply@example.com>',
              'In-Reply-To: <contract-1@customer.example.com>',
              'References: <contract-1@customer.example.com>',
              'Content-Type: text/plain; charset=UTF-8',
              '',
              'reply',
              '',
            ].join('\r\n'),
          ),
          threadId: parent.threadId,
        });
        expect(reply.id).not.toBe('');
        expect(reply.threadId).toBe(parent.threadId);
        expect(reply.labelIds).toContain('SENT');
      },
    );

    it.skipIf(harness.live && !harness.allowWrites)(
      'sendMessage to a thread that does not exist rejects with not_found',
      async () => {
        const transport = harness.create();
        const error = await transport
          .sendMessage({ raw: toBase64Url(SAMPLE), threadId: 'ffffffffffffffff' })
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ChannelError);
        expect((error as ChannelError).kind).toBe('not_found');
      },
    );

    it.skipIf(harness.live && !harness.allowWrites)(
      'watch returns a historyId and an expiry in the future; stopWatch succeeds',
      async () => {
        const transport = harness.create();
        const before = Date.now();
        const watch = await transport.watch({ topicName: harness.topicName, labelIds: ['INBOX'] });
        expect(watch.historyId).not.toBe('');
        expect(Number(watch.expiration)).toBeGreaterThan(before);
        // Gmail: a watch lasts at most 7 days, so it has to be renewed (R-2.1).
        expect(Number(watch.expiration) - before).toBeLessThanOrEqual(
          7 * 24 * 3600 * 1000 + 60_000,
        );
        await expect(transport.stopWatch()).resolves.toBeUndefined();
      },
    );

    it.skipIf(harness.live && !harness.allowWrites)(
      'watch rejects a malformed topic name',
      async () => {
        const transport = harness.create();
        const error = await transport
          .watch({ topicName: 'not-a-topic' })
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ChannelError);
        expect((error as ChannelError).kind).toBe('client');
      },
    );
  });
}
