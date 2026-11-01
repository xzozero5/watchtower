import { randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import { AI_JOBS, QUEUE_NAMES, USAGE_AUDIT_ACTIONS, type CreateMetric } from '@watchtower/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addOrg, addStaff, auditRows, startDomainTest } from '../testing/support.js';
import type { DomainTestEnv } from '../testing/support.js';
import {
  fixedDataPort,
  loadExampleMetrics,
  loadProductMock,
  pgDataPort,
} from '../testing/usage.js';
import type { Actor } from '../types.js';
import type { RunUsageOptions, UsageDataResult } from './run.js';

// T-205 on a real Postgres. The product data is the seeded stand-in schema of examples/metrics, read by a
// read-only test double of the T-203 client; the second organization has an anomaly in the last complete hour.
let env: DomainTestEnv;
let head: { id: string; actor: Actor };
let orgA: { id: string; name: string };
let orgB: { id: string; name: string };
const SYSTEM: Actor = { type: 'system', id: null };
const owner = () => env.db.owner.db;
const keep = (value: string): string => value;

beforeAll(async () => {
  env = await startDomainTest();
  head = await addStaff(env, 'head');
  orgA = await addOrg(env, { name: 'Alpha Customer' });
  orgB = await addOrg(env, { name: 'Bravo Customer' });
  await loadProductMock(env.db.owner.pool, [orgA.id, orgB.id]);
});
afterAll(async () => {
  await env.close();
});

const create = (definition: CreateMetric): Promise<string> =>
  env
    .tx((tx) => env.domain.usage.createMetric(tx, env.ctx(head.actor), definition))
    .then((result) => result.value.id);

const run = (
  id: string,
  options: Partial<RunUsageOptions> & Pick<RunUsageOptions, 'port'>,
  force = true,
) =>
  env.domain.usage.run(env.database.db, env.ctx(SYSTEM), { sanitizeDim: keep, ...options }, id, force);

const pointCount = async (id: string): Promise<number> =>
  (
    await owner()
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.usageMetricPoint)
      .where(eq(schema.usageMetricPoint.metricId, id))
  )[0]?.n ?? 0;

/** Fixed rows for an hour offset from the last complete hour, for a stand-in port. */
const hourly = (from: Date, to: Date, valueOf: (ts: Date, index: number) => number | null) => {
  const rows: Record<string, unknown>[] = [];
  const start = Math.ceil(from.getTime() / 3_600_000) * 3_600_000;
  for (let t = start, i = 0; t <= to.getTime(); t += 3_600_000, i += 1) {
    const value = valueOf(new Date(t), i);
    if (value !== null) rows.push({ ts: new Date(t), value });
  }
  return rows;
};

