import { randomBytes, randomUUID } from 'node:crypto';

import { HEALTH_WEIGHTS_V1, metricTemplateProblem } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { mintStatusLink, newStatusNonce, verifyStatusLink } from '../statuspage/links.js';
import { dimsHash } from './dims.js';
import { isAnomalous, anomalyDedupeKey } from './anomaly.js';
import { scoreHealth, type HealthFacts } from './health.js';
import { cleanDimValue, parseUsageRows } from './rows.js';

const base = {
  observed: 100,
  baseline: 10,
  samples: 7,
  hasHistory: true,
  ratio: 3,
  minAbs: 10,
  direction: 'up',
} as const;

describe('the anomaly rule', () => {
  it('fires on a rise that is both more than ratio times the baseline and more than minAbs above it', () => {
    expect(isAnomalous(base)).toBe(true);
    expect(isAnomalous({ ...base, observed: 30 })).toBe(false); // exactly 3x: not more than
    expect(isAnomalous({ ...base, observed: 31 })).toBe(true);
    // A rise from 1 to 4 is more than 3x but not news.
    expect(isAnomalous({ ...base, baseline: 1, observed: 4, minAbs: 10 })).toBe(false);
  });

  it('does not fire without a week of history or enough same-hour samples', () => {
    expect(isAnomalous({ ...base, hasHistory: false })).toBe(false);
    expect(isAnomalous({ ...base, samples: 2 })).toBe(false);
    expect(isAnomalous({ ...base, samples: 3 })).toBe(true);
  });

  it('mirrors for a metric whose drop is the problem', () => {
    const down = { ...base, direction: 'down', baseline: 100, observed: 20, minAbs: 50 } as const;
    expect(isAnomalous(down)).toBe(true);
    expect(isAnomalous({ ...down, observed: 40 })).toBe(false); // 40 > 100/3
    expect(isAnomalous({ ...down, baseline: 40, observed: 5, minAbs: 50 })).toBe(false); // too small a drop
    expect(isAnomalous({ ...down, observed: 500 })).toBe(false); // a rise is not a drop
  });

  it('names one anomaly per series and UTC day', () => {
    const metric = randomUUID();
    const hash = dimsHash({ org: randomUUID() });
    const morning = anomalyDedupeKey(metric, hash, new Date('2030-05-01T03:00:00Z'));
    expect(anomalyDedupeKey(metric, hash, new Date('2030-05-01T23:00:00Z'))).toBe(morning);
    expect(anomalyDedupeKey(metric, hash, new Date('2030-05-02T00:00:00Z'))).not.toBe(morning);
    expect(
      anomalyDedupeKey(metric, dimsHash({ org: randomUUID() }), new Date('2030-05-01T03:00:00Z')),
    ).not.toBe(morning);
  });
});

