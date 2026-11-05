import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0114 (T-430, ADR-030): `local` is a provider kind of the embedding index and of the
// ai_run audit row. Only the two CHECK lists change.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const CHECK_VIOLATION = '23514';

let testDb: TestDatabase;
const owner = () => testDb.owner.pool;

const code = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const insertIndex = (provider: string, model: string) =>
  owner().query(
    `INSERT INTO kb_embedding_index (provider, model, dimensions) VALUES ($1, $2, 1024)`,
    [provider, model],
  );

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
});
afterAll(async () => {
  await testDb.cleanup();
});

describe('0114 embedding provider local', () => {
  it('accepts local in kb_embedding_index and still refuses an unknown provider', async () => {
    await insertIndex('local', 'bge-m3');
    expect(await code(insertIndex('openai', 'x'))).toBe(CHECK_VIOLATION);
  });

  it('goes down (dropping local indexes and detaching their vectors) and up again', async () => {
    const later = await migrationsAfter('0114_embedding_provider_local');
    const reverted = await migrateDown(owner(), { steps: later.length + 1 });
    expect(reverted[reverted.length - 1]).toBe('0114_embedding_provider_local');
    expect(
      (await owner().query(`SELECT 1 FROM kb_embedding_index WHERE provider = 'local'`)).rowCount,
    ).toBe(0);
    expect(await code(insertIndex('local', 'again'))).toBe(CHECK_VIOLATION);

    expect(await migrateUp(owner())).toEqual(['0114_embedding_provider_local', ...later]);
    await insertIndex('local', 'again');
  });
});
