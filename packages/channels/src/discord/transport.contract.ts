import { describe, expect, it } from 'vitest';

import { ChannelError } from '../common/errors.js';
import { buildTicketCreatedMessage, type DiscordWebhookMessage } from './message.js';
import type { DiscordTransport } from './transport.js';
import type { DiscordWebhook } from './webhook.js';

/**
 * One behavioural contract for every `DiscordTransport`. It runs against `FakeDiscordTransport` on
 * every test run, and against `LiveDiscordTransport` only when `CONTRACT_LIVE=1` (`[ASK-HUMAN]`).
 * A live run posts to a real channel, so it also needs `CONTRACT_LIVE_WRITE=1` and a throw-away
 * webhook (`DISCORD_CONTRACT_WEBHOOK_URL`). Neither variable is set by any script in this repository.
 */

export interface DiscordContractHarness {
  readonly name: string;
  readonly live: boolean;
  readonly allowWrites: boolean;
  create(): DiscordTransport;
  /** A usable webhook (live: the throw-away one). */
  readonly webhook: DiscordWebhook;
  /** Fake only: the webhook is deleted and answers 404 from now on. */
  revoke?(transport: DiscordTransport, webhook: DiscordWebhook): void;
}

const notice = () =>
  buildTicketCreatedMessage({
    ticketKey: 'OPS-1',
    priority: 'P2',
    channel: 'portal',
    link: 'https://watchtower.example.test/tickets/OPS-1',
    at: new Date('2030-01-01T00:00:00.000Z'),
  });

async function failureOf(work: Promise<unknown>): Promise<ChannelError> {
  const caught = await work.then(
    () => null,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(ChannelError);
  return caught as ChannelError;
}

export function discordTransportContract(harness: DiscordContractHarness): void {
  const writes = !harness.live || harness.allowWrites;

  describe(`DiscordTransport contract: ${harness.name}`, () => {
    it('says whether it is live or a fake', () => {
      expect(harness.create().kind).toBe(harness.live ? 'live' : 'fake');
    });

    it.each<[string, DiscordWebhookMessage]>([
      ['no content and no embed', {}],
      ['content over 2000 characters', { content: 'x'.repeat(2001) }],
      ['more than 10 embeds', { embeds: Array.from({ length: 11 }, () => ({ title: 'a' })) }],
      [
        'embeds over 6000 characters in total',
        {
          embeds: Array.from({ length: 2 }, () => ({ description: 'y'.repeat(3001) })),
        },
      ],
    ])('refuses %s before anything is sent', async (_name, message) => {
      const error = await failureOf(harness.create().execute(harness.webhook, message));
      expect(error.kind).toBe('client');
      expect(error.provider).toBe('discord');
      expect(error.outcomeUnknown).toBe(false);
    });

    it.skipIf(!writes)('posts a ticket notice and reports the delivery honestly', async () => {
      const result = await harness.create().execute(harness.webhook, notice());
      // A fake recorded it in memory: it must never claim a delivery.
      expect(result.delivered).toBe(harness.live);
      expect(result.messageId === null || result.messageId.length > 0).toBe(true);
    });

    it.skipIf(harness.revoke === undefined)(
      'answers not_found for a webhook that was deleted, and it is not retryable',
      async () => {
        const transport = harness.create();
        harness.revoke?.(transport, harness.webhook);
        const error = await failureOf(transport.execute(harness.webhook, notice()));
        expect(error.kind).toBe('not_found');
        expect(error.retryable).toBe(false);
      },
    );
  });
}