describe('the starter metrics on the seeded stand-in product schema', () => {
  let failedId = '';
  const port = () => pgDataPort(env.db.owner.pool);

  it('reads the window, writes the points, and a second run over the same window changes nothing', async () => {
    const definitions = await loadExampleMetrics();
    const failed = definitions.find((d) => d.key === 'failed_steps_per_org_hour');
    if (failed === undefined) throw new Error('example metric missing');
    failedId = await create(failed);

    expect(await run(failedId, { port: port() }, false)).toMatchObject({ state: 'ok' });
    const first = await pointCount(failedId);
    expect(first).toBeGreaterThan(2 * 2 * 24 * 7); // two orgs x two steps x a week of hours
    // Not due yet by the database clock (the interval is an hour): a plain tick leaves it alone.
    expect(await run(failedId, { port: port() }, false)).toEqual({ state: 'not_due' });
    // Forced over the same window (a refresh window now): the same series, nothing doubled.
    expect(await run(failedId, { port: port() })).toMatchObject({ state: 'ok' });
    expect(await pointCount(failedId)).toBe(first);

    const [def] = await owner().select().from(schema.usageMetricDef).where(eq(schema.usageMetricDef.id, failedId));
    expect(def).toMatchObject({ lastRunState: 'ok', lastRunError: null });
    expect(def?.lastRunAt).toBeInstanceOf(Date);
  });

  it('stored the organization as a column and the other dimensions as declared', async () => {
    const [point] = await owner()
      .select()
      .from(schema.usageMetricPoint)
      .where(eq(schema.usageMetricPoint.metricId, failedId))
      .limit(1);
    expect([orgA.id, orgB.id]).toContain(point?.orgId);
    expect(Object.keys(point?.dims as Record<string, string>).toSorted()).toEqual(['flow', 'step']);
  });

  it('opened exactly one alert and one internal ticket, for the organization with the anomaly, once', async () => {
    const anomalies = await owner().select().from(schema.usageAnomaly).where(eq(schema.usageAnomaly.metricId, failedId));
    expect(anomalies).toHaveLength(1);
    const anomaly = anomalies[0];
    expect(anomaly).toMatchObject({ orgId: orgB.id });
    expect(anomaly?.observed).toBeGreaterThan((anomaly?.baseline ?? 0) * 3);
    expect(anomaly?.baselineSamples).toBe(7);

    const [alert] = await owner().select().from(schema.alert).where(eq(schema.alert.id, anomaly?.alertId ?? randomUUID()));
    expect(alert).toMatchObject({ source: 'usage_anomaly', severity: 'warning', state: 'open' });
    // The alert goes to chat: it names the metric and never the organization.
    expect(`${alert?.title ?? ''} ${alert?.summary ?? ''} ${JSON.stringify(alert?.payload)}`).not.toContain('Bravo');
    expect(alert?.title).toContain('Failed steps per organization');

    const [ticket] = await owner().select().from(schema.ticket).where(eq(schema.ticket.id, anomaly?.ticketId ?? randomUUID()));
    expect(ticket).toMatchObject({ channel: 'internal', orgId: orgB.id, status: 'new', channelAccountId: null });
    const messages = await owner().select().from(schema.message).where(eq(schema.message.ticketId, ticket?.id ?? ''));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ direction: 'internal', visibility: 'internal' });

    // The T-108 pipeline is asked for a brief through the outbox; nothing is sent to anyone.
    const jobs = (await owner().select().from(schema.outbox)).filter(
      (row) => row.queue === QUEUE_NAMES.ai && row.jobName === AI_JOBS.summarize && row.jobId.includes(ticket?.id ?? ''),
    );
    expect(jobs).toHaveLength(1);
    const outbound = await owner().select().from(schema.outboundDelivery);
    expect(outbound.filter((row) => row.messageId === messages[0]?.id)).toHaveLength(0);

    // Another run sees the same hour and opens nothing new.
    expect(await run(failedId, { port: port() })).toMatchObject({ state: 'ok', anomalies: 0 });
    expect(await owner().select().from(schema.usageAnomaly).where(eq(schema.usageAnomaly.metricId, failedId))).toHaveLength(1);
    expect((await owner().select().from(schema.ticket)).filter((t) => t.channel === 'internal')).toHaveLength(1);
    const audit = (await auditRows(env, USAGE_AUDIT_ACTIONS.anomalyDetect)).filter((row) => row.targetId === anomaly?.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: 'system' });
  });

  it('the other starter metrics run on the same data and the latency one has no organization', async () => {
    const definitions = await loadExampleMetrics();
    for (const key of ['transactions_per_org_hour', 'p95_latency_per_flow_hour']) {
      const definition = definitions.find((d) => d.key === key);
      if (definition === undefined) throw new Error('example metric missing');
      const id = await create(definition);
      expect(await run(id, { port: port() })).toMatchObject({ state: 'ok' });
      expect(await pointCount(id)).toBeGreaterThan(24 * 7);
    }
    const [latency] = await owner().select().from(schema.usageMetricPoint)
      .innerJoin(schema.usageMetricDef, eq(schema.usageMetricDef.id, schema.usageMetricPoint.metricId))
      .where(eq(schema.usageMetricDef.key, 'p95_latency_per_flow_hour')).limit(1);
    expect(latency?.usage_metric_point.orgId).toBeNull();
    // Dropping transactions is not what happened: no anomaly for the 'down' metric.
    expect(await owner().select().from(schema.usageAnomaly)).toHaveLength(1);
  });
});

