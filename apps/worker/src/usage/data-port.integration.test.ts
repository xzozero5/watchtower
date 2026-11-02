import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { assembleToolClients } from '@watchtower/connectors';
import { createDatabase, createProductDbExecutor, schema, type Database } from '@watchtower/db';
import {
  createProductMockDatabase,
  createTestDatabase,
  type ProductMockDatabase,
  type TestDatabase,
} from '@watchtower/db/testing';
import { createDomain, type Domain } from '@watchtower/domain';
import {
  CSAT_LANDING_PATH,
  DATA_COLUMN_ALLOW_LIST,
  QUEUE_NAMES,
  USAGE_JOBS,
  parseRedisUrl,
  type CreateMetric,
} from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import { startWorker, type RunningWorker } from '../worker.js';
import { createUsageDataPort } from './data-port.js';

// T-203 x T-205b: the usage scheduler of the running worker reads the stand-in product database
// (`product_mock`, a database of its own) through the guarded data client, with no port handed in by the
// test: PRODUCT_DB_URL is all the configuration. The anomaly the seed plants for the second organization is
// found, every read is a tool_execution row of the system, and the starter templates pass the guard.
const net = disableNetConnect();
const prefix = `wt-test-${randomBytes(4).toString('hex')}`;
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const METRICS = fileURLToPath(new URL('../../../../examples/metrics/', import.meta.url));

