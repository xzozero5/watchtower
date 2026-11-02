import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createMockClients, loadMockFixtures } from './mock.js';

const TOOLS_DIR = fileURLToPath(new URL('../../../examples/tools', import.meta.url));

describe('loadMockFixtures', () => {
  it('reads examples/tools/fixtures.json and refuses a missing directory quietly', () => {
    const fixtures = loadMockFixtures(TOOLS_DIR);
    expect(fixtures?.logs.length).toBeGreaterThan(3);
    expect(loadMockFixtures(undefined)).toBeUndefined();
    expect(loadMockFixtures('')).toBeUndefined();
    expect(loadMockFixtures(fileURLToPath(new URL('./nowhere', import.meta.url)))).toBeUndefined();
  });
});

describe('createMockClients', () => {
  const NOW = Date.parse('2026-06-01T12:00:00.000Z');
  const fixtures = loadMockFixtures(TOOLS_DIR);
  if (fixtures === undefined) throw new Error('examples/tools/fixtures.json is missing');
  const clients = createMockClients(fixtures, { clock: () => NOW });

  it('places log lines relative to the clock and keeps the fake personal data in them (for the redaction tests)', async () => {
    const page = await clients.logs.listEntries({
      filter: 'service="example-delivery"',
      from: new Date(NOW - 3_600_000),
      to: new Date(NOW),
      pageSize: 20,
    });
    expect(page.entries.length).toBeGreaterThanOrEqual(2);
    expect(page.entries.map((e) => e.message).join(' ')).toMatch(/@example\.com/);
    // Two minutes later the same lines are two minutes older, still inside the window.
    expect(clients.logs.source).toBe('fake');
  });

  it('answers a repository from the fixture, newest first', async () => {
    const changes = await clients.repo.listChanges({
      repo: 'example/delivery',
      since: new Date(NOW - 24 * 3_600_000),
      until: new Date(NOW),
      limit: 10,
    });
    expect(changes.map((change) => change.ref)).toEqual(['v1.8.2', '#1203']);
  });

  it('answers data by template name and metrics only for the services listed', async () => {
    const data = await clients.data.query({
      label: 'webhook_not_received',
      sql: 'SELECT 1',
      params: [],
      maxRows: 10,
      timeoutMs: 1000,
    });
    expect(data.columns).toEqual(['hour', 'deliveries', 'failed']);
    const known = await clients.metrics.queryTimeSeries({
      service: 'example-api',
      metrics: ['error_rate'],
      from: new Date(NOW - 3_600_000),
      to: new Date(NOW),
      stepSeconds: 300,
    });
    const unknown = await clients.metrics.queryTimeSeries({
      service: 'not-in-the-fixture',
      metrics: ['error_rate'],
      from: new Date(NOW - 3_600_000),
      to: new Date(NOW),
      stepSeconds: 300,
    });
    expect(known.series[0]?.points.length).toBeGreaterThan(0);
    expect(unknown.series[0]?.points).toEqual([]);
  });
});
