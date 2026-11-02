import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import type { Clock } from './common/errors.js';
import { FakeDataQueryClient } from './data/fake.js';
import { FakeLogsClient } from './logs/fake.js';
import { LOG_SEVERITIES, type LogEntry } from './logs/types.js';
import { FakeMetricsClient } from './metrics/fake.js';
import { FakeRepoClient } from './repo/fake.js';
import type { DataQueryClient } from './data/types.js';
import type { LogsClient } from './logs/types.js';
import type { MetricsClient } from './metrics/types.js';
import type { RepoClient } from './repo/types.js';

/**
 * Mock mode (T-203): the four clients as fakes over one fixture file, `examples/tools/fixtures.json`
 * in a checkout. Log times and change times are given as "minutes ago" and "hours ago", so an
 * example stays inside the window an investigator asks for whenever it runs. The data in the file is
 * invented; no real company, host or person is named (N1). Nothing here opens a connection.
 */

export const mockFixturesSchema = z.object({
  logs: z
    .array(
      z.object({
        agoMinutes: z.number().int().min(0).max(10_080),
        severity: z.enum(LOG_SEVERITIES),
        service: z.string().min(1).max(100),
        message: z.string().min(1).max(600),
        labels: z.record(z.string().min(1).max(60), z.string().max(200)).default({}),
      }),
    )
    .max(500)
    .default([]),
  data: z
    .array(
      z.object({
        /** The name of the saved query template this answer stands for. */
        template: z.string().min(1).max(100),
        columns: z.array(z.string().min(1).max(60)).max(20),
        rows: z
          .array(z.array(z.union([z.string().max(200), z.number(), z.null()])).max(20))
          .max(500),
      }),
    )
    .max(100)
    .default([]),
  repo: z
    .array(
      z.object({
        repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
        changes: z
          .array(
            z.object({
              kind: z.enum(['commit', 'pull_request', 'release']),
              ref: z.string().min(1).max(100),
              title: z.string().max(300),
              author: z.string().max(100).nullable().default(null),
              agoHours: z
                .number()
                .min(0)
                .max(24 * 30),
              url: z.string().max(500).nullable().default(null),
            }),
          )
          .max(100),
      }),
    )
    .max(50)
    .default([]),
  /** Slugs of the services the fake metrics client has numbers for. Empty: every slug. */
  services: z.array(z.string().min(1).max(100)).max(100).default([]),
});
export type MockFixtures = z.infer<typeof mockFixturesSchema>;

/**
 * Reads `fixtures.json` from `dir`. A missing directory or file means "no mock data" (`undefined`),
 * so the system tools stay off; a file that does not match the schema throws, because wrong
 * fixtures would be an invented fact (N5).
 */
export function loadMockFixtures(dir: string | undefined): MockFixtures | undefined {
  if (dir === undefined || dir === '') return undefined;
  let raw: string;
  try {
    raw = readFileSync(join(dir, 'fixtures.json'), 'utf8');
  } catch {
    return undefined;
  }
  return mockFixturesSchema.parse(JSON.parse(raw));
}

export interface MockClients {
  readonly logs: LogsClient;
  readonly metrics: MetricsClient;
  readonly data: DataQueryClient;
  readonly repo: RepoClient;
}

export interface MockClientOptions {
  readonly clock?: Clock;
  /** Requests a minute each fake allows before it answers 429. 0 or absent: no quota. */
  readonly quotaPerMinute?: number;
}

export function createMockClients(
  fixtures: MockFixtures,
  options: MockClientOptions = {},
): MockClients {
  const clock = options.clock ?? Date.now;
  const quota = options.quotaPerMinute ?? 0;
  const logs = new FakeLogsClient({
    clock,
    quotaPerMinute: quota,
    entries: (now): LogEntry[] =>
      fixtures.logs.map((entry, index) => ({
        insertId: `mock-${String(index)}`,
        timestamp: new Date(now - entry.agoMinutes * 60_000).toISOString(),
        severity: entry.severity,
        service: entry.service,
        message: entry.message,
        labels: entry.labels,
      })),
  });
  const data = new FakeDataQueryClient(
    Object.fromEntries(
      fixtures.data.map((item) => [item.template, { columns: item.columns, rows: item.rows }]),
    ),
  );
  const repo = new FakeRepoClient({
    clock,
    quotaPerMinute: quota,
    changes: (now) =>
      fixtures.repo.flatMap((entry) =>
        entry.changes.map((change) => ({
          repo: entry.repo,
          kind: change.kind,
          ref: change.ref,
          title: change.title,
          author: change.author,
          at: new Date(now - change.agoHours * 3_600_000).toISOString(),
          url: change.url,
        })),
      ),
  });
  const metrics = new FakeMetricsClient({
    clock,
    quotaPerMinute: quota,
    ...(fixtures.services.length > 0 ? { services: fixtures.services } : {}),
  });
  return { logs, metrics, data, repo };
}
