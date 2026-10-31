import { randomBytes } from 'node:crypto';

import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe } from 'vitest';

import { FakeLineTransport } from './fake.js';
import { LiveLineTransport } from './live.js';
import { lineTransportContract, type LineContractHarness } from './transport.contract.js';

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

const fakeHarness: LineContractHarness = {
  name: 'FakeLineTransport',
  live: false,
  allowWrites: true,
  recipient: `U${randomBytes(16).toString('hex')}`,
  create: () => new FakeLineTransport(),
  issueReplyToken: (transport) => {
    if (!(transport instanceof FakeLineTransport)) throw new Error('fake harness needs the fake');
    return transport.issueReplyToken();
  },
};

lineTransportContract(fakeHarness);

describe.skipIf(!LIVE)('live (CONTRACT_LIVE=1)', () => {
  const accessToken = process.env['LINE_CONTRACT_ACCESS_TOKEN'] ?? '';
  const liveHarness: LineContractHarness = {
    name: 'LiveLineTransport',
    live: true,
    allowWrites: WRITES,
    recipient: process.env['LINE_CONTRACT_TO'] ?? '',
    create: () =>
      new LiveLineTransport({
        fetch: globalThis.fetch,
        getChannelAccessToken: () => Promise.resolve(accessToken),
      }),
  };
  lineTransportContract(liveHarness);
});
