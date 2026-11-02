import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import {
  dataContract,
  logsContract,
  metricsContract,
  quotaContract,
  repoContract,
  SEEDED_LOGS,
} from './clients.contract.js';
import { FakeDataQueryClient } from './data/fake.js';
import type { DataQueryClient } from './data/types.js';
import { FakeLogsClient } from './logs/fake.js';
import type { LogsClient } from './logs/types.js';
import { FakeMetricsClient } from './metrics/fake.js';
import type { MetricsClient } from './metrics/types.js';
import { FakeRepoClient } from './repo/fake.js';
import type { RepoClient } from './repo/types.js';

const NOW = Date.parse('2026-03-10T12:00:00.000Z');

// The fakes never open a connection: the whole suite runs with the network shut and proves nothing tried.
const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

logsContract('FakeLogsClient', () => new FakeLogsClient({ entries: SEEDED_LOGS }));
metricsContract('FakeMetricsClient', () => new FakeMetricsClient({ clock: () => NOW }));
dataContract(
  'FakeDataQueryClient',
  () =>
    new FakeDataQueryClient({
      rows: { columns: ['n'], rows: [[1], [2], [3]] },
    }),
);
repoContract('FakeRepoClient', () => {
  const client = new FakeRepoClient();
  for (const [ref, hoursAgo] of [
    ['v1.0.0', 3],
    ['v1.0.1', 1],
    ['v0.9.0', 30],
  ] as const) {
    client.add({
      repo: 'example/app',
      kind: 'release',
      ref,
      title: `Release ${ref}`,
      author: null,
      at: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
      url: null,
    });
  }
  return client;
});

const minute = { from: new Date(NOW - 60_000), to: new Date(NOW) };
quotaContract('FakeLogsClient 60 a minute', 60, (clock) => {
  const client = new FakeLogsClient({ entries: SEEDED_LOGS, quotaPerMinute: 60, clock });
  return { call: () => client.listEntries({ filter: '', pageSize: 1, ...minute }) };
});
quotaContract('FakeMetricsClient 5 a minute', 5, (clock) => {
  const client = new FakeMetricsClient({ quotaPerMinute: 5, clock });
  return {
    call: () =>
      client.queryTimeSeries({
        service: 's',
        metrics: ['error_rate'],
        ...minute,
        stepSeconds: 60,
      }),
  };
});
quotaContract('FakeRepoClient 3 a minute', 3, (clock) => {
  const client = new FakeRepoClient({ quotaPerMinute: 3, clock });
  return {
    call: () =>
      client.listChanges({ repo: 'example/app', since: minute.from, until: minute.to, limit: 1 }),
  };
});

describe('FakeLogsClient', () => {
  it('counts what got past the quota and keeps every query it was sent', async () => {
    const client = new FakeLogsClient({
      entries: SEEDED_LOGS,
      quotaPerMinute: 2,
      clock: () => NOW,
    });
    await client.listEntries({ filter: '', pageSize: 1, ...minute });
    await client.listEntries({ filter: '', pageSize: 1, ...minute });
    await expect(client.listEntries({ filter: '', pageSize: 1, ...minute })).rejects.toMatchObject({
      status: 429,
    });
    expect(client.served).toBe(2);
    expect(client.queries).toHaveLength(3);
  });
});

describe('N2: the clients have no method that writes', () => {
  // The names of the methods each interface declares. `Same` fails to compile when an interface gains a method not listed
  // here, and the test below fails when a listed name starts with a write verb.
  type MethodNames<T> = {
    [K in keyof T]-?: T[K] extends (...args: never[]) => unknown ? K : never;
  }[keyof T];
  type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
  const logs: Same<MethodNames<LogsClient>, 'listEntries'> = true;
  const metrics: Same<MethodNames<MetricsClient>, 'queryTimeSeries'> = true;
  const data: Same<MethodNames<DataQueryClient>, 'query'> = true;
  const repo: Same<MethodNames<RepoClient>, 'listChanges'> = true;
  const METHODS = ['listEntries', 'queryTimeSeries', 'query', 'listChanges'];

  it.each(METHODS)('%s is a read', (name) => {
    expect([logs, metrics, data, repo]).toEqual([true, true, true, true]);
    expect(name).not.toMatch(/^(create|update|delete|write|post|put|patch|send|insert)/i);
  });
});
