import { describe, expect, it } from 'vitest';

import { ConnectorQueryRejectedError, ConnectorRateLimitedError } from './common/errors.js';
import type { DataQueryClient } from './data/types.js';
import type { LogEntry, LogsClient } from './logs/types.js';
import type { MetricsClient } from './metrics/types.js';
import type { RepoClient } from './repo/types.js';

/**
 * Behaviour every implementation of the four read-only clients keeps (ADR-015). The fakes run it in
 * `clients.test.ts`; a live adapter (T-208) runs the same suite against a recorded or sandbox
 * backend before it is trusted. This file is excluded from the build.
 */

const NOW = Date.parse('2026-03-10T12:00:00.000Z');
const minutesAgo = (n: number): string => new Date(NOW - n * 60_000).toISOString();

export const SEEDED_LOGS: readonly LogEntry[] = [
  { insertId: 'a', timestamp: minutesAgo(5), severity: 'ERROR', service: 'svc-a', message: 'first failure', labels: { org_ref: 'org-1' } },
  { insertId: 'b', timestamp: minutesAgo(4), severity: 'INFO', service: 'svc-a', message: 'all fine', labels: { org_ref: 'org-1' } },
  { insertId: 'c', timestamp: minutesAgo(3), severity: 'ERROR', service: 'svc-b', message: 'second failure', labels: { org_ref: 'org-2' } },
  { insertId: 'd', timestamp: minutesAgo(2), severity: 'ERROR', service: 'svc-a', message: 'third failure', labels: { org_ref: 'org-1' } },
];

export function logsContract(name: string, make: () => LogsClient): void {
  describe(`LogsClient contract: ${name}`, () => {
    const range = { from: new Date(NOW - 3_600_000), to: new Date(NOW) };

    it('filters, orders newest first and stays inside the range', async () => {
      const page = await make().listEntries({ filter: 'service="svc-a" severity>=ERROR', pageSize: 10, ...range });
      expect(page.entries.map((e) => e.insertId)).toEqual(['d', 'a']);
      expect(page.nextPageToken).toBeNull();
      const narrow = await make().listEntries({
        filter: '',
        pageSize: 10,
        from: new Date(NOW - 3 * 60_000 - 1),
        to: new Date(NOW),
      });
      expect(narrow.entries.map((e) => e.insertId)).toEqual(['d', 'c']);
    });

    it('pages with a token until the end', async () => {
      const client = make();
      const first = await client.listEntries({ filter: '', pageSize: 3, ...range });
      expect(first.entries).toHaveLength(3);
      expect(first.nextPageToken).not.toBeNull();
      const second = await client.listEntries({
        filter: '',
        pageSize: 3,
        pageToken: first.nextPageToken ?? undefined,
        ...range,
      });
      expect(second.entries.map((e) => e.insertId)).toEqual(['a']);
      expect(second.nextPageToken).toBeNull();
    });

    it('refuses a bad page size, range, filter, token and an aborted request', async () => {
      const client = make();
      await expect(client.listEntries({ filter: '', pageSize: 0, ...range })).rejects.toBeInstanceOf(ConnectorQueryRejectedError);
      await expect(client.listEntries({ filter: '', pageSize: 101, ...range })).rejects.toBeInstanceOf(ConnectorQueryRejectedError);
      await expect(client.listEntries({ filter: '', pageSize: 5, from: range.to, to: range.from })).rejects.toBeInstanceOf(ConnectorQueryRejectedError);
      await expect(
        client.listEntries({ filter: '', pageSize: 5, from: new Date(NOW - 8 * 24 * 3_600_000), to: new Date(NOW) }),
      ).rejects.toBeInstanceOf(ConnectorQueryRejectedError);
      await expect(client.listEntries({ filter: 'nope="x"', pageSize: 5, ...range })).rejects.toBeInstanceOf(ConnectorQueryRejectedError);
      await expect(client.listEntries({ filter: '', pageSize: 5, pageToken: 'garbage', ...range })).rejects.toBeInstanceOf(ConnectorQueryRejectedError);
      await expect(
        client.listEntries({ filter: '', pageSize: 5, signal: AbortSignal.abort(), ...range }),
      ).rejects.toMatchObject({ code: 'timeout' });
    });
  });
}