describe('the Client Health Score formula v1', () => {
  const facts: HealthFacts = {
    ageDays: 90,
    tickets: { recent: 1, prior: 12, priorWeekly: 3 },
    sla: { tickets: 13, breached: 3 },
    csat: { answers: 3, average: 5 },
    incidents: 0,
    hasUsageData: false,
    anomalies: 0,
  };

  it('weights add up to one', () => {
    expect(Object.values(HEALTH_WEIGHTS_V1).reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(
      1,
      10,
    );
  });

  it('scores from the parts that have data and re-weights them', () => {
    const result = scoreHealth(facts);
    expect(result.status).toBe('scored');
    // volume 100, sla 53.8, csat 100, incidents 100; usage anomalies have no data.
    expect(result.score).toBe(84);
    expect(result.components.find((c) => c.key === 'usage_anomalies')).toMatchObject({
      status: 'no_data',
      score: null,
    });
    expect(result.components.map((c) => c.key)).toEqual([
      'ticket_volume',
      'sla',
      'csat',
      'incidents',
      'usage_anomalies',
    ]);
  });

  it('says there is not enough data instead of inventing a score (N5)', () => {
    const young = scoreHealth({
      ...facts,
      ageDays: 3,
      tickets: { recent: 0, prior: 0, priorWeekly: 0 },
      sla: { tickets: 1, breached: 0 },
      csat: { answers: 0, average: null },
    });
    expect(young).toMatchObject({ status: 'insufficient_data', score: null });
    expect(young.components.every((c) => c.status === 'no_data')).toBe(true);
    // Only the SLA (0.3) speaks: under half of the weights.
    const thin = scoreHealth({
      ...facts,
      ageDays: 3,
      tickets: { recent: 0, prior: 0, priorWeekly: 0 },
      csat: { answers: 1, average: 5 },
    });
    expect(thin.status).toBe('insufficient_data');
  });

  it('lowers the score for breaches, incidents, anomalies and a volume spike', () => {
    const worse = scoreHealth({
      ...facts,
      tickets: { recent: 12, prior: 12, priorWeekly: 3 },
      sla: { tickets: 10, breached: 5 },
      csat: { answers: 4, average: 2 },
      incidents: 3,
      hasUsageData: true,
      anomalies: 2,
    });
    expect(worse.status).toBe('scored');
    expect(worse.score).toBeLessThan(40);
    expect(worse.components.find((c) => c.key === 'ticket_volume')?.score).toBe(0);
    expect(worse.components.find((c) => c.key === 'sla')?.score).toBe(0);
  });
});

describe('reading the answer of a template', () => {
  const window = { from: new Date('2030-05-01T00:00:00Z'), to: new Date('2030-05-01T05:30:00Z') };
  const org = randomUUID();
  const keep = (value: string): string => value;
  const parse = (
    result: Parameters<typeof parseUsageRows>[0],
    dims: string[] = ['org', 'flow'],
    sanitize = keep,
    max = 100,
  ) => parseUsageRows(result, { dims }, window, sanitize, max);
  const row = (extra: Record<string, unknown> = {}) => ({
    ts: new Date('2030-05-01T02:00:00Z'),
    value: '12.5',
    org,
    flow: 'checkout',
    ...extra,
  });

  it('turns rows into points with the organization split out', () => {
    const outcome = parse({
      columns: ['ts', 'value', 'org', 'flow'],
      rows: [row()],
      truncated: false,
    });
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    expect(outcome.points[0]).toMatchObject({
      orgId: org,
      dims: { flow: 'checkout' },
      value: 12.5,
    });
    expect(outcome.points[0]?.dimsHash).toBe(dimsHash({ flow: 'checkout', org }));
  });

  it('refuses an extra column, a missing column, a stray key in a row', () => {
    expect(
      parse({ columns: ['ts', 'value', 'org', 'flow', 'email'], rows: [], truncated: false }),
    ).toEqual({ ok: false, code: 'extra_column' });
    expect(parse({ columns: ['ts', 'value', 'org'], rows: [], truncated: false })).toEqual({
      ok: false,
      code: 'missing_column',
    });
    expect(
      parse({
        columns: ['ts', 'value', 'org', 'flow'],
        rows: [row({ email: 'a@b.test' })],
        truncated: false,
      }),
    ).toEqual({ ok: false, code: 'extra_column' });
  });

  it('refuses a bucket that is not an hour inside the window, a value that is not finite, a bad organization', () => {
    const columns = ['ts', 'value', 'org', 'flow'];
    expect(
      parse({ columns, rows: [row({ ts: new Date('2030-05-01T02:30:00Z') })], truncated: false }),
    ).toEqual({ ok: false, code: 'bad_bucket' });
    expect(
      parse({ columns, rows: [row({ ts: new Date('2030-04-30T23:00:00Z') })], truncated: false }),
    ).toEqual({ ok: false, code: 'bad_bucket' });
    expect(parse({ columns, rows: [row({ value: 'NaN' })], truncated: false })).toEqual({
      ok: false,
      code: 'bad_row',
    });
    expect(parse({ columns, rows: [row({ value: Infinity })], truncated: false })).toEqual({
      ok: false,
      code: 'bad_row',
    });
    expect(parse({ columns, rows: [row({ org: 'not-a-uuid' })], truncated: false })).toEqual({
      ok: false,
      code: 'bad_row',
    });
    // The same series and hour twice: the template must group.
    expect(parse({ columns, rows: [row(), row()], truncated: false })).toEqual({
      ok: false,
      code: 'bad_row',
    });
  });

  it('refuses an answer that was cut or is longer than the cap', () => {
    const columns = ['ts', 'value', 'org', 'flow'];
    expect(parse({ columns, rows: [], truncated: true })).toEqual({ ok: false, code: 'truncated' });
    const many = Array.from({ length: 3 }, (_, i) => row({ flow: `f${String(i)}` }));
    expect(parse({ columns, rows: many, truncated: false }, ['org', 'flow'], keep, 2)).toEqual({
      ok: false,
      code: 'too_many_rows',
    });
  });

  it('passes dimension values through the sanitizer, whole or not at all', () => {
    const redact = (value: string): string => value.replace(/\S+@\S+/g, '[EMAIL_1]');
    expect(cleanDimValue('checkout', redact)).toBe('checkout');
    expect(cleanDimValue('alice@example.test', redact)).toBe('[redacted]');
    expect(cleanDimValue('see alice@example.test please', redact)).toBe('[redacted]');
    expect(cleanDimValue(null, redact)).toBe('');
    expect(cleanDimValue('x'.repeat(500), redact)).toHaveLength(100);
    // An email that straddles the cut is found, because the whole value is redacted before it is cut.
    const straddling = `${'x'.repeat(90)}victim@example.test`;
    expect(cleanDimValue(straddling, redact)).toBe('[redacted]');
    expect(cleanDimValue('y'.repeat(5000), redact)).toBe('[redacted]');
    const outcome = parse(
      {
        columns: ['ts', 'value', 'org', 'flow'],
        rows: [row({ flow: 'bob@example.test' })],
        truncated: false,
      },
      ['org', 'flow'],
      redact,
    );
    expect(outcome.ok && outcome.points[0]?.dims).toEqual({ flow: '[redacted]' });
  });
});

describe('metric templates', () => {
  it('accepts one SELECT with the window bound as $1 and $2', () => {
    expect(
      metricTemplateProblem(
        "SELECT date_trunc('hour', t) AS ts, 1 AS value FROM x WHERE t >= $1 AND t < $2",
      ),
    ).toBeNull();
    expect(metricTemplateProblem('WITH a AS (SELECT 1) SELECT * FROM a WHERE $1 < $2;')).toBeNull();
    // Notes at the top do not count as code, so a note about a drop or an update is fine.
    expect(
      metricTemplateProblem(
        '-- A drop is the problem; update daily\n/* $9 */\nSELECT 1 WHERE $1 < $2',
      ),
    ).toBeNull();
    expect(
      metricTemplateProblem(
        '-- A drop is the problem, update daily\n/* note */\nSELECT 1 WHERE $1 < $2',
      ),
    ).toBeNull();
  });

  it('refuses writes, a second statement, a missing window and any other parameter', () => {
    expect(metricTemplateProblem('DELETE FROM x WHERE a >= $1 AND b < $2')).not.toBeNull();
    expect(metricTemplateProblem('SELECT 1 WHERE $1 < $2; DROP TABLE x')).not.toBeNull();
    expect(metricTemplateProblem('SELECT 1 WHERE $1 < $2 AND (SELECT 1) = 1 -- ok')).toBeNull();
    // A "--" inside a string is not a comment: what follows on the line is still code.
    expect(
      metricTemplateProblem(
        "SELECT 1 WHERE $1 < $2 AND a = '--' OR EXISTS (WITH d AS (DELETE FROM t RETURNING 1) SELECT 1 FROM d)",
      ),
    ).toBe('The template contains a statement that writes');
    expect(metricTemplateProblem("SELECT '--' WHERE $1 < $2\n; DROP TABLE x")).toBe(
      'Only one statement is allowed',
    );
    expect(metricTemplateProblem("SELECT 'it''s; fine' WHERE $1 < $2")).toBeNull();
    // Quotes and notes that cannot be read with confidence, and dollar quoting, are refused.
    expect(metricTemplateProblem("SELECT 'open WHERE $1 < $2")).not.toBeNull();
    expect(metricTemplateProblem('SELECT 1 /* open WHERE $1 < $2')).not.toBeNull();
    expect(metricTemplateProblem(String.raw`SELECT E'\'' WHERE $1 < $2`)).not.toBeNull();
    expect(metricTemplateProblem('SELECT $x$ text $x$ WHERE $1 < $2')).not.toBeNull();
    expect(metricTemplateProblem('SELECT 1 FROM x')).not.toBeNull();
    expect(metricTemplateProblem('SELECT 1 WHERE $1 < $2 AND a = $3')).not.toBeNull();
    expect(metricTemplateProblem('SELECT 1 WHERE $1 < $1')).not.toBeNull();
    expect(metricTemplateProblem('UPDATE x SET a = 1 WHERE $1 < $2')).not.toBeNull();
    expect(metricTemplateProblem('   ')).not.toBeNull();
  });
});

describe('subscription links', () => {
  const key = randomBytes(32);
  it('round-trips and rejects forgery, damage and another key', () => {
    const id = randomUUID();
    const nonce = newStatusNonce();
    const token = mintStatusLink(key, 'confirm', id, nonce);
    expect(verifyStatusLink(key, token)).toEqual({ purpose: 'confirm', subscriptionId: id, nonce });
    expect(verifyStatusLink(randomBytes(32), token)).toBeNull();
    expect(
      verifyStatusLink(key, token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')),
    ).toBeNull();
    expect(verifyStatusLink(key, token.replace('.c.', '.u.'))).toBeNull();
    expect(verifyStatusLink(key, 'nonsense')).toBeNull();
    expect(mintStatusLink(key, 'unsubscribe', id, nonce)).not.toBe(token);
    // Deterministic: the worker derives the very same link whenever it sends.
    expect(mintStatusLink(key, 'confirm', id, nonce)).toBe(token);
  });
});
