import { randomUUID } from 'node:crypto';

import { hmacJson } from '@watchtower/ai';
import { assembleToolClients, type ToolClients } from '@watchtower/connectors';
import { createProductDbExecutor, schema, type Database } from '@watchtower/db';
import { createHumanToolLedger, type UsageDataPort } from '@watchtower/domain';
import {
  DATA_COLUMN_ALLOW_LIST,
  RATE_TOOL_NAMES,
  budgetProjectFor,
} from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';
import { eq } from 'drizzle-orm';

import type { WorkerConfig } from '../config.js';

/** The longest one metric run may read for. Longer than a person's 5 s: a backfill reads eight days. `[ASSUMED]` */
export const USAGE_QUERY_TIMEOUT_MS = 15_000;

/**
 * The usage scheduler's view of the product data (T-203, T-205b): `UsageDataPort` over the guarded,
 * read-only `DataQueryClient`. Everything the guardrails give a person's run applies here too (one
 * statement, read-only transaction, timeout, row and byte caps, the role that can read columns only), and
 * so does the shared budget: each run takes a unit from the `data:<project>` window as the system and
 * leaves a `tool_execution` row (agent `usage`), so a metric refresh cannot starve a person or the AI.
 *
 * The columns a template may return are `ts`, `value` and the dimensions its definition declares: that
 * is what the definition says it needs, and the head who wrote it is audited. The template's own row of
 * `usage_metric_def` is the allow-list; nothing else is shown.
 */
export function createUsageDataPort(options: {
  readonly db: Database['db'];
  readonly clients: Pick<ToolClients, 'data' | 'dataMock'>;
  readonly hashKey: string;
  readonly project: string;
}): UsageDataPort | undefined {
  const { db, clients } = options;
  const data = clients.data;
  if (data === undefined) return undefined;
  const ledger = createHumanToolLedger({ db, project: options.project });

  return {
    async query(request) {
      const [definition] = await db
        .select({ dims: schema.usageMetricDef.dims })
        .from(schema.usageMetricDef)
        .where(eq(schema.usageMetricDef.key, request.metricKey))
        .limit(1);
      const columns = ['ts', 'value', ...(definition?.dims ?? [])].map((name) => name.toLowerCase());
      const [from, to] = request.params;
      const decision = await ledger.begin({
        runKey: randomUUID(),
        ticketId: null,
        agent: 'usage',
        tool: RATE_TOOL_NAMES.data,
        inputHash: hmacJson(options.hashKey, {
          metric: request.metricKey,
          from: from.toISOString(),
          to: to.toISOString(),
        }),
        mock: clients.dataMock ?? true,
        actor: 'system',
      });
      // The scheduler records a stable code for a failed run and tries again on its next tick.
      if (!decision.allowed) throw new Error('rate_limited');
      const started = Date.now();
      try {
        const result = await data(columns, { maxRows: request.maxRows }).query({
          label: request.metricKey,
          sql: request.sql,
          // The window travels as bind parameters ($1, $2), never inside the text.
          params: [from.toISOString(), to.toISOString()],
          maxRows: request.maxRows,
          timeoutMs: USAGE_QUERY_TIMEOUT_MS,
        });
        await ledger.finish(decision.id, {
          status: 'ok',
          errorCode: null,
          latencyMs: Date.now() - started,
          resultCount: result.rows.length,
        });
        return {
          columns: result.columns,
          rows: result.rows.map((row) =>
            Object.fromEntries(result.columns.map((name, index) => [name, row[index] ?? null])),
          ),
          truncated: result.truncated,
        };
      } catch (error) {
        await ledger.finish(decision.id, {
          status: 'error',
          errorCode: error instanceof Error ? error.name : 'UnknownError',
          latencyMs: Date.now() - started,
          resultCount: null,
        });
        throw error;
      }
    },
  };
}

/** The port from the environment: the product database behind `PRODUCT_DB_URL`, or a fake over the fixtures. */
export function usageDataPortFromConfig(
  config: Pick<
    WorkerConfig,
    'AI_TOOL_FIXTURES_DIR' | 'PRODUCT_DB_URL' | 'APP_ENCRYPTION_KEY' | 'GCP_PROJECT_ID' | 'OTEL_SERVICE_NAME'
  >,
  db: Database['db'],
): UsageDataPort | undefined {
  const clients = assembleToolClients({
    fixturesDir: config.AI_TOOL_FIXTURES_DIR,
    productDb:
      config.PRODUCT_DB_URL === undefined
        ? undefined
        : createProductDbExecutor({
            url: config.PRODUCT_DB_URL,
            applicationName: `${config.OTEL_SERVICE_NAME}-usage`,
          }),
    allowColumns: DATA_COLUMN_ALLOW_LIST,
  });
  return createUsageDataPort({
    db,
    clients,
    hashKey: deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.aiInputHash).toString('hex'),
    project: budgetProjectFor(config.GCP_PROJECT_ID),
  });
}