describe('what a run refuses', () => {
  const metric = (key: string, dims: string[]): CreateMetric => ({
    key,
    name: `Metric ${key}`,
    description: '',
    sqlTemplate: 'SELECT 1 WHERE $1 < $2',
    dims,
    unit: 'count',
    refreshIntervalSeconds: 3600,
    direction: 'up',
    anomalyRatio: 3,
    anomalyMinAbs: 10,
    active: true,
  });

  it('writes nothing and records a stable code for an extra column, a missing one or a cut answer', async () => {
    const id = await create(metric('refusals', ['flow']));
    const cases: readonly [UsageDataResult, string][] = [
      [{ columns: ['ts', 'value', 'flow', 'email'], rows: [], truncated: false }, 'extra_column'],
      [{ columns: ['ts', 'value'], rows: [], truncated: false }, 'missing_column'],
      [{ columns: ['ts', 'value', 'flow'], rows: [], truncated: true }, 'truncated'],
    ];
    for (const [answer, code] of cases) {
      expect(await run(id, { port: fixedDataPort(() => answer) })).toEqual({ state: 'failed', code });
      const [def] = await owner().select().from(schema.usageMetricDef).where(eq(schema.usageMetricDef.id, id));
      expect(def).toMatchObject({ lastRunState: 'failed', lastRunError: code });
    }
    expect(await pointCount(id)).toBe(0);
    const failing = new Error('connection refused to db.internal.example:5432');
    const down = { query: () => Promise.reject(failing) };
    expect(await run(id, { port: down })).toEqual({ state: 'failed', code: 'port_unavailable' });
    // The text of the error reached neither the metric nor the audit log.
    const rows = JSON.stringify([
      await owner().select().from(schema.usageMetricDef).where(eq(schema.usageMetricDef.id, id)),
      await auditRows(env, USAGE_AUDIT_ACTIONS.metricRun),
    ]);
    expect(rows).not.toContain('db.internal.example');
  });

  it('binds the window as parameters and never changes the SQL it was given', async () => {
    const id = await create(metric('binding', []));
    const port = fixedDataPort(() => ({ columns: ['ts', 'value'], rows: [], truncated: false }));
    await run(id, { port });
    expect(port.requests).toHaveLength(1);
    expect(port.requests[0]?.sql).toBe('SELECT 1 WHERE $1 < $2');
    const [from, to] = port.requests[0]?.params ?? [];
    expect(from).toBeInstanceOf(Date);
    expect((to?.getTime() ?? 0) - (from?.getTime() ?? 0)).toBeGreaterThan(7 * 24 * 3_600_000);
  });

  it('stores a dimension value that holds personal data as a fixed marker, not as the data', async () => {
    const id = await create(metric('pii_dim', ['flow']));
    const port = fixedDataPort((request) => ({
      columns: ['ts', 'value', 'flow'],
      rows: hourly(request.params[0], request.params[1], () => 1).map((row) => ({ ...row, flow: 'alice@customer.example' })),
      truncated: false,
    }));
    expect(await run(id, { port, sanitizeDim: (value) => value.replace(/\S+@\S+/g, '[EMAIL_1]') })).toMatchObject({ state: 'ok' });
    const points = await owner().select().from(schema.usageMetricPoint).where(eq(schema.usageMetricPoint.metricId, id));
    expect(points.length).toBeGreaterThan(0);
    expect(JSON.stringify(points)).not.toContain('alice');
    expect(new Set(points.map((point) => JSON.stringify(point.dims)))).toEqual(new Set(['{"flow":"[redacted]"}']));
  });
});

