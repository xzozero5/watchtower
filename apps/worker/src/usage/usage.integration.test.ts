import { randomBytes, randomUUID } from 'node:crypto';

import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { createDomain, type Domain, type UsageDataPort } from '@watchtower/domain';
import {
  CSAT_LANDING_PATH,
  QUEUE_NAMES,
  USAGE_JOBS,
  parseRedisUrl,
  type CreateMetric,
} from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';
import { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import { startWorker, type RunningWorker } from '../worker.js';

// T-205b to d in the running worker: the scheduler runs a due metric through the data port, dimension values
// pass the real PII redactor, the anomaly becomes an alert and an internal ticket once, and the daily job
// computes the health score ("not enough data" for an organization with no history).
const prefix = `wt-test-${randomBytes(4).toString('hex')}`;
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let testDb: TestDatabase;
let config: ReturnType<typeof testConfig>;
let worker: RunningWorker;
let queue: Queue;
let appDb: Database;
let domain: Domain;
let headId: string;
let orgSteady: string;
let orgSpike: string;
const owner = () => testDb.owner.db;
let asked = 0;

/** Steady 5 an hour for eight days; the second organization jumps to 100 in the last complete hour. */
const port: UsageDataPort = {
  query(request) {
    asked += 1;
    const [from, to] = request.params;
    const lastComplete = Math.floor(to.getTime() / 3_600_000) * 3_600_000 - 3_600_000;
    const rows: Record<string, unknown>[] = [];
    for (
      let t = Math.ceil(from.getTime() / 3_600_000) * 3_600_000;
      t <= to.getTime();
      t += 3_600_000
    ) {
      for (const org of [orgSteady, orgSpike]) {
        rows.push({
          ts: new Date(t),
          value: org === orgSpike && t === lastComplete ? 100 : 5,
          org,
          // A value that is personal data, to prove the redactor sits in the way.
          flow: org === orgSpike ? 'checkout' : 'jane.doe@customer.example',
        });
      }
    }
    return Promise.resolve({ columns: ['ts', 'value', 'org', 'flow'], rows, truncated: false });
  },
};

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  config = {
    ...testConfig({ DATABASE_URL: testDb.appUrl, OUTBOX_POLL_INTERVAL_MS: '100' }),
    listenPort: 0,
  };
  appDb = createDatabase({ url: testDb.appUrl, max: 3, applicationName: 'wt-usage-test' });
  domain = createDomain({
    ticketKeyPrefix: config.TICKET_KEY_PREFIX,
    sealKey: deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.outboxSecret),
    csat: {
      signingKey: deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.csatLink),
      landingUrl: new URL(CSAT_LANDING_PATH, config.APP_URL).toString(),
    },
  });
  const [head] = await owner()
    .insert(schema.users)
    .values({ email: `head-${randomUUID()}@example.test`, name: 'Head', role: 'head' })
    .returning({ id: schema.users.id });
  headId = head?.id ?? '';
  const orgs = await owner()
    .insert(schema.organization)
    .values([{ name: 'Steady Customer' }, { name: 'Spiky Customer' }])
    .returning({ id: schema.organization.id, name: schema.organization.name });
  orgSteady = orgs.find((org) => org.name === 'Steady Customer')?.id ?? '';
  orgSpike = orgs.find((org) => org.name === 'Spiky Customer')?.id ?? '';
  queue = new Queue(QUEUE_NAMES.usage, { connection: parseRedisUrl(config.REDIS_URL), prefix });
  worker = await startWorker(config, createLogger(config), {
    queuePrefix: prefix,
    overrides: { usage: { port } },
  });
});
afterAll(async () => {
  await worker.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await appDb.close();
  await testDb.cleanup();
});

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  what: string,
  timeoutMs = 25_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const definition: CreateMetric = {
  key: 'worker_series',
  name: 'Failed steps',
  description: '',
  sqlTemplate: 'SELECT 1 WHERE $1 < $2',
  dims: ['org', 'flow'],
  unit: 'failures',
  refreshIntervalSeconds: 3600,
  direction: 'up',
  anomalyRatio: 3,
  anomalyMinAbs: 10,
  active: true,
};