export function metricsContract(name: string, make: () => MetricsClient): void {
  describe(`MetricsClient contract: ${name}`, () => {
    const from = new Date(NOW - 6 * 3_600_000);
    const to = new Date(NOW);

    it('returns one series per metric asked for, with a unit and ordered points', async () => {
      const { series } = await make().queryTimeSeries({
        service: 'svc-a',
        metrics: ['error_rate', 'latency_p95_ms'],
        from,
        to,
        stepSeconds: 600,
      });
      expect(series.map((s) => s.metric)).toEqual(['error_rate', 'latency_p95_ms']);
      expect(series.map((s) => s.unit)).toEqual(['ratio', 'ms']);
      for (const s of series) {
        expect(s.points.length).toBeGreaterThan(0);
        const times = s.points.map((p) => Date.parse(p.t));
        expect(times).toEqual(times.toSorted((x, y) => x - y));
        expect(times.every((t) => t >= from.getTime() && t < to.getTime())).toBe(true);
      }
    });

    it('is repeatable and refuses an empty ask, a bad step and a huge range', async () => {
      const client = make();
      const query = { service: 'svc-a', metrics: ['request_count'] as const, from, to, stepSeconds: 900 };
      expect(await client.queryTimeSeries(query)).toEqual(await client.queryTimeSeries(query));
      await expect(client.queryTimeSeries({ ...query, metrics: [] })).rejects.toBeInstanceOf(ConnectorQueryRejectedError);
      await expect(client.queryTimeSeries({ ...query, stepSeconds: 10 })).rejects.toBeInstanceOf(ConnectorQueryRejectedError);
      await expect(
        client.queryTimeSeries({ ...query, stepSeconds: 60, from: new Date(NOW - 30 * 24 * 3_600_000) }),
      ).rejects.toBeInstanceOf(ConnectorQueryRejectedError);
    });
  });
}

export function dataContract(name: string, make: () => DataQueryClient): void {
  describe(`DataQueryClient contract: ${name}`, () => {
    it('caps the rows, says when it did, and returns columns with the rows', async () => {
      const result = await make().query({
        label: 'rows',
        sql: 'SELECT n FROM numbers',
        params: [],
        maxRows: 2,
        timeoutMs: 1000,
      });
      expect(result.columns).toEqual(['n']);
      expect(result.rows).toHaveLength(2);
      expect(result.truncated).toBe(true);
      expect(result.masked).toEqual([]);
    });
  });
}

export function repoContract(name: string, make: () => RepoClient): void {
  describe(`RepoClient contract: ${name}`, () => {
    const since = new Date(NOW - 24 * 3_600_000);
    const until = new Date(NOW);

    it('lists newest first inside the window, at most `limit`', async () => {
      const client = make();
      const all = await client.listChanges({ repo: 'example/app', since, until, limit: 10 });
      expect(all.length).toBeGreaterThan(1);
      const times = all.map((c) => Date.parse(c.at));
      expect(times).toEqual(times.toSorted((a, b) => b - a));
      expect(all.every((c) => c.repo === 'example/app')).toBe(true);
      const one = await client.listChanges({ repo: 'example/app', since, until, limit: 1 });
      expect(one).toEqual(all.slice(0, 1));
      expect(await client.listChanges({ repo: 'example/other', since, until, limit: 10 })).toEqual([]);
    });

    it('refuses a name that is not owner/name, a bad limit and a reversed window', async () => {
      const client = make();
      await expect(client.listChanges({ repo: 'not a repo', since, until, limit: 5 })).rejects.toBeInstanceOf(ConnectorQueryRejectedError);
      await expect(client.listChanges({ repo: 'example/app', since, until, limit: 0 })).rejects.toBeInstanceOf(ConnectorQueryRejectedError);
      await expect(client.listChanges({ repo: 'example/app', since: until, until: since, limit: 5 })).rejects.toBeInstanceOf(ConnectorQueryRejectedError);
    });
  });
}

/** A client that has a quota answers 429 past it and recovers when the window moves. */
export function quotaContract(
  name: string,
  perMinute: number,
  make: (clock: () => number) => { call: () => Promise<unknown> },
): void {
  describe(`quota: ${name}`, () => {
    it(`answers 429 after ${String(perMinute)} requests in a minute and recovers a minute later`, async () => {
      let now = NOW;
      const client = make(() => now);
      for (let i = 0; i < perMinute; i += 1) {
        await expect(client.call()).resolves.toBeDefined();
        now += 100;
      }
      const refused = await client.call().catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ConnectorRateLimitedError);
      expect((refused as ConnectorRateLimitedError).status).toBe(429);
      expect((refused as ConnectorRateLimitedError).retryAfterMs).toBeGreaterThan(0);
      now += 60_000;
      await expect(client.call()).resolves.toBeDefined();
    });
  });
}