let testDb: TestDatabase;
let mock: ProductMockDatabase;
let worker: RunningWorker;
let queue: Queue;
let appDb: Database;
let domain: Domain;
let headId: string;
let orgSteady: string;
let orgSpike: string;
const owner = () => testDb.owner.db;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  mock = await createProductMockDatabase(adminUrl);
  const config = {
    ...testConfig({
      DATABASE_URL: testDb.appUrl,
      OUTBOX_POLL_INTERVAL_MS: '100',
      PRODUCT_DB_URL: mock.readOnlyUrl,
    }),
    listenPort: 0,
  };
  appDb = createDatabase({ url: testDb.appUrl, max: 3, applicationName: 'wt-usage-port-test' });
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
  // The product knows these two organizations: the first is steady, the second gets the anomaly.
  const product = createDatabase({
    url: mock.ownerUrl,
    max: 1,
    applicationName: 'wt-product-seed',
  });
  await product.pool.query('SELECT product_mock.seed($1::uuid[])', [[orgSteady, orgSpike]]);
  await product.close();
  queue = new Queue(QUEUE_NAMES.usage, { connection: parseRedisUrl(config.REDIS_URL), prefix });
  worker = await startWorker(config, createLogger(config), { queuePrefix: prefix });
});
afterAll(async () => {
  await worker.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await appDb.close();
  await testDb.cleanup();
  await mock.cleanup();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

const starter = (file: string): string => readFileSync(`${METRICS}${file}`, 'utf8');

const failedSteps: CreateMetric = {
  key: 'failed_steps_per_org_hour',
  name: 'Failed steps per organization',
  description: '',
  sqlTemplate: starter('failed_steps_per_org_hour.sql'),
  dims: ['org', 'flow', 'step'],
  unit: 'failures',
  refreshIntervalSeconds: 3600,
  direction: 'up',
  anomalyRatio: 3,
  anomalyMinAbs: 10,
  active: true,
};

describe('the usage scheduler on mock product data', () => {
  it('runs a starter metric against product_mock with nothing handed in, finds the planted anomaly and audits the read', async () => {
    const created = await appDb.db.transaction((tx) =>
      domain.usage.createMetric(
        tx,
        domain.context({ actor: { type: 'user', id: headId } }),
        failedSteps,
      ),
    );
    await queue.add(USAGE_JOBS.tick, {}, { removeOnComplete: true });

    const anomaly = await waitFor(async () => {
      const [row] = await owner().select().from(schema.usageAnomaly);
      return row;
    }, 'the anomaly');
    expect(anomaly.orgId).toBe(orgSpike);
    expect(anomaly.observed).toBe(60);
    expect(anomaly.baseline).toBeGreaterThanOrEqual(2);
    expect(anomaly.baseline).toBeLessThanOrEqual(4);

    const [def] = await owner()
      .select()
      .from(schema.usageMetricDef)
      .where(eq(schema.usageMetricDef.id, created.value.id));
    expect(def).toMatchObject({ lastRunState: 'ok' });
    expect(def?.lastRunPoints ?? 0).toBeGreaterThan(100);

    // The read was a unit of the shared data budget, taken by the system, and a row that proves it.
    const runs = await owner().select().from(schema.toolExecution);
    const mine = runs.filter((row) => row.agent === 'usage');
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine.every((row) => row.tool === 'bigquery_query' && row.status === 'ok')).toBe(true);
    expect(mine.every((row) => row.mock && /^[0-9a-f]{64}$/.test(row.inputHash))).toBe(true);
    expect(mine[0]?.resultCount).toBeGreaterThan(100);
    expect(JSON.stringify(mine)).not.toContain('flow_run');
  });
});

describe('the adapter', () => {
  const clients = () =>
    assembleToolClients({
      fixturesDir: undefined,
      productDb: createProductDbExecutor({ url: mock.readOnlyUrl }),
      allowColumns: DATA_COLUMN_ALLOW_LIST,
    });
  const window = (): readonly [Date, Date] => {
    const to = new Date();
    return [new Date(to.getTime() - 8 * 24 * 3_600_000), to];
  };

  it('passes every starter template through the guard and returns what the definition declares', async () => {
    const tools = clients();
    const port = createUsageDataPort({
      db: appDb.db,
      clients: tools,
      hashKey: 'a'.repeat(64),
      project: 'default',
    });
    if (port === undefined) throw new Error('no port');
    const metrics = JSON.parse(readFileSync(`${METRICS}metrics.json`, 'utf8')) as {
      key: string;
      sqlFile: string;
      dims: string[];
    }[];
    for (const metric of metrics) {
      // The adapter learns the declared dimensions from the definition: put each one in.
      await owner()
        .insert(schema.usageMetricDef)
        .values({
          key: metric.key,
          name: metric.key,
          sqlTemplate: starter(metric.sqlFile),
          dims: metric.dims,
          // The adapter only reads the declared dimensions: inactive, so the worker's own scheduler (a tick
          // every minute, running in this process) never runs it and writes a tool_execution row of its own.
          active: false,
        })
        .onConflictDoNothing();
      const result = await port.query({
        metricKey: metric.key,
        sql: starter(metric.sqlFile),
        params: window(),
        maxRows: 5001,
      });
      expect([...result.columns].toSorted()).toEqual(['ts', 'value', ...metric.dims].toSorted());
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.truncated).toBe(false);
      // No column was hidden: a hidden one would arrive as null.
      expect(result.rows.every((row) => Object.values(row).every((cell) => cell !== null))).toBe(
        true,
      );
    }
    await tools.close?.();
  });

  it('says truncated at the row cap, hides a column the definition did not declare, and is held to the data budget', async () => {
    const tools = clients();
    const project = `usage-${randomBytes(3).toString('hex')}`;
    const port = createUsageDataPort({
      db: appDb.db,
      clients: tools,
      hashKey: 'b'.repeat(64),
      project,
    });
    if (port === undefined) throw new Error('no port');
    const key = `adhoc_${randomBytes(3).toString('hex')}`;
    await owner()
      .insert(schema.usageMetricDef)
      .values({
        key,
        name: key,
        sqlTemplate: 'SELECT 1',
        dims: ['org'],
        // Inactive: the worker's scheduler would otherwise run this definition too, and its audit row would
        // land between the two counts below.
        active: false,
      });
    const sql = `SELECT date_trunc('hour', started_at) AS ts, count(*) AS value, org_id AS org, step AS sneaky
                 FROM product_mock.flow_run WHERE started_at >= $1 AND started_at < $2 GROUP BY 1, 3, 4`;
    const result = await port.query({ metricKey: key, sql, params: window(), maxRows: 10 });
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(10);
    // `sneaky` is not declared by the definition, so it is not on the allow-list: its cells are null.
    expect(result.rows.every((row) => row.sneaky === null)).toBe(true);
    expect(result.rows.every((row) => row.org !== null)).toBe(true);

    // The system is held to the shared window: once people and the system have taken everything but the
    // AI's floor of that project's data budget, the read is refused and never reaches the database.
    const before = (await owner().select().from(schema.toolExecution)).length;
    await owner()
      .insert(schema.rateBudgetWindow)
      .values({ resource: `data:${project}`, slot: new Date(), total: 50, ai: 0 });
    await expect(
      port.query({ metricKey: key, sql, params: window(), maxRows: 10 }),
    ).rejects.toThrow('rate_limited');
    const after = await owner().select().from(schema.toolExecution);
    expect(after).toHaveLength(before + 1);
    expect(after.filter((row) => row.status === 'denied' && row.agent === 'usage')).toHaveLength(1);
    await tools.close?.();
  });
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