describe('anomalies: history, the cap, the dedupe', () => {
  const spikeMetric = (key: string): CreateMetric => ({
    key,
    name: `Spiky ${key}`,
    description: '',
    sqlTemplate: 'SELECT 1 WHERE $1 < $2',
    dims: ['org'],
    unit: 'failures',
    refreshIntervalSeconds: 3600,
    direction: 'up',
    anomalyRatio: 3,
    anomalyMinAbs: 10,
    active: true,
  });

  /** Steady 5 an hour for `days` days, then 100 in the last complete hour. */
  const portFor = (orgs: readonly string[], days: number) =>
    fixedDataPort((request) => {
      const lastComplete = Math.floor(request.params[1].getTime() / 3_600_000) * 3_600_000 - 3_600_000;
      const rows = orgs.flatMap((org) =>
        hourly(request.params[0], request.params[1], (ts) => {
          if (ts.getTime() === lastComplete) return 100;
          return ts.getTime() >= lastComplete - days * 24 * 3_600_000 ? 5 : null;
        }).map((row) => ({ ...row, org })),
      );
      return { columns: ['ts', 'value', 'org'], rows, truncated: false };
    });

  it('does not fire on a series with under seven days of data', async () => {
    const org = await addOrg(env);
    const id = await create(spikeMetric('young_series'));
    expect(await run(id, { port: portFor([org.id], 5) })).toMatchObject({ state: 'ok', anomalies: 0 });
    expect(await pointCount(id)).toBeGreaterThan(5 * 24);
    expect(await owner().select().from(schema.usageAnomaly).where(eq(schema.usageAnomaly.metricId, id))).toHaveLength(0);
    // With the week there, the very same spike fires.
    const old = await create(spikeMetric('old_series'));
    expect(await run(old, { port: portFor([org.id], 8) })).toMatchObject({ state: 'ok', anomalies: 1 });
  });

  it('opens at most the cap in one run and the rest in the next', async () => {
    const orgs = await Promise.all([addOrg(env), addOrg(env), addOrg(env), addOrg(env)]);
    const id = await create(spikeMetric('capped_series'));
    const port = portFor(orgs.map((o) => o.id), 8);
    const first = await run(id, { port, detect: { cap: 2 } });
    expect(first).toMatchObject({ state: 'ok', anomalies: 2, capped: 2 });
    expect(await owner().select().from(schema.usageAnomaly).where(eq(schema.usageAnomaly.metricId, id))).toHaveLength(2);
    const second = await run(id, { port, detect: { cap: 2 } });
    expect(second).toMatchObject({ anomalies: 2, capped: 0 });
    expect(await owner().select().from(schema.usageAnomaly).where(eq(schema.usageAnomaly.metricId, id))).toHaveLength(4);
    const third = await run(id, { port, detect: { cap: 2 } });
    expect(third).toMatchObject({ anomalies: 0, capped: 0 });
  });

  it('a series without an organization raises the alert but no ticket', async () => {
    const id = await create({ ...spikeMetric('no_org_series'), dims: ['flow'] });
    const port = fixedDataPort((request) => {
      const lastComplete = Math.floor(request.params[1].getTime() / 3_600_000) * 3_600_000 - 3_600_000;
      return {
        columns: ['ts', 'value', 'flow'],
        rows: hourly(request.params[0], request.params[1], (ts) => (ts.getTime() === lastComplete ? 100 : 5)).map((row) => ({ ...row, flow: 'checkout' })),
        truncated: false,
      };
    });
    expect(await run(id, { port })).toMatchObject({ state: 'ok', anomalies: 1 });
    const [anomaly] = await owner().select().from(schema.usageAnomaly).where(eq(schema.usageAnomaly.metricId, id));
    expect(anomaly?.ticketId).toBeNull();
    expect(anomaly?.alertId).not.toBeNull();
  });
});

