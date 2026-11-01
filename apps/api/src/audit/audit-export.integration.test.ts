import { AUDIT_EXPORT_COLUMNS, type AuditLogEntry } from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOrg, startHarness, type Harness } from '../testing/harness.js';
import { signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';

// T-127: the audit log filter by actor type, and the CSV export (head only, no personal fields,
// rate limited, audited).

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let client: Persona;

const owner = () => h.db.owner.pool;
const HEADER = AUDIT_EXPORT_COLUMNS.join(',');

beforeAll(async () => {
  h = await startHarness();
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  client = await signIn(h, 'client', await createOrg(owner()));
  // Rows of every kind of actor, with the personal fields the export must leave out.
  await owner().query(
    `INSERT INTO audit_log (actor_type, actor_id, action, outcome, target_type, target_id, ip, request_id, before, after, metadata)
     VALUES
       ('system', NULL, 'export.test.job', 'success', 'job', 'j-1', '203.0.113.7', 'req-system',
        '{"email":"private.before@example.com"}', '{"email":"private.after@example.com"}', '{"note":"private-metadata"}'),
       ('ai', 'ai-run-1', 'export.test.ai', 'success', 'ticket', 't-1', '203.0.113.8', 'req-ai', NULL, NULL, '{}'),
       ('anonymous', NULL, 'export.test.anon', 'denied', NULL, NULL, '203.0.113.9', NULL, NULL, NULL, '{}'),
       ('user', '=HYPERLINK("http://evil.example")', 'export.test.formula', 'failure', 'x,y', 'say "hi"', NULL, NULL, NULL, NULL, '{}')`,
  );
});
afterAll(async () => {
  await h.close();
});

const search = (who: Persona, query: string) =>
  who.client.get<{ entries: AuditLogEntry[]; nextCursor: string | null } & ApiErrorBody>(
    `/v1/audit-logs?${query}`,
  );
/** Each head has its own export allowance, so a test signs in a new one rather than spend a shared one. */
const freshHead = (): Promise<Persona> => signIn(h, 'head');
const exportCsv = (who: Persona, query = '') =>
  who.client.get<string & ApiErrorBody>(`/v1/audit-logs/export${query === '' ? '' : `?${query}`}`);

describe('GET /v1/audit-logs?actorType=', () => {
  it('shows only entries of that kind of actor', async () => {
    for (const [type, action] of [
      ['system', 'export.test.job'],
      ['ai', 'export.test.ai'],
      ['anonymous', 'export.test.anon'],
    ] as const) {
      const response = await search(head, `actorType=${type}&action=${action}`);
      expect(response.status).toBe(200);
      expect(response.body.entries.map((entry) => entry.actorType)).toEqual([type]);
    }
    const onlyAi = await search(head, 'actorType=ai');
    expect(onlyAi.body.entries.length).toBeGreaterThan(0);
    expect(onlyAi.body.entries.every((entry) => entry.actorType === 'ai')).toBe(true);
  });

  it('combines with the other filters and rejects an unknown kind', async () => {
    const none = await search(head, 'actorType=ai&action=export.test.job');
    expect(none.body.entries).toEqual([]);
    expect((await search(head, 'actorType=robot')).status).toBe(400);
  });
});

describe('GET /v1/audit-logs/export', () => {
  it('returns a CSV attachment with the fixed columns and the filtered rows', async () => {
    const response = await exportCsv(await freshHead(), 'action=export.test.ai');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(response.headers.get('cache-control')).toContain('no-store');
    const lines = response.body.split('\r\n');
    expect(lines[0]).toBe(HEADER);
    expect(lines[1]).toMatch(
      /^[0-9a-f-]{36},\d{4}-\d{2}-\d{2}T.*Z,ai,ai-run-1,export\.test\.ai,success,ticket,t-1,req-ai$/,
    );
    expect(lines[2]).toBe('');
  });

  it('filters like the search: by actor type, outcome and date', async () => {
    const system = await exportCsv(await freshHead(), 'actorType=system&action=export.test.job');
    expect(system.body.split('\r\n').filter((line) => line !== '')).toHaveLength(2);
    const denied = await exportCsv(await freshHead(), 'outcome=denied&action=export.test.anon');
    expect(denied.body).toContain(',anonymous,');
    const future = await exportCsv(await freshHead(), 'from=2999-01-01T00:00:00.000Z');
    expect(future.body).toBe(`${HEADER}\r\n`);
  });

  it('carries no IP address, no before/after and no metadata', async () => {
    const response = await exportCsv(await freshHead(), 'action=export.test.job');
    for (const secret of [
      '203.0.113.7',
      'private.before@example.com',
      'private.after@example.com',
      'private-metadata',
    ]) {
      expect(response.body).not.toContain(secret);
    }
    expect(HEADER.split(',')).toEqual([
      'id',
      'createdAt',
      'actorType',
      'actorId',
      'action',
      'outcome',
      'targetType',
      'targetId',
      'requestId',
    ]);
  });

  it('defuses formulas and quotes awkward values', async () => {
    const response = await exportCsv(await freshHead(), 'action=export.test.formula');
    const line = response.body.split('\r\n')[1] ?? '';
    // actorId starts with "=": defused with an apostrophe and quoted (it has quotes and a comma).
    expect(line).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
    expect(line).toContain('"x,y"');
    expect(line).toContain('"say ""hi"""');
  });

  it('reads a large log in batches without losing or repeating a row, and honours maxRows', async () => {
    await owner().query(
      `INSERT INTO audit_log (actor_type, action, created_at)
       SELECT 'system', 'export.test.bulk', now() - make_interval(secs => g) FROM generate_series(1, 1205) AS g`,
    );
    const all = await exportCsv(await freshHead(), 'action=export.test.bulk');
    const rows = all.body
      .split('\r\n')
      .filter((line) => line !== '')
      .slice(1);
    expect(rows).toHaveLength(1205);
    expect(new Set(rows.map((row) => row.split(',')[0])).size).toBe(1205);

    const capped = await exportCsv(await freshHead(), 'action=export.test.bulk&maxRows=1100');
    expect(capped.body.split('\r\n').filter((line) => line !== '')).toHaveLength(1101);
    expect((await exportCsv(await freshHead(), 'maxRows=0')).status).toBe(400);
    expect((await exportCsv(await freshHead(), 'maxRows=50001')).status).toBe(400);
  });

  it('is for the head: a lead, an agent and a client are refused; nobody signed in gets 401', async () => {
    for (const who of [lead, agent, client]) {
      expect((await exportCsv(who)).status).toBe(403);
    }
    expect((await h.client().get('/v1/audit-logs/export')).status).toBe(401);
  });

  it('puts every export on the audit log with its filters and the number of rows', async () => {
    const mine = await signIn(h, 'head');
    expect((await exportCsv(mine, 'action=export.test.ai&actorType=ai')).status).toBe(200);
    const rows = await owner().query<{
      actor_id: string;
      outcome: string;
      target_type: string;
      metadata: { filters: Record<string, unknown>; rowCount: number; maxRows: number };
    }>(
      `SELECT actor_id, outcome, target_type, metadata FROM audit_log
        WHERE action = 'audit.log.export' AND actor_id = $1`,
      [mine.userId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      outcome: 'success',
      target_type: 'audit_log',
      metadata: {
        filters: { action: 'export.test.ai', actorType: 'ai' },
        rowCount: 1,
        maxRows: 50_000,
      },
    });
  });

  it('is limited to 6 exports an hour per person, answers 429 with Retry-After, and audits the refusal', async () => {
    const busy = await signIn(h, 'head');
    for (let i = 0; i < 6; i += 1) {
      expect((await exportCsv(busy, 'action=export.test.ai')).status, `export ${String(i)}`).toBe(
        200,
      );
    }
    const refused = await exportCsv(busy, 'action=export.test.ai');
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);

    const outcomes = await owner().query<{ outcome: string; n: number }>(
      `SELECT outcome, count(*)::int AS n FROM audit_log
        WHERE action = 'audit.log.export' AND actor_id = $1 GROUP BY outcome ORDER BY outcome`,
      [busy.userId],
    );
    expect(outcomes.rows).toEqual([
      { outcome: 'failure', n: 1 },
      { outcome: 'success', n: 6 },
    ]);
    // Someone else is not held back by it.
    expect((await exportCsv(await freshHead(), 'action=export.test.ai')).status).toBe(200);
  });
});