describe('the usage queue in the worker', () => {
  it('runs a due metric through the port, redacts personal data in dimensions, opens the anomaly once', async () => {
    const created = await appDb.db.transaction((tx) =>
      domain.usage.createMetric(
        tx,
        domain.context({ actor: { type: 'user', id: headId } }),
        definition,
      ),
    );
    const metricId = created.value.id;
    await queue.add(USAGE_JOBS.tick, {}, { removeOnComplete: true });

    const anomaly = await waitFor(async () => {
      const [row] = await owner().select().from(schema.usageAnomaly);
      return row;
    }, 'the anomaly');
    expect(anomaly.orgId).toBe(orgSpike);
    expect(anomaly.observed).toBe(100);
    expect(anomaly.baseline).toBe(5);

    // The alert and an internal ticket exist; nothing was sent to a customer.
    const [alert] = await owner()
      .select()
      .from(schema.alert)
      .where(eq(schema.alert.id, anomaly.alertId ?? randomUUID()));
    expect(alert?.source).toBe('usage_anomaly');
    expect(`${alert?.title ?? ''}${alert?.summary ?? ''}`).not.toContain('Spiky');
    const [ticket] = await owner()
      .select()
      .from(schema.ticket)
      .where(eq(schema.ticket.id, anomaly.ticketId ?? randomUUID()));
    expect(ticket).toMatchObject({ channel: 'internal', orgId: orgSpike });
    expect(await owner().select().from(schema.outboundDelivery)).toHaveLength(0);
    // The T-108 pipeline took the brief job for this internal ticket and made the insight a person reads.
    await waitFor(async () => {
      const [insight] = await owner()
        .select()
        .from(schema.aiTicketInsight)
        .where(eq(schema.aiTicketInsight.ticketId, ticket?.id ?? ''));
      return insight;
    }, 'the AI brief of the internal ticket');

    // The personal data in a dimension value never reached the table.
    const points = await owner()
      .select()
      .from(schema.usageMetricPoint)
      .where(eq(schema.usageMetricPoint.metricId, metricId));
    expect(points.length).toBeGreaterThan(2 * 24 * 7);
    expect(JSON.stringify(points)).not.toContain('jane.doe');
    expect(
      points
        .filter((point) => point.orgId === orgSteady)
        .every((point) => (point.dims as { flow: string }).flow === '[redacted]'),
    ).toBe(true);
    expect(
      points
        .filter((point) => point.orgId === orgSpike)
        .every((point) => (point.dims as { flow: string }).flow === 'checkout'),
    ).toBe(true);

    // A second tick finds nothing due (the interval is an hour of the database clock), asks nobody and opens nothing.
    const before = asked;
    await queue.add(USAGE_JOBS.tick, {}, { removeOnComplete: true });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(asked).toBe(before);
    expect(await owner().select().from(schema.usageAnomaly)).toHaveLength(1);

    // Make it due again: the repeated window changes no point and opens no second anomaly.
    const count = points.length;
    await owner().execute(
      sql`UPDATE usage_metric_def SET last_run_at = clock_timestamp() - interval '2 hours' WHERE id = ${metricId}`,
    );
    await queue.add(USAGE_JOBS.tick, {}, { removeOnComplete: true });
    await waitFor(() => Promise.resolve(asked > before ? true : undefined), 'the second run');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const again = await owner()
      .select()
      .from(schema.usageMetricPoint)
      .where(eq(schema.usageMetricPoint.metricId, metricId));
    expect(again).toHaveLength(count);
    expect(await owner().select().from(schema.usageAnomaly)).toHaveLength(1);
    expect(
      (await owner().select().from(schema.ticket)).filter((t) => t.channel === 'internal'),
    ).toHaveLength(1);
  });

  it('computes the health score daily and says "not enough data" for organizations with no history', async () => {
    await queue.add(USAGE_JOBS.health, {}, { removeOnComplete: true });
    const rows = await waitFor(async () => {
      const found = await owner().select().from(schema.orgHealthSnapshot);
      return found.length >= 2 ? found : undefined;
    }, 'the snapshots');
    expect(rows.every((row) => row.status === 'insufficient_data' && row.score === null)).toBe(
      true,
    );
    const orgs = await owner().select().from(schema.organization);
    expect(orgs.every((org) => org.healthScore === null)).toBe(true);
  });
});
