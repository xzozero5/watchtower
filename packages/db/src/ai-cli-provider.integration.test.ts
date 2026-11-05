import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, type TestDatabase } from './testing.js';

const adminUrl = process.env.TEST_DATABASE_URL;
let testDb: TestDatabase;
beforeAll(async () => {
  if (!adminUrl) throw new Error('TEST_DATABASE_URL must point at disposable Postgres');
  testDb = await createTestDatabase(adminUrl);
});
afterAll(async () => {
  await testDb.cleanup();
});

const insertRun = (provider: string) =>
  testDb.owner.pool.query(
    `INSERT INTO ai_run
  (started_at, agent, provider, model, tier, prompt_id, prompt_version, prompt_hash, input_hmac, redaction, status)
  VALUES (now(), 'classifier', $1, 'test-model', 'light', 'classifier', 1, repeat('a', 64), repeat('b', 64), '{"total":0,"byKind":{}}', 'ok')`,
    [provider],
  );

describe('0116 AI CLI provider (ADR-031)', () => {
  it('reverses on an empty audit table and restores the generic provider without removing legacy/local kinds', async () => {
    expect(await migrateDown(testDb.owner.pool, { steps: 1 })).toEqual(['0116_ai_cli_provider']);
    await expect(insertRun('ai-cli')).rejects.toMatchObject({ code: '23514' });
    expect(await migrateUp(testDb.owner.pool)).toEqual(['0116_ai_cli_provider']);
    for (const provider of ['ai-cli', 'claude-cli', 'local']) {
      await expect(insertRun(provider)).resolves.toMatchObject({ rowCount: 1 });
    }
    await expect(insertRun('unknown-cli')).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses rollback while ai-cli audit evidence exists and preserves the rows', async () => {
    await expect(migrateDown(testDb.owner.pool, { steps: 1 })).rejects.toThrow();
    const result = await testDb.owner.pool.query<{ count: string }>(
      "SELECT count(*) FROM ai_run WHERE provider = 'ai-cli'",
    );
    expect(result.rows[0]?.count).toBe('1');
  });
});
