import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe } from 'vitest';

import { FakeGmailTransport } from './fake.js';
import { LiveGmailTransport } from './live.js';
import { gmailTransportContract, type GmailContractHarness } from './transport.contract.js';
import type { GmailTransport } from './transport.js';

/**
 * The contract always runs against the fake. It runs against the live transport only with
 * `CONTRACT_LIVE=1` (never set here; `[ASK-HUMAN]`), and then read-only unless
 * `CONTRACT_LIVE_WRITE=1` as well.
 */
const LIVE = process.env['CONTRACT_LIVE'] === '1';
const WRITES = LIVE && process.env['CONTRACT_LIVE_WRITE'] === '1';

const net = LIVE ? null : disableNetConnect();
afterAll(() => {
  net?.restore();
});

const fakeHarness: GmailContractHarness = {
  name: 'FakeGmailTransport',
  live: false,
  allowWrites: true,
  topicName: 'projects/example-project/topics/example-topic',
  create: () => new FakeGmailTransport(),
  seed: (transport: GmailTransport, raw: string) => {
    if (!(transport instanceof FakeGmailTransport)) throw new Error('fake harness needs the fake');
    const { id, threadId } = transport.deliver(raw);
    return Promise.resolve({ id, threadId });
  },
};

gmailTransportContract(fakeHarness);

describe.skipIf(!LIVE)('live (CONTRACT_LIVE=1)', () => {
  const token = process.env['GMAIL_CONTRACT_ACCESS_TOKEN'] ?? '';
  const liveHarness: GmailContractHarness = {
    name: 'LiveGmailTransport',
    live: true,
    allowWrites: WRITES,
    topicName: process.env['GMAIL_CONTRACT_TOPIC'] ?? '',
    create: () =>
      new LiveGmailTransport({
        fetch: globalThis.fetch,
        getAccessToken: () => Promise.resolve(token),
      }),
  };
  gmailTransportContract(liveHarness);
});
