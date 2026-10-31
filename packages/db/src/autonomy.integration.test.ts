import { Pool, type PoolClient } from 'pg';
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
const setSwitch = (client: Pool | PoolClient, key: string, on: boolean, reason = 'because') =>
  client.query('SELECT public.set_ai_switch($1, $2, $3::uuid, $4) AS previous', [
    key,
    on,
    actor,
    reason,
  ]);
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
    await setSwitch(app, 'ai_stage_cap_pinned', true, 'incident');
    try {
      await expect(setAutonomy(id, 1, null)).rejects.toMatchObject({ code: 'WT002' });
      await expect(setAutonomy(id, 2, null)).rejects.toMatchObject({ code: 'WT002' });
      expect(
        await scalar<number>(app, 'SELECT autonomy_stage AS value FROM intent WHERE id = $1', [id]),
      ).toBe(0);
      const other = await newIntent('cap_lower');
      await setAutonomy(other, 1, null, 'lower is fine under the cap');
    } finally {
      await setSwitch(app, 'ai_stage_cap_pinned', false, 'done');
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

  it('is read-only for the application role: a direct UPDATE cannot flip it without a reason (A-5)', async () => {
    await expect(
      app.query(`UPDATE ai_switch SET is_on = true WHERE key = 'ai_kill_switch'`),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      app.query(
        `UPDATE ai_switch SET is_on = true, reason = 'x', changed_by = NULL WHERE key = 'ai_kill_switch'`,
      ),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });

  it('flips through set_ai_switch(), which needs a reason and an actor and reports the old value', async () => {
    await expect(setSwitch(app, 'ai_kill_switch', true, '  ')).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    await expect(
      app.query(`SELECT public.set_ai_switch('ai_kill_switch', true, NULL, 'no actor')`),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(setSwitch(app, 'ai_nope', true)).rejects.toMatchObject({ code: 'P0002' });
    expect((await setSwitch(app, 'ai_kill_switch', true, 'testing')).rows[0]).toEqual({
      previous: false,
    });
    expect((await setSwitch(app, 'ai_kill_switch', true, 'again')).rows[0]).toEqual({
      previous: true,
    });
    const row = await app.query('SELECT is_on, reason, changed_by FROM ai_switch WHERE key = $1', [
      'ai_kill_switch',
    ]);
    // The second call changed nothing, so the first reason stands.
    expect(row.rows[0]).toEqual({ is_on: true, reason: 'testing', changed_by: actor });
    await setSwitch(app, 'ai_kill_switch', false, 'testing over');
  });

  it('treats a missing cap switch row as ON, so a damaged table never lets a stage rise (A-5)', async () => {
    const id = await newIntent('missing_switch');
    await setAutonomy(id, 0, null);
    await owner().query(`DELETE FROM ai_switch WHERE key = 'ai_stage_cap_pinned'`);
    try {
      await expect(setAutonomy(id, 1, null)).rejects.toMatchObject({ code: 'WT002' });
    } finally {
      await owner().query(`INSERT INTO ai_switch (key) VALUES ('ai_stage_cap_pinned')`);
    }
    await setAutonomy(id, 1, null, 'with the row back');
  });
});

describe('SECURITY DEFINER functions cannot be fooled with TEMP objects (security review A-1)', () => {
  const appRole = () => decodeURIComponent(new URL(testDb.appUrl).username);

  it('has no TEMP privilege for the application role after provisioning', async () => {
    const client = await app.connect();
    try {
      await expect(client.query('CREATE TEMP TABLE probe (x int)')).rejects.toMatchObject({
        code: INSUFFICIENT_PRIVILEGE,
      });
    } finally {
      client.release();
    }
  });

  it('ignores shadow tables and a temp trigger even where TEMP is allowed', async () => {
    // A database where PUBLIC still holds TEMPORARY (every install made before this fix).
    await owner().query(`GRANT TEMPORARY ON DATABASE ${testDb.name} TO ${appRole()}`);
    const intent = await newIntent('shadowed');
    await setAutonomy(intent, 0, null, 'start low');
    await setSwitch(owner(), 'ai_stage_cap_pinned', true, 'cap is on');
    const client = await app.connect();
    try {
      await client.query('SET search_path = pg_temp, public');
      await client.query('CREATE TEMP TABLE ai_switch (key text, is_on boolean)');
      await client.query(`INSERT INTO ai_switch VALUES ('ai_stage_cap_pinned', false)`);
      await client.query(
        'CREATE TEMP TABLE intent_autonomy_history (LIKE public.intent_autonomy_history)',
      );
      await client.query('CREATE TEMP TABLE intent (LIKE public.intent)');
      await client.query(`CREATE FUNCTION pg_temp.evil() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN EXECUTE 'CREATE TABLE public.escalation_probe (x int)'; RETURN NEW; END $$`);
      await client.query(
        'CREATE TRIGGER evil AFTER INSERT ON pg_temp.intent_autonomy_history FOR EACH ROW EXECUTE FUNCTION pg_temp.evil()',
      );

      // The real cap is on; the shadow says off. The function must listen to the real one.
      await expect(
        client.query('SELECT set_intent_autonomy($1::uuid, 1::smallint, NULL, $2::uuid, $3)', [
          intent,
          actor,
          'try to bypass the cap',
        ]),
      ).rejects.toMatchObject({ code: 'WT002' });

      // With the cap off, a lowering works and its history lands in public, not in the shadow.
      await setSwitch(owner(), 'ai_stage_cap_pinned', false, 'cap is off');
      const other = await newIntent('shadowed_lower');
      await client.query(
        'SELECT public.set_intent_autonomy($1::uuid, 1::smallint, NULL, $2::uuid, $3)',
        [other, actor, 'divert my history'],
      );
      expect(
        await scalar<number>(
          owner(),
          'SELECT count(*)::int AS value FROM public.intent_autonomy_history WHERE intent_id = $1',
          [other],
        ),
      ).toBe(1);
      expect(
        (await client.query('SELECT count(*)::int AS n FROM pg_temp.intent_autonomy_history'))
          .rows[0],
      ).toEqual({ n: 0 });

      // set_ai_switch() writes the real table too.
      await client.query('SELECT public.set_ai_switch($1, true, $2::uuid, $3)', [
        'ai_kill_switch',
        actor,
        'shadow test',
      ]);
      expect(
        await scalar<boolean>(
          owner(),
          `SELECT is_on AS value FROM public.ai_switch WHERE key = 'ai_kill_switch'`,
        ),
      ).toBe(true);
      expect(
        (
          await client.query('SELECT is_on FROM pg_temp.ai_switch WHERE key = $1', [
            'ai_kill_switch',
          ])
        ).rows,
      ).toEqual([]);
      await setSwitch(owner(), 'ai_kill_switch', false, 'shadow test over');

      // Nothing ran with the owner's rights: the trigger's DDL never happened.
      expect(
        await scalar<string | null>(
          owner(),
          `SELECT to_regclass('public.escalation_probe')::text AS value`,
        ),
      ).toBeNull();
      await expect(
        client.query('CREATE TABLE public.escalation_probe (x int)'),
      ).rejects.toMatchObject({
        code: INSUFFICIENT_PRIVILEGE,
      });
    } finally {
      client.release(true);
      await owner().query(`REVOKE TEMPORARY ON DATABASE ${testDb.name} FROM ${appRole()}`);
    }
  });

  it('gives every SECURITY DEFINER function a fixed search_path of pg_catalog, pg_temp', async () => {
    const rows = await owner().query<{ proname: string; proconfig: string[] | null }>(
      `SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef ORDER BY p.proname`,
    );
    expect(rows.rows.map((row) => row.proname)).toEqual([
      'ensure_monthly_partitions',
      'set_ai_switch',
      'set_intent_autonomy',
    ]);
    for (const row of rows.rows) {
      expect(row.proconfig, row.proname).toEqual(['search_path=pg_catalog, pg_temp']);
    }
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
