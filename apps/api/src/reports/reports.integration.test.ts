import { randomBytes } from 'node:crypto';

import { aiCostSchema, ceoViewSchema, type AiCost, type CeoView } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../testing/harness.js';
import { apiOrg, signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';
import { AiCostService } from './ai-cost.service.js';
import { CeoViewService } from './ceo-view.service.js';
import { SeedFilter } from './seed-filter.js';

// T-305a/b on the real application module and Postgres: who may read, that a KPI without data says so instead
// of reading zero, the numbers themselves, the seed-batch switch, the pluggable tiles and the exports.
const net = disableNetConnect();

let h: Harness;
let head: Persona;
let lead: Persona;
let agent: Persona;
let client: Persona;
let orgId: string;
const owner = () => h.db.owner.pool;
const run = (text: string, values: unknown[] = []) => owner().query(text, values);
const hex = () => randomBytes(32).toString('hex');

// One clock (B-009, T-183). The rows below are stamped with the database's `now()` (and the columns that
// default to it), but a report window ends at the clock of the application. A container clock that runs a
// fraction of a second ahead of the host (found at +0.33 s on Docker for Windows) put every row after the end
// of the window, so the numbers read zero. The report itself cuts days in UTC from the instant it is given,
// so the process TZ does not matter. The application clock of these tests is therefore the database clock:
// the offset is measured once and added to `Date.now()`.
let skewMs = 0;
const dbClock = () => new Date(Date.now() + skewMs);

const getCeo = async (who: Persona, days = 7) => {
  const response = await who.client.request<CeoView>(
    'GET',
    `/v1/reports/ceo?days=${String(days)}`,
    {},
  );
  expect(response.status).toBe(200);
  return ceoViewSchema.parse(response.body);
};
const getCost = async (who: Persona, query = 'days=7') => {
  const response = await who.client.request<AiCost>('GET', `/v1/reports/ai-cost?${query}`, {});
  expect(response.status).toBe(200);
  return aiCostSchema.parse(response.body);
};

beforeAll(async () => {
  h = await startHarness();
  const before = Date.now();
  const { rows: clock } = await run(
    'SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms',
  );
  skewMs = Math.round((clock[0] as { ms: number }).ms - (before + Date.now()) / 2);
  h.app.get(CeoViewService).now = dbClock;
  h.app.get(AiCostService).now = dbClock;
  head = await signIn(h, 'head');
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  orgId = (await apiOrg(lead, { name: 'Reports Org' })).id;
  client = await signIn(h, 'client', orgId);
});
afterAll(async () => {
  await h.close();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

describe('access (RBAC)', () => {
  it('lets a lead and a head read both reports, refuses an agent, a customer and a visitor', async () => {
    for (const path of ['/v1/reports/ai-cost?days=2', '/v1/reports/ceo?days=2']) {
      for (const who of [lead, head]) {
        expect((await who.client.request('GET', path, {})).status, path).toBe(200);
      }
      for (const who of [agent, client]) {
        expect((await who.client.request('GET', path, {})).status, path).toBe(403);
      }
      expect((await h.client().request('GET', path, { csrf: false })).status, path).toBe(401);
    }
  });

  it('lets only a head record, import and delete pluggable tile data', async () => {
    const body = { points: [] as unknown[] };
    for (const who of [lead, agent, client]) {
      expect((await who.client.request('POST', '/v1/reports/ceo/points', { body })).status).toBe(
        403,
      );
      expect(
        (await who.client.request('POST', '/v1/reports/ceo/points/import', { body: { csv: 'x' } }))
          .status,
      ).toBe(403);
      expect(
        (await who.client.request('DELETE', '/v1/reports/ceo/metrics/uptime', {})).status,
      ).toBe(403);
    }
  });

  it('validates the window and the list size', async () => {
    for (const bad of ['days=0', 'days=91', 'days=abc', 'days=1.5']) {
      expect(
        (await lead.client.request<ApiErrorBody>('GET', `/v1/reports/ceo?${bad}`, {})).status,
      ).toBe(400);
      expect(
        (await lead.client.request<ApiErrorBody>('GET', `/v1/reports/ai-cost?${bad}`, {})).status,
      ).toBe(400);
    }
    expect((await lead.client.request('GET', '/v1/reports/ai-cost?top=0', {})).status).toBe(400);
    expect((await lead.client.request('GET', '/v1/reports/ai-cost?top=51', {})).status).toBe(400);
  });
});

describe('a database with nothing in it', () => {
  it('CEO view: a real zero for the volume, "not available" for every other KPI', async () => {
    const view = await getCeo(head, 30);
    expect(view.kpis.volume).toEqual({
      status: 'ok',
      data: { value: 0, previous: 0, samples: 0 },
    });
    expect(view.kpis.firstResponse).toEqual({ status: 'not_available', reason: 'no_data' });
    expect(view.kpis.resolution).toEqual({ status: 'not_available', reason: 'no_data' });
    expect(view.kpis.sla).toEqual({ status: 'not_available', reason: 'no_data' });
    expect(view.kpis.csat).toEqual({ status: 'not_available', reason: 'no_data' });
    expect(view.kpis.aiHandled).toEqual({ status: 'not_available', reason: 'no_data' });
    expect(view.kpis.verifiedResolution).toEqual({
      status: 'not_available',
      reason: 'needs_grader',
    });
    expect(view.kpis.automationSavings).toEqual({ status: 'not_available', reason: 'no_data' });
    expect(view.externalTiles).toEqual([]);
    expect(view.formula).toMatchObject({ assumed: true, hours: 0, savedUsd: null, netUsd: null });
  });

  it('AI cost: zeros with a zero-filled day list, no group', async () => {
    const cost = await getCost(head, 'days=30');
    expect(cost.totals).toMatchObject({ runs: 0, costUsd: 0, unpricedRuns: 0, tickets: 0 });
    expect(cost.byDay).toHaveLength(30);
    expect(cost.byAgent).toEqual([]);
    expect(cost.byIntentOthers).toBeNull();
  });
});

describe('the numbers', () => {
  const ticket = async (fields: {
    created: string;
    responded?: string;
    resolved?: string;
    frDue?: string;
    resDue?: string;
    status?: string;
  }): Promise<string> => {
    const { rows } = await run(
      `INSERT INTO ticket (subject, org_id, channel, status, created_at, first_responded_at, resolved_at,
         first_response_due_at, resolution_due_at)
       VALUES ('reports probe', $1, 'portal', $2, ${fields.created}, ${fields.responded ?? 'NULL'},
         ${fields.resolved ?? 'NULL'}, ${fields.frDue ?? 'NULL'}, ${fields.resDue ?? 'NULL'}) RETURNING id`,
      [orgId, fields.status ?? 'open'],
    );
    return (rows[0] as { id: string }).id;
  };
  const ago = (expression: string) => `now() - interval '${expression}'`;
  const ahead = (expression: string) => `now() + interval '${expression}'`;
  let a: string;
  let b: string;
  let c: string;

  beforeAll(async () => {
    // A: answered and resolved on time, an approved AI draft, CSAT 5, a verified grade.
    a = await ticket({
      created: ago('3 hours'),
      responded: ago('150 minutes'),
      resolved: ago('1 hour'),
      frDue: ago('2 hours'),
      resDue: ahead('1 hour'),
      status: 'resolved',
    });
    // B: late on both, an edited AI draft, an assumed grade.
    b = await ticket({
      created: ago('3 hours'),
      responded: ago('2 hours'),
      resolved: ago('1 hour'),
      frDue: ago('150 minutes'),
      resDue: ago('2 hours'),
      status: 'resolved',
    });
    // C: still open, nothing due yet. One more ticket in the period before.
    c = await ticket({ created: ago('1 hour'), frDue: ahead('1 hour') });
    await ticket({ created: ago('10 days') });

    await run(
      `INSERT INTO ai_draft (ticket_id, body_text, status, disposition, edit_distance, reject_reason, resolved_at)
       VALUES ($1, 'a', 'draft', 'approved', NULL, NULL, now()),
              ($2, 'b', 'draft', 'edited', 0.4, NULL, now()),
              ($3, 'c', 'rejected', 'rejected', NULL, 'wrong_answer', now())`,
      [a, b, c],
    );
    const { rows: contacts } = await run(
      `INSERT INTO contact (org_id, name, emails) VALUES ($1, 'Probe', ARRAY['reports@example.test']) RETURNING id`,
      [orgId],
    );
    await run(
      `INSERT INTO csat_survey (ticket_id, contact_id, org_id, status, send_after, sent_at, token_expires_at,
         answered_at, score) VALUES ($1, $2, $3, 'answered', now() - interval '1 hour', now() - interval '1 hour',
         now() + interval '1 day', now() - interval '30 minutes', 5)`,
      [a, (contacts[0] as { id: string }).id, orgId],
    );
    await run(
      `INSERT INTO ai_resolution_grade (ticket_id, cycle, resolution_class, draft_verdict, draft_quality, prompt_version, mock)
       VALUES ($1, 0, 'verified', 'matches', 0.9, 1, false), ($2, 0, 'assumed', 'partial', 0.5, 1, false),
              ($3, 0, 'verified', 'matches', 0.9, 1, true)`,
      [a, b, c],
    );
    const runRow = (
      agent: string,
      ticketId: string | null,
      intent: string | null,
      cost: string | null,
    ) =>
      run(
        `INSERT INTO ai_run (started_at, agent, ticket_id, intent, provider, model, tier, prompt_id, prompt_version,
           prompt_hash, input_hmac, redaction, status, cost_usd, input_tokens, output_tokens)
         VALUES (now(), $1, $2, $3, 'mock', 'm', 'light', 'p', 1, $4, $5, '{"total":0,"byKind":{}}'::jsonb, 'ok', $6, 100, 20)`,
        [agent, ticketId, intent, hex(), hex(), cost],
      );
    await runRow('drafter', a, 'billing', '0.5');
    await runRow('drafter', b, 'billing', null);
    await runRow('classifier', a, 'password', '0.25');
    await runRow('assistant', null, null, '1.0');
  });

  it('CEO view: the KPIs and the period before', async () => {
    const view = await getCeo(head, 7);
    expect(view.kpis.volume).toEqual({ status: 'ok', data: { value: 3, previous: 1, samples: 3 } });
    if (view.kpis.firstResponse.status !== 'ok') throw new Error('first response');
    expect(view.kpis.firstResponse.data.value).toBeCloseTo(2700, -1);
    expect(view.kpis.firstResponse.data.previous).toBeNull();
    expect(view.kpis.firstResponse.data.samples).toBe(2);
    if (view.kpis.resolution.status !== 'ok') throw new Error('resolution');
    expect(view.kpis.resolution.data.value).toBeCloseTo(7200, -1);
    expect(view.kpis.sla).toEqual({
      status: 'ok',
      data: { value: 0.5, previous: null, samples: 2 },
    });
    expect(view.kpis.csat).toEqual({
      status: 'ok',
      data: { value: 5, previous: null, samples: 1 },
    });
    // Two resolved tickets, both with an AI draft a person sent; one of them unchanged.
    expect(view.kpis.aiHandled).toEqual({
      status: 'ok',
      data: { value: 1, previous: null, samples: 2 },
    });
    // The mock grade on C is not counted: one verified of two.
    expect(view.kpis.verifiedResolution).toEqual({
      status: 'ok',
      data: { value: 0.5, previous: null, samples: 2 },
    });
    expect(view.kpis.automationSavings.status).toBe('ok');
    expect(view.formula).toMatchObject({
      assumed: true,
      minutesPerTicket: 10,
      staffCostUsdPerHour: null,
      aiHandledTickets: 2,
      noTouchTickets: 1,
      savedUsd: null,
      netUsd: null,
    });
    expect(view.formula.hours).toBeCloseTo(20 / 60, 6);
    expect(view.formula.aiCostUsd).toBeCloseTo(1.75, 6);
    expect(view.formula.aiCostPerResolvedTicketUsd).toBeCloseTo(0.875, 6);
    // True exactly when the column of migration 0096 exists (it does on a migrated database).
    const { rows: column } = await run(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'ticket' AND column_name = 'seed_batch_id'`,
    );
    expect(view.seedExcluded).toBe(column.length > 0);
  });

  it('AI cost: per agent, intent, ticket and day, unpriced calls counted apart', async () => {
    const cost = await getCost(lead, 'days=7&top=10');
    expect(cost.totals).toEqual({
      runs: 4,
      inputTokens: 400,
      outputTokens: 80,
      costUsd: 1.75,
      unpricedRuns: 1,
      tickets: 2,
    });
    expect(cost.previousTotals.runs).toBe(0);
    expect(cost.byAgent.map((row) => [row.agent, row.costUsd, row.runs])).toEqual([
      ['assistant', 1, 1],
      ['drafter', 0.5, 2],
      ['classifier', 0.25, 1],
    ]);
    expect(cost.byAgent.find((row) => row.agent === 'drafter')?.unpricedRuns).toBe(1);
    expect(cost.byIntent.map((row) => [row.intent, row.costUsd])).toEqual([
      [null, 1],
      ['billing', 0.5],
      ['password', 0.25],
    ]);
    expect(cost.topTickets.map((row) => [row.ticketId, row.costUsd])).toEqual([
      [a, 0.75],
      [b, 0],
    ]);
    expect(cost.topTickets[0]?.key).toMatch(/^[A-Z][A-Z0-9]+-\d+$/);
    expect(cost.byDay).toHaveLength(7);
    expect(cost.byDay.reduce((sum, day) => sum + day.costUsd, 0)).toBeCloseTo(1.75, 6);
    expect(cost.byDay.reduce((sum, day) => sum + day.runs, 0)).toBe(4);
  });

  it('AI cost: `top` caps the intents and sums the rest', async () => {
    const cost = await getCost(lead, 'days=7&top=1');
    expect(cost.byIntent).toHaveLength(1);
    expect(cost.byIntentOthers).toMatchObject({ runs: 3, costUsd: 0.75 });
    expect(cost.topTickets).toHaveLength(1);
  });

  it('leaves out the tickets of a seed batch once the column exists, with no code change', async () => {
    const { rows: existing } = await run(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'ticket' AND column_name = 'seed_batch_id'`,
    );
    const had = existing.length > 0;
    if (!had) await run(`ALTER TABLE ticket ADD COLUMN seed_batch_id uuid`);
    try {
      const filter = h.app.get(SeedFilter);
      filter.now = () => dbClock().getTime() + 10 * 60_000;
      // Migration 0096 wants a batch row, and the ticket in an organization of the same batch.
      const { rows: batch } = await run(
        `INSERT INTO seed_batch (kind) VALUES ('e2e') RETURNING id`,
      );
      const batchId = (batch[0] as { id: string }).id;
      await run(`UPDATE organization SET seed_batch_id = $1 WHERE id = $2`, [batchId, orgId]);
      await run(`UPDATE ticket SET seed_batch_id = $1 WHERE id = $2`, [batchId, b]);
      const view = await getCeo(head, 7);
      expect(view.seedExcluded).toBe(true);
      expect(view.kpis.volume).toMatchObject({ data: { value: 2 } });
      expect(view.kpis.aiHandled).toMatchObject({ data: { value: 1, samples: 1 } });
      expect(view.kpis.verifiedResolution).toMatchObject({ data: { value: 1, samples: 1 } });
      // The AI cost of the seeded ticket is not counted either (its call was unpriced: still 1.75).
      expect(view.formula.aiCostUsd).toBeCloseTo(1.75, 6);
    } finally {
      await run(`UPDATE ticket SET seed_batch_id = NULL WHERE id = $1`, [b]).catch(() => undefined);
      await run(`UPDATE organization SET seed_batch_id = NULL WHERE id = $1`, [orgId]).catch(
        () => undefined,
      );
      if (!had) await run(`ALTER TABLE ticket DROP COLUMN seed_batch_id`);
      h.app.get(SeedFilter).forget();
    }
  });
});

describe('pluggable tiles', () => {
  it('records points, shows the newest and the one before, replaces a repeat, removes a tile', async () => {
    const point = (value: number, observedAt: string) => ({
      key: 'uptime',
      label: 'Platform uptime',
      unit: '%',
      higherIsBetter: true,
      value,
      observedAt,
    });
    const record = await head.client.request<{ imported: number }>(
      'POST',
      '/v1/reports/ceo/points',
      {
        body: {
          points: [
            point(99.9, '2026-10-01T00:00:00.000Z'),
            point(99.5, '2026-11-01T00:00:00.000Z'),
            point(99.7, '2026-11-01T00:00:00.000Z'),
          ],
        },
      },
    );
    expect(record.status).toBe(201);
    expect(record.body).toEqual({ imported: 3 });
    const view = await getCeo(head);
    expect(view.externalTiles).toEqual([
      {
        key: 'uptime',
        label: 'Platform uptime',
        unit: '%',
        higherIsBetter: true,
        value: 99.7,
        previous: 99.9,
        observedAt: '2026-11-01T00:00:00.000Z',
      },
    ]);
    const audit = await run(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'ceo.point.record'`,
    );
    expect((audit.rows[0] as { n: number }).n).toBe(1);

    expect((await head.client.request('DELETE', '/v1/reports/ceo/metrics/uptime', {})).status).toBe(
      204,
    );
    expect((await getCeo(head)).externalTiles).toEqual([]);
    expect((await head.client.request('DELETE', '/v1/reports/ceo/metrics/uptime', {})).status).toBe(
      404,
    );
  });

  it('rejects a bad key, a non-finite value and an empty list', async () => {
    const bad = (extra: Record<string, unknown>) => ({
      points: [
        { key: 'ok', label: 'L', value: 1, observedAt: '2026-11-01T00:00:00.000Z', ...extra },
      ],
    });
    for (const body of [
      bad({ key: 'Bad Key' }),
      bad({ value: 'x' }),
      bad({ label: '' }),
      { points: [] },
    ]) {
      expect((await head.client.request('POST', '/v1/reports/ceo/points', { body })).status).toBe(
        400,
      );
    }
  });

  it('imports a CSV all or nothing and names the bad line', async () => {
    const header = 'key,label,unit,higher_is_better,value,observed_at';
    const good = [
      header,
      'revenue,"Revenue, MRR",USD,true,1200.5,2026-10-01',
      'revenue,"Revenue, MRR",USD,true,1300,2026-11-01T00:00:00Z',
      'churn,Churn,%,false,2.1,2026-11-01',
    ].join('\n');
    const imported = await head.client.request<{ imported: number }>(
      'POST',
      '/v1/reports/ceo/points/import',
      { body: { csv: good } },
    );
    expect(imported.status).toBe(201);
    expect(imported.body).toEqual({ imported: 3 });
    const tiles = (await getCeo(head)).externalTiles;
    expect(
      tiles.map((tile) => [tile.key, tile.label, tile.value, tile.previous, tile.higherIsBetter]),
    ).toEqual([
      ['churn', 'Churn', 2.1, null, false],
      ['revenue', 'Revenue, MRR', 1300, 1200.5, true],
    ]);

    const broken = await head.client.request<ApiErrorBody>(
      'POST',
      '/v1/reports/ceo/points/import',
      {
        body: {
          csv: [header, 'ok1,A,,true,1,2026-11-02', 'ok2,B,,true,notanumber,2026-11-02'].join('\n'),
        },
      },
    );
    expect(broken.status).toBe(400);
    expect(JSON.stringify(broken.body)).toContain('line 3');
    const wrongHeader = await head.client.request('POST', '/v1/reports/ceo/points/import', {
      body: { csv: 'a,b\n1,2' },
    });
    expect(wrongHeader.status).toBe(400);
    const { rows } = await run(
      `SELECT count(*)::int AS n FROM ceo_external_point WHERE metric_key IN ('ok1', 'ok2')`,
    );
    expect((rows[0] as { n: number }).n).toBe(0);
  });
});

describe('export', () => {
  it('writes the CSV with formulas defused and audits the export', async () => {
    await head.client.request('POST', '/v1/reports/ceo/points', {
      body: {
        points: [
          {
            key: 'evil',
            label: '=HYPERLINK("http://x")',
            unit: '',
            higherIsBetter: true,
            value: 1,
            observedAt: '2026-11-03T00:00:00.000Z',
          },
        ],
      },
    });
    const response = await lead.client.request<string>(
      'GET',
      '/v1/reports/ceo/export?days=7&format=csv',
      {},
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="ceo-view-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const lines = response.body.split('\r\n');
    expect(lines[0]).toBe('kind,key,label,unit,value,previous,note');
    expect(lines.some((line) => line.startsWith('kpi,volume,Ticket volume,tickets,3,1,'))).toBe(
      true,
    );
    expect(lines.some((line) => line.startsWith('kpi,verifiedResolution,'))).toBe(true);
    expect(response.body).toContain(`'=HYPERLINK`);
    expect(response.body).not.toMatch(/(^|,)=HYPERLINK/m);
    const audit = await run(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'ceo.export'`);
    expect((audit.rows[0] as { n: number }).n).toBe(1);
  });

  it('writes a self-contained, escaped HTML page', async () => {
    await head.client.request('POST', '/v1/reports/ceo/points', {
      body: {
        points: [
          {
            key: 'xss',
            label: '<script>alert(1)</script>',
            unit: '',
            higherIsBetter: true,
            value: 2,
            observedAt: '2026-11-03T00:00:00.000Z',
          },
        ],
      },
    });
    const response = await head.client.request<string>(
      'GET',
      '/v1/reports/ceo/export?days=7&format=html',
      {},
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(response.body).not.toContain('<script');
    expect(response.body).toContain('Automation savings (assumption, not a measurement)');
    expect(response.body).not.toMatch(/<(link|img|iframe|script)|src=|href=/);
  });

  it('writes a PDF of the same view and audits it', async () => {
    const response = await lead.client.request(
      'GET',
      '/v1/reports/ceo/export?days=7&format=pdf',
      {},
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toMatch(/ceo-view-\d{4}-\d{2}-\d{2}\.pdf/u);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(response.bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    const audit = await run(
      `SELECT metadata FROM audit_log WHERE action = 'ceo.export' ORDER BY created_at DESC LIMIT 1`,
    );
    expect((audit.rows[0] as { metadata: { format: string } }).metadata.format).toBe('pdf');
  });

  it('refuses an agent and an unknown format', async () => {
    expect(
      (await agent.client.request('GET', '/v1/reports/ceo/export?format=csv', {})).status,
    ).toBe(403);
    expect(
      (await lead.client.request('GET', '/v1/reports/ceo/export?format=docx', {})).status,
    ).toBe(400);
  });
});