describe('who changes a metric, and what the audit says', () => {
  it('lets only a signed-in person edit, bumps the version on a new template and audits its hashes, not its text', async () => {
    const id = await create({
      key: 'editable',
      name: 'Editable',
      description: '',
      sqlTemplate: 'SELECT 1 WHERE $1 < $2',
      dims: [],
      unit: 'count',
      refreshIntervalSeconds: 3600,
      direction: 'up',
      anomalyRatio: 3,
      anomalyMinAbs: 10,
      active: true,
    });
    await run(id, { port: fixedDataPort(() => ({ columns: ['ts', 'value'], rows: [], truncated: false })) });
    for (const actor of [SYSTEM, { type: 'ai', id: 'run-1' } as Actor]) {
      await expect(
        env.tx((tx) => env.domain.usage.updateMetric(tx, env.ctx(actor), id, { name: 'Hacked' })),
      ).rejects.toMatchObject({ code: 'policy_denied' });
    }
    await expect(
      env.tx((tx) => env.domain.usage.updateMetric(tx, env.ctx(head.actor), id, { sqlTemplate: 'DELETE FROM x WHERE $1 < $2 AND $2 > $1' })),
    ).rejects.toMatchObject({ code: 'bad_request' });

    const edited = await env.tx((tx) =>
      env.domain.usage.updateMetric(tx, env.ctx(head.actor), id, { sqlTemplate: 'SELECT 2 WHERE $1 < $2' }),
    );
    expect(edited.value.templateVersion).toBe(2);
    const [def] = await owner().select().from(schema.usageMetricDef).where(eq(schema.usageMetricDef.id, id));
    // The next run starts again from the backfill window under the new template.
    expect(def).toMatchObject({ templateVersion: 2, lastRunState: null, lastRunAt: null });
    const audit = (await auditRows(env, USAGE_AUDIT_ACTIONS.metricTemplateEdit)).filter((row) => row.targetId === id);
    expect(audit).toHaveLength(1);
    const metadata = audit[0]?.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({ version: 2, templateChanged: true });
    expect(String(metadata.fromSha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(metadata.toSha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(metadata.fromSha256).not.toBe(metadata.toSha256);
    expect(JSON.stringify(audit)).not.toContain('SELECT 2');

    // A change that is not the template is a plain update and keeps the version.
    await env.tx((tx) => env.domain.usage.updateMetric(tx, env.ctx(head.actor), id, { name: 'Renamed' }));
    expect((await auditRows(env, USAGE_AUDIT_ACTIONS.metricUpdate)).filter((row) => row.targetId === id)).toHaveLength(1);
  });
});

describe('the Client Health Score', () => {
  it('says "not enough data" for an organization that has not been observed long enough', async () => {
    const fresh = await addOrg(env);
    const snapshot = await env.domain.usage.computeHealth(env.database.db, fresh.id);
    expect(snapshot).toMatchObject({ status: 'insufficient_data', score: null, formulaVersion: 1 });
    const [row] = await owner().select().from(schema.orgHealthSnapshot).where(eq(schema.orgHealthSnapshot.orgId, fresh.id));
    expect(row).toMatchObject({ status: 'insufficient_data', score: null });
    const [org] = await owner().select().from(schema.organization).where(eq(schema.organization.id, fresh.id));
    expect(org?.healthScore).toBeNull();
  });

  it('scores an organization with history from its own facts, once per day, and keeps organization.health_score in step', async () => {
    const old = await addOrg(env);
    await owner().execute(sql`UPDATE organization SET created_at = clock_timestamp() - interval '90 days' WHERE id = ${old.id}`);
    // 12 tickets 10 and 20 days ago, 3 of them breached their first response, 3 answered the CSAT survey with 5.
    for (let i = 0; i < 12; i += 1) {
      const daysAgo = i < 8 ? 10 : 20;
      await owner().execute(sql`
        INSERT INTO ticket (subject, org_id, created_at, first_response_due_at, first_responded_at, csat_score)
        VALUES ('s', ${old.id}, clock_timestamp() - make_interval(days => ${daysAgo}),
                clock_timestamp() - make_interval(days => ${daysAgo}) + interval '1 hour',
                clock_timestamp() - make_interval(days => ${daysAgo}) + CASE WHEN ${i} < 3 THEN interval '3 hours' ELSE interval '30 minutes' END,
                ${i >= 9 ? 5 : null})`);
    }
    await owner().execute(sql`INSERT INTO ticket (subject, org_id) VALUES ('recent', ${old.id})`);
    const snapshot = await env.domain.usage.computeHealth(env.database.db, old.id);
    expect(snapshot.status).toBe('scored');
    expect(snapshot.score).toBeGreaterThan(0);
    expect(snapshot.score).toBeLessThanOrEqual(100);
    const sla = snapshot.components.find((c) => c.key === 'sla');
    expect(sla?.detail).toMatchObject({ tickets: 13, breached: 3 });
    expect(snapshot.components.find((c) => c.key === 'usage_anomalies')?.status).toBe('no_data');

    // The second computation the same day replaces the snapshot of that day.
    await env.domain.usage.computeHealth(env.database.db, old.id);
    const rows = await owner().select().from(schema.orgHealthSnapshot).where(eq(schema.orgHealthSnapshot.orgId, old.id));
    expect(rows).toHaveLength(1);
    const [org] = await owner().select().from(schema.organization).where(eq(schema.organization.id, old.id));
    expect(org?.healthScore).toBe(snapshot.score);

    // The internal ticket of an anomaly is not customer volume: adding one changes no ticket count.
    await owner().execute(sql`INSERT INTO ticket (subject, org_id, channel) VALUES ('anomaly', ${old.id}, 'internal')`);
    const again = await env.domain.usage.computeHealth(env.database.db, old.id);
    expect(again.components.find((c) => c.key === 'sla')?.detail).toMatchObject({ tickets: 13 });
  });

  it('computes every active organization and audits the run once', async () => {
    const before = (await auditRows(env, USAGE_AUDIT_ACTIONS.healthCompute)).length;
    const result = await env.domain.usage.computeAllHealth(env.database.db, env.ctx(SYSTEM));
    expect(result.organizations).toBeGreaterThanOrEqual(3);
    expect((await auditRows(env, USAGE_AUDIT_ACTIONS.healthCompute)).length).toBe(before + 1);
  });
});
