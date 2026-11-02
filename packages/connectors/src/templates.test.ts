import { describe, expect, it } from 'vitest';

import { ConnectorQueryRejectedError } from './common/errors.js';
import { FakeDataQueryClient } from './data/fake.js';
import { withDataGuardrails } from './data/guard.js';
import { FakeLogsClient } from './logs/fake.js';
import {
  formatLogLine,
  formatRows,
  runDataTemplate,
  runLogsTemplate,
  templateInputParams,
  templatePlaceholders,
  validateTemplate,
} from './templates.js';

const NOW = new Date('2026-03-10T12:00:00.000Z');

describe('placeholders', () => {
  it('splits what the ticket fills from what a person types', () => {
    const body =
      'service="svc" AND labels.org={{org_id}} AND labels.session={{session_id}} AND labels.t={{ticket_id}}';
    expect(templatePlaceholders(body)).toEqual(['org_id', 'session_id', 'ticket_id']);
    expect(templateInputParams(body)).toEqual(['session_id']);
  });
});

describe('validateTemplate', () => {
  it('accepts a filter and a SELECT that can run', () => {
    expect(() => {
      validateTemplate('logs', 'service="svc" labels.org={{org_id}} severity>=WARNING');
    }).not.toThrow();
    expect(() => {
      validateTemplate('data', 'SELECT day, requests FROM api_daily WHERE tenant_id = {{org_id}}');
    }).not.toThrow();
  });

  it.each([
    ['logs', 'nope="x"'],
    ['logs', 'service="open'],
    ['logs', 'service={{OrgId}}'],
    ['data', 'DELETE FROM t'],
    ['data', "SELECT * FROM EXTERNAL_QUERY('c', 'SELECT 1')"],
    ['data', 'SELECT {{a}}; SELECT 2'],
  ] as const)('refuses a %s body that could never run: %s', (kind, body) => {
    expect(() => {
      validateTemplate(kind, body);
    }).toThrow(ConnectorQueryRejectedError);
  });
});

describe('runLogsTemplate', () => {
  const entry = (minutes: number, org: string) => ({
    insertId: `${org}-${String(minutes)}`,
    timestamp: new Date(NOW.getTime() - minutes * 60_000).toISOString(),
    severity: 'ERROR' as const,
    service: 'svc',
    message: 'failed',
    labels: { org },
  });

  it('asks only for the organization of the ticket, inside the window', async () => {
    const client = new FakeLogsClient({ entries: [entry(5, 'a'), entry(6, 'b'), entry(90, 'a')] });
    const run = await runLogsTemplate(client, {
      body: 'labels.org={{org_id}}',
      params: { org_id: 'a' },
      window: { now: NOW, windowMinutes: 60 },
      limit: 10,
    });
    expect(run.entries.map((e) => e.insertId)).toEqual(['a-5']);
    expect(run.hasMore).toBe(false);
    expect(client.queries[0]?.filter).toBe('labels.org="a"');
    expect(run.to).toEqual(NOW);
    expect(run.from).toEqual(new Date('2026-03-10T11:00:00.000Z'));
    expect(formatLogLine(run.entries[0] ?? entry(0, 'x'))).toBe(
      '2026-03-10T11:55:00.000Z ERROR svc: failed',
    );
  });

  it('cannot be talked into another organization by a value', async () => {
    const client = new FakeLogsClient({ entries: [entry(5, 'a'), entry(6, 'b')] });
    await expect(
      runLogsTemplate(client, {
        body: 'labels.org={{org_id}}',
        params: { org_id: 'a" OR labels.org="b' },
        window: { now: NOW, windowMinutes: 60 },
        limit: 10,
      }),
    ).rejects.toBeInstanceOf(ConnectorQueryRejectedError);
    expect(client.queries).toHaveLength(0);
  });
});

describe('runDataTemplate', () => {
  it('binds, runs through the guard and formats the rows', async () => {
    const inner = new FakeDataQueryClient({
      weekly: {
        columns: ['day', 'who'],
        rows: [
          ['2026-03-09', 'x@example.com'],
          ['2026-03-08', 'y@example.com'],
        ],
      },
    });
    const client = withDataGuardrails(inner, { allowColumns: new Set(['day']) });
    const result = await runDataTemplate(client, {
      name: 'weekly',
      body: 'SELECT day, who FROM t WHERE tenant = {{org_id}}',
      params: { org_id: 'o-1' },
      maxRows: 10,
      timeoutMs: 1000,
    });
    expect(inner.queries[0]).toMatchObject({
      label: 'weekly',
      sql: 'SELECT day, who FROM t WHERE tenant = $1',
      params: ['o-1'],
    });
    expect(formatRows(result, 10)).toBe('day | who\n2026-03-09 | -\n2026-03-08 | -');
  });
});
