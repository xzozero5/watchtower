import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMetricSchema, type CreateMetric } from '@watchtower/shared';
import type { Database } from '@watchtower/db';

import type { UsageDataPort, UsageDataResult } from '../usage/run.js';

const EXAMPLES = fileURLToPath(new URL('../../../../examples/metrics', import.meta.url));

/** The starter metrics of `examples/metrics`, with their SQL read from the files next to them. */
export async function loadExampleMetrics(): Promise<CreateMetric[]> {
  const list = JSON.parse(await readFile(join(EXAMPLES, 'metrics.json'), 'utf8')) as {
    sqlFile: string;
  }[];
  return Promise.all(
    list.map(async ({ sqlFile, ...definition }) =>
      createMetricSchema.parse({
        ...definition,
        sqlTemplate: await readFile(join(EXAMPLES, sqlFile), 'utf8'),
      }),
    ),
  );
}

/** Loads the stand-in product schema into `pool`'s database and seeds it for these organizations. */
export async function loadProductMock(pool: Database['pool'], orgIds: readonly string[]): Promise<number> {
  await pool.query(await readFile(join(EXAMPLES, 'product_mock.sql'), 'utf8'));
  const result = await pool.query<{ seed: number }>(
    'SELECT product_mock.seed($1::uuid[]) AS seed',
    [orgIds],
  );
  return result.rows[0]?.seed ?? 0;
}

/**
 * A test double for the T-203 data client: it runs the template in a READ ONLY transaction on a pool,
 * which is enough to prove the example SQL does what its header says. It is NOT the guardrail (that is
 * T-203c's job) and is never wired into the application.
 */
export function pgDataPort(pool: Database['pool']): UsageDataPort {
  return {
    async query(request) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN READ ONLY');
        const result = await client.query({
          text: request.sql,
          values: [...request.params],
        });
        await client.query('COMMIT');
        return {
          columns: result.fields.map((field) => field.name),
          rows: result.rows as Record<string, unknown>[],
          truncated: result.rows.length > request.maxRows,
        };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/** A port that answers with a fixed result and remembers what it was asked. */
export function fixedDataPort(
  answer: (request: Parameters<UsageDataPort['query']>[0]) => UsageDataResult,
): UsageDataPort & { readonly requests: Parameters<UsageDataPort['query']>[0][] } {
  const requests: Parameters<UsageDataPort['query']>[0][] = [];
  return {
    requests,
    query(request) {
      requests.push(request);
      return Promise.resolve(answer(request));
    },
  };
}
