import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe } from 'vitest';

import { randomWebhook } from './__fixtures__/random-webhook.js';
import { FakeDiscordTransport } from './fake.js';
import { LiveDiscordTransport } from './live.js';
import { discordTransportContract } from './transport.contract.js';
import { DiscordWebhook } from './webhook.js';

/**
 * The contract always runs against the fake. It runs against the live transport only with
 * `CONTRACT_LIVE=1` (never set here; `[ASK-HUMAN]`), and posts only with `CONTRACT_LIVE_WRITE=1`.
 */
const LIVE = process.env['CONTRACT_LIVE'] === '1';
const WRITES = LIVE && process.env['CONTRACT_LIVE_WRITE'] === '1';

const net = LIVE ? null : disableNetConnect();
afterAll(() => {
  net?.restore();
});

discordTransportContract({
  name: 'FakeDiscordTransport',
  live: false,
  allowWrites: true,
  create: () => new FakeDiscordTransport(),
  webhook: randomWebhook(),
  revoke: (transport, webhook) => {
    if (!(transport instanceof FakeDiscordTransport))
      throw new Error('fake harness needs the fake');
    transport.revoke(webhook.id);
  },
});

describe.skipIf(!LIVE)('live (CONTRACT_LIVE=1)', () => {
  discordTransportContract({
    name: 'LiveDiscordTransport',
    live: true,
    allowWrites: WRITES,
    create: () => new LiveDiscordTransport({ fetch: globalThis.fetch }),
    // Parsed on first use, so a run without the variable never evaluates it.
    get webhook() {
      return DiscordWebhook.parse(process.env['DISCORD_CONTRACT_WEBHOOK_URL'] ?? '');
    },
  });
});
