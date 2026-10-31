import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0007 (T-112a, ADR-011): Phase 1 stage ceiling, pin, history, global switches.
// `app` is the restricted login role the api and worker run as.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const CHECK_VIOLATION = '23514';
const INSUFFICIENT_PRIVILEGE = '42501';
const RESTRICT_VIOLATION = '23001';

let testDb: TestDatabase;
let app: Pool;
const owner = () => testDb.owner.pool;

async function scalar<T>(pool: Pool, text: string, values: unknown[] = []): Promise<T> {
  const result = await pool.query<{ value: T }>(text, values);
  const row = result.rows[0];
  if (row === undefined) throw new Error('query returned no row');
  return row.value;
}

let actor: string;
async function newIntent(key: string): Promise<string> {
  return scalar<string>(
    app,
    `INSERT INTO intent (key, name) VALUES ($1, 'Probe') RETURNING id AS value`,
    [key],
  );
}
const setAutonomy = (
  intent: string,
  stage: number | null,
  pinned: boolean | null,
  reason = 'because',
) =>
  app.query('SELECT set_intent_autonomy($1::uuid, $2::smallint, $3::boolean, $4::uuid, $5)', [
    intent,
    stage,
    pinned,
    actor,
    reason,
  ]);

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 4 });
  actor = await scalar<string>(
    owner(),
    `INSERT INTO users (email, name, role) VALUES ('lead@example.com', 'L', 'lead') RETURNING id AS value`,
  );
});

afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

