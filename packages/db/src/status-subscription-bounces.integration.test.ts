import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0093 (T-207a C-7): bounce_count and suppressed_at on status_subscription.
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
const insert = (email: string, extra = ''): Promise<unknown> =>
  owner().query(
    `INSERT INTO status_subscription (email, confirm_nonce, unsubscribe_nonce ${extra === '' ? '' : ', state, unsubscribed_at, bounce_count, suppressed_at'})
     VALUES ($1, '0123456789abcdef', 'fedcba9876543210' ${extra})`,
    [email],
  );

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
});
afterAll(async () => {
  await testDb.cleanup();
});

describe('0093 status_subscription bounces', () => {
  it('starts every subscription at zero bounces and not suppressed', async () => {
    await insert('a@example.test');
    const row = await owner().query<{ bounce_count: number; suppressed_at: Date | null }>(
      `SELECT bounce_count, suppressed_at FROM status_subscription WHERE email = 'a@example.test'`,
    );
    expect(row.rows[0]).toEqual({ bounce_count: 0, suppressed_at: null });
  });

  it('allows a suppressed address only when it is unsubscribed, and refuses a negative count', async () => {
    expect(
      await code(insert('b@example.test', `, 'unsubscribed', now(), 3, now()`)),
    ).toBeUndefined();
    expect(await code(insert('c@example.test', `, 'confirmed', NULL, 3, now()`))).toBe(
      CHECK_VIOLATION,
    );
    expect(await code(insert('d@example.test', `, 'pending', NULL, -1, NULL`))).toBe(
      CHECK_VIOLATION,
    );
  });

  it('goes down and up again', async () => {
    const later = await migrationsAfter('0093_status_subscription_bounces');
    const reverted = await migrateDown(owner(), { steps: later.length + 1 });
    expect(reverted[reverted.length - 1]).toBe('0093_status_subscription_bounces');
    const columns = await owner().query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'status_subscription' AND column_name IN ('bounce_count', 'suppressed_at')`,
    );
    expect(columns.rowCount).toBe(0);
    expect(await migrateUp(owner())).toEqual(['0093_status_subscription_bounces', ...later]);
  });
});
