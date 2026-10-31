import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ChannelError } from '../common/errors.js';
import type { LineTransport } from './transport.js';

/**
 * One behavioural contract for every `LineTransport`. It runs against `FakeLineTransport` on every
 * test run, and against `LiveLineTransport` only when `CONTRACT_LIVE=1` (`[ASK-HUMAN]`).
 *
 * A live run is read-only unless `CONTRACT_LIVE_WRITE=1` as well: push messages reach real people
 * and use quota. Neither variable is set by any script in this repository.
 */

export interface LineContractHarness {
  readonly name: string;
  readonly live: boolean;
  readonly allowWrites: boolean;
  create(): LineTransport;
  /** Fake only: simulate a webhook that delivers a single-use reply token. */
  issueReplyToken?(transport: LineTransport): string;
  /** Recipient for push tests (live: `LINE_CONTRACT_TO`, a test user id). */
  readonly recipient: string;
}

const text = (value: string) => [{ type: 'text' as const, text: value }];

async function failureOf(work: Promise<unknown>): Promise<ChannelError> {
  const caught = await work.then(
    () => null,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(ChannelError);
  return caught as ChannelError;
}

export function lineTransportContract(harness: LineContractHarness): void {
  const writes = !harness.live || harness.allowWrites;

  describe(`LineTransport contract: ${harness.name}`, () => {
    it('getQuota returns "none" or "limited" with a value', async () => {
      const quota = await harness.create().getQuota();
      expect(['none', 'limited']).toContain(quota.type);
      if (quota.type === 'limited') expect(quota.value).toBeGreaterThanOrEqual(0);
    });

    it('getConsumption returns a non-negative count', async () => {
      const { totalUsage } = await harness.create().getConsumption();
      expect(Number.isInteger(totalUsage)).toBe(true);
      expect(totalUsage).toBeGreaterThanOrEqual(0);
    });

    it('getContent of an unknown message rejects with not_found', async () => {
      const error = await failureOf(harness.create().getContent('0000000000000'));
      expect(error.kind).toBe('not_found');
    });

    it('rejects an empty message list, more than five messages and over-long text before sending', async () => {
      const transport = harness.create();
      const retryKey = randomUUID();
      const bad = [
        transport.push({ to: harness.recipient, messages: [], retryKey }),
        transport.push({
          to: harness.recipient,
          messages: Array.from({ length: 6 }, () => ({ type: 'text' as const, text: 'x' })),
          retryKey,
        }),
        transport.push({ to: harness.recipient, messages: text('x'.repeat(5001)), retryKey }),
        transport.reply({ replyToken: 'token', messages: [] }),
      ];
      for (const attempt of bad) {
        const error = await failureOf(attempt);
        expect(error.kind).toBe('client');
      }
    });

    it('rejects a push whose retry key is not a UUID', async () => {
      const error = await failureOf(
        harness
          .create()
          .push({ to: harness.recipient, messages: text('x'), retryKey: 'not-a-uuid' }),
      );
      expect(error.kind).toBe('client');
    });

    it('showLoadingAnimation rejects a duration LINE does not allow', async () => {
      const error = await failureOf(
        harness.create().showLoadingAnimation({ chatId: harness.recipient, loadingSeconds: 7 }),
      );
      expect(error.kind).toBe('client');
    });

    it.skipIf(!writes)('reply with an unknown token fails with invalid_reply_token', async () => {
      const error = await failureOf(
        harness
          .create()
          .reply({ replyToken: 'ffffffffffffffffffffffffffffffff', messages: text('x') }),
      );
      expect(error).toMatchObject({ kind: 'client', status: 400, code: 'invalid_reply_token' });
    });

    it.skipIf(!writes)('markAsRead with an unknown token fails', async () => {
      const error = await failureOf(harness.create().markAsRead({ markAsReadToken: 'unknown' }));
      expect(error.kind).toBe('client');
    });

    it.skipIf(!writes)('push is idempotent for a repeated retry key and counts once', async () => {
      const transport = harness.create();
      const before = (await transport.getConsumption()).totalUsage;
      const retryKey = randomUUID();
      const first = await transport.push({
        to: harness.recipient,
        messages: text('contract'),
        retryKey,
      });
      expect(first.alreadyAccepted).toBe(false);
      expect(first.sentMessageIds.length).toBe(1);

      const second = await transport.push({
        to: harness.recipient,
        messages: text('contract'),
        retryKey,
      });
      expect(second.alreadyAccepted).toBe(true);
      expect(second.acceptedRequestId).toBe(first.requestId);
      expect(second.sentMessageIds).toEqual([]);

      const after = (await transport.getConsumption()).totalUsage;
      // LINE reports consumption approximately; the fake is exact. Never more than once.
      expect(after - before).toBeLessThanOrEqual(1);
    });

    it.skipIf(harness.issueReplyToken === undefined || !writes)(
      'a reply token works exactly once',
      async () => {
        const transport = harness.create();
        const token = harness.issueReplyToken?.(transport) ?? '';
        const first = await transport.reply({ replyToken: token, messages: text('ack') });
        expect(first.alreadyAccepted).toBe(false);
        const error = await failureOf(
          transport.reply({ replyToken: token, messages: text('again') }),
        );
        expect(error).toMatchObject({ kind: 'client', code: 'invalid_reply_token' });
      },
    );

    it.skipIf(harness.issueReplyToken === undefined || !writes)(
      'replying does not use quota',
      async () => {
        const transport = harness.create();
        const before = (await transport.getConsumption()).totalUsage;
        await transport.reply({
          replyToken: harness.issueReplyToken?.(transport) ?? '',
          messages: text('ack'),
        });
        expect((await transport.getConsumption()).totalUsage).toBe(before);
      },
    );
  });
}