describe('intent autonomy ceiling (Phase 1)', () => {
  it('rejects stage 3 and 4 by CHECK even for the schema owner, and accepts 0-2', async () => {
    for (const stage of [3, 4, -1]) {
      await expect(
        owner().query(`INSERT INTO intent (key, name, autonomy_stage) VALUES ($1, 'P', $2)`, [
          `probe_${String(stage).replace('-', 'm')}`,
          stage,
        ]),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
    for (const stage of [0, 1, 2]) {
      await owner().query(`INSERT INTO intent (key, name, autonomy_stage) VALUES ($1, 'P', $2)`, [
        `ok_${String(stage)}`,
        stage,
      ]);
    }
    const id = await newIntent('default_stage');
    expect(
      await scalar<number>(app, 'SELECT autonomy_stage AS value FROM intent WHERE id = $1', [id]),
    ).toBe(2);
    expect(
      await scalar<boolean>(app, 'SELECT autonomy_pinned AS value FROM intent WHERE id = $1', [id]),
    ).toBe(false);
  });

  it('refuses a direct UPDATE of the stage or the pin by the application role, not of other columns', async () => {
    const id = await newIntent('direct_update');
    await expect(
      app.query('UPDATE intent SET autonomy_stage = 0 WHERE id = $1', [id]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      app.query('UPDATE intent SET autonomy_pinned = true WHERE id = $1', [id]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await app.query(`UPDATE intent SET name = 'Renamed', updated_at = now() WHERE id = $1`, [id]);
  });

  it('refuses the function for stage 3 (CHECK) and an empty reason', async () => {
    const id = await newIntent('fn_bounds');
    await expect(setAutonomy(id, 3, null)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(setAutonomy(id, 1, null, '   ')).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    expect(
      await scalar<number>(
        app,
        'SELECT count(*)::int AS value FROM intent_autonomy_history WHERE intent_id = $1',
        [id],
      ),
    ).toBe(0);
  });
});

describe('set_intent_autonomy() and the history', () => {
  it('writes who / when / why / from / to with the change, and nothing for a no-op', async () => {
    const id = await newIntent('history');
    expect((await setAutonomy(id, 1, null, 'drafts were poor')).rows[0]).toMatchObject({
      set_intent_autonomy: 1,
    });
    expect((await setAutonomy(id, 1, null)).rows[0]).toMatchObject({ set_intent_autonomy: 0 });
    await setAutonomy(id, 2, true, 'head pinned it');
    const history = await app.query(
      `SELECT change, from_stage, to_stage, pinned, reason, changed_by FROM intent_autonomy_history
        WHERE intent_id = $1 ORDER BY changed_at`,
      [id],
    );
    expect(history.rows).toEqual([
      {
        change: 'stage',
        from_stage: 2,
        to_stage: 1,
        pinned: false,
        reason: 'drafts were poor',
        changed_by: actor,
      },
      {
        change: 'stage',
        from_stage: 1,
        to_stage: 2,
        pinned: true,
        reason: 'head pinned it',
        changed_by: actor,
      },
      {
        change: 'pin',
        from_stage: 2,
        to_stage: 2,
        pinned: true,
        reason: 'head pinned it',
        changed_by: actor,
      },
    ]);
    const row = await app.query(
      'SELECT autonomy_stage, autonomy_pinned FROM intent WHERE id = $1',
      [id],
    );
    expect(row.rows[0]).toEqual({ autonomy_stage: 2, autonomy_pinned: true });
  });

  it('refuses a stage change on a pinned intent until it is unpinned (WT001)', async () => {
    const id = await newIntent('pinned');
    await setAutonomy(id, null, true, 'freeze');
    await expect(setAutonomy(id, 1, null)).rejects.toMatchObject({ code: 'WT001' });
    await expect(setAutonomy(id, 1, true)).rejects.toMatchObject({ code: 'WT001' });
    await setAutonomy(id, 1, false, 'unfreeze and lower');
    expect(
      await scalar<number>(app, 'SELECT autonomy_stage AS value FROM intent WHERE id = $1', [id]),
    ).toBe(1);
  });

  it('refuses to raise a stage while the cap switch is on, but lowers and keeps 0/1 as they are (WT002)', async () => {
    const id = await newIntent('cap');
    await setAutonomy(id, 0, null);
    await app.query(
      `UPDATE ai_switch SET is_on = true, reason = 'incident', changed_by = $1 WHERE key = 'ai_stage_cap_pinned'`,
      [actor],
    );
    try {
      await expect(setAutonomy(id, 1, null)).rejects.toMatchObject({ code: 'WT002' });
      await expect(setAutonomy(id, 2, null)).rejects.toMatchObject({ code: 'WT002' });
      expect(
        await scalar<number>(app, 'SELECT autonomy_stage AS value FROM intent WHERE id = $1', [id]),
      ).toBe(0);
      const other = await newIntent('cap_lower');
      await setAutonomy(other, 1, null, 'lower is fine under the cap');
    } finally {
      await app.query(
        `UPDATE ai_switch SET is_on = false, reason = 'done', changed_by = $1 WHERE key = 'ai_stage_cap_pinned'`,
        [actor],
      );
    }
  });

  it('answers P0002 for an unknown intent', async () => {
    await expect(
      setAutonomy('00000000-0000-4000-8000-000000000000', 1, null),
    ).rejects.toMatchObject({ code: 'P0002' });
  });

  it('keeps the history append-only for the application role, the owner and TRUNCATE', async () => {
    const id = await newIntent('append_only');
    await setAutonomy(id, 1, null);
    await expect(
      app.query(
        `INSERT INTO intent_autonomy_history (intent_id, change, from_stage, to_stage, pinned, reason, changed_by)
                 VALUES ($1, 'stage', 1, 0, false, 'forged', $2)`,
        [id, actor],
      ),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      app.query(`UPDATE intent_autonomy_history SET reason = 'edited' WHERE intent_id = $1`, [id]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      app.query('DELETE FROM intent_autonomy_history WHERE intent_id = $1', [id]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(app.query('TRUNCATE intent_autonomy_history')).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
    // The schema owner is stopped by the trigger.
    await expect(
      owner().query(`UPDATE intent_autonomy_history SET reason = 'edited' WHERE intent_id = $1`, [
        id,
      ]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    await expect(
      owner().query('DELETE FROM intent_autonomy_history WHERE intent_id = $1', [id]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    await expect(owner().query('TRUNCATE intent_autonomy_history')).rejects.toMatchObject({
      code: RESTRICT_VIOLATION,
    });
    // An intent with history cannot be deleted away from its log.
    await expect(app.query('DELETE FROM intent WHERE id = $1', [id])).rejects.toMatchObject({
      code: '23503',
    });
  });

  it('keeps the function out of reach of PUBLIC', async () => {
    const roles = await owner().query<{ grantee: string }>(
      `SELECT grantee FROM information_schema.routine_privileges
        WHERE routine_name = 'set_intent_autonomy' AND privilege_type = 'EXECUTE' ORDER BY grantee`,
    );
    expect(roles.rows.map((row) => row.grantee)).not.toContain('PUBLIC');
    expect(roles.rows.map((row) => row.grantee)).toContain('watchtower_app');
  });
});

describe('ai_switch', () => {
  it('has exactly the two switches, both off, and cannot gain or lose a row', async () => {
    const rows = await app.query('SELECT key, is_on FROM ai_switch ORDER BY key');
    expect(rows.rows).toEqual([
      { key: 'ai_kill_switch', is_on: false },
      { key: 'ai_stage_cap_pinned', is_on: false },
    ]);
    await expect(
      app.query(`INSERT INTO ai_switch (key) VALUES ('ai_something_else')`),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(app.query(`DELETE FROM ai_switch`)).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
    await expect(
      app.query(`UPDATE ai_switch SET key = 'x' WHERE key = 'ai_kill_switch'`),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      owner().query(`INSERT INTO ai_switch (key) VALUES ('ai_something_else')`),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('needs a reason whenever someone flips it', async () => {
    await expect(
      app.query(
        `UPDATE ai_switch SET is_on = true, reason = '  ', changed_by = $1 WHERE key = 'ai_kill_switch'`,
        [actor],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });
});

describe('0007 goes down and up again', () => {
  it('reverts to the 0..4 CHECK and table-level UPDATE, and comes back', async () => {
    const later = await migrationsAfter('0007_autonomy_gate');
    const reverted = await migrateDown(owner(), { steps: 1 + later.length });
    expect(reverted).toEqual([...later.toReversed(), '0007_autonomy_gate']);
    expect(
      await scalar<number>(
        owner(),
        `SELECT count(*)::int AS value FROM information_schema.tables WHERE table_name IN ('ai_switch', 'intent_autonomy_history')`,
      ),
    ).toBe(0);
    // Back to the 0002 check: 3 is accepted again at the database level.
    await owner().query(
      `INSERT INTO intent (key, name, autonomy_stage) VALUES ('down_probe', 'P', 3)`,
    );
    await owner().query(`DELETE FROM intent WHERE key = 'down_probe'`);
    await app.query(`UPDATE intent SET name = 'still works' WHERE key = 'ok_0'`);

    expect(await migrateUp(owner())).toEqual(['0007_autonomy_gate', ...later]);
    await expect(
      owner().query(`INSERT INTO intent (key, name, autonomy_stage) VALUES ('up_probe', 'P', 3)`),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });
});
