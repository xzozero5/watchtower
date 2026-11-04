import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0097 (T-303b, ADR-026): procedures, versions that freeze when they leave draft, an append-only
// simulation table and the two SECURITY DEFINER doors (publish, retire).
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const CHECK_VIOLATION = '23514';
const RESTRICT_VIOLATION = '23001';
const INSUFFICIENT_PRIVILEGE = '42501';
const UNIQUE_VIOLATION = '23505';
const UNDEFINED_TABLE = '42P01';

let testDb: TestDatabase;
let app: Pool;
const owner = () => testDb.owner.pool;

const code = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const STEPS = { schemaVersion: 1, autosend: 'never', steps: [] as unknown[] };
const person = () => randomUUID();

async function newIntent(key: string): Promise<string> {
  const row = await owner().query<{ id: string }>(
    `INSERT INTO intent (key, name) VALUES ($1, $1) RETURNING id`,
    [key],
  );
  return row.rows[0]?.id ?? '';
}

async function newProcedure(intentId: string): Promise<string> {
  const row = await app.query<{ id: string }>(
    `INSERT INTO procedure (intent_id, created_by) VALUES ($1, $2) RETURNING id`,
    [intentId, person()],
  );
  return row.rows[0]?.id ?? '';
}

async function newVersion(procedureId: string, steps: unknown = STEPS): Promise<string> {
  const row = await app.query<{ id: string }>(
    `INSERT INTO procedure_version (procedure_id, source_md, steps, authored_by)
     VALUES ($1, 'Check the logs first.', $2::jsonb, $3) RETURNING id`,
    [procedureId, JSON.stringify(steps), person()],
  );
  return row.rows[0]?.id ?? '';
}

const confirm = (versionId: string, by = person()) =>
  app.query(
    `UPDATE procedure_version SET status = 'confirmed', confirmed_by = $2, confirmed_at = now() WHERE id = $1`,
    [versionId, by],
  );

async function simulate(
  versionId: string,
  over: { passed?: boolean; seedOnly?: boolean; ageDays?: number } = {},
): Promise<string> {
  const row = await app.query<{ id: string }>(
    `INSERT INTO procedure_simulation (procedure_version_id, passed, seed_only, case_count, metrics, created_at)
     VALUES ($1, $2, $3, 5, '{"violations":0}'::jsonb, clock_timestamp() - make_interval(days => $4))
     RETURNING id`,
    [versionId, over.passed ?? true, over.seedOnly ?? false, over.ageDays ?? 0],
  );
  return row.rows[0]?.id ?? '';
}

const publish = (versionId: string, actor: string | null) =>
  app.query<{ previous: string | null }>(
    `SELECT public.publish_procedure_version($1::uuid, $2::uuid) AS previous`,
    [versionId, actor],
  );

const statusOf = async (versionId: string) =>
  (
    await owner().query<{ status: string }>(`SELECT status FROM procedure_version WHERE id = $1`, [
      versionId,
    ])
  ).rows[0]?.status;

const pointerOf = async (intentId: string) =>
  (
    await owner().query<{ procedure_version_id: string | null }>(
      `SELECT procedure_version_id FROM intent WHERE id = $1`,
      [intentId],
    )
  ).rows[0]?.procedure_version_id;

async function sqlstate(work: Promise<unknown>): Promise<string | undefined> {
  return code(work);
}

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 3 });
});
afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

describe('procedure_version while it is a draft', () => {
  it('numbers versions and computes the hash in the database', async () => {
    const procedureId = await newProcedure(await newIntent('numbering'));
    const first = await newVersion(procedureId);
    const second = await app.query<{ id: string; version: number; steps_hash: string }>(
      `INSERT INTO procedure_version (procedure_id, version, steps, steps_hash)
       VALUES ($1, 99, $2::jsonb, $3) RETURNING id, version, steps_hash`,
      [procedureId, JSON.stringify(STEPS), 'f'.repeat(64)],
    );
    const rows = await app.query<{ id: string; version: number; steps_hash: string }>(
      `SELECT id, version, steps_hash FROM procedure_version WHERE procedure_id = $1 ORDER BY version`,
      [procedureId],
    );
    expect(rows.rows.map((row) => row.version)).toEqual([1, 2]);
    expect(rows.rows[0]?.id).toBe(first);
    // The hash is of the canonical jsonb text, and what the client sent is ignored.
    const text = (
      await owner().query<{ text: string }>(`SELECT $1::jsonb::text AS text`, [
        JSON.stringify(STEPS),
      ])
    ).rows[0]?.text;
    const expected = createHash('sha256')
      .update(text ?? '')
      .digest('hex');
    expect(rows.rows[0]?.steps_hash).toBe(expected);
    expect(second.rows[0]?.steps_hash).toBe(expected);
  });

  it('recomputes the hash when a draft is edited, and starts only as a draft', async () => {
    const procedureId = await newProcedure(await newIntent('editing'));
    const id = await newVersion(procedureId);
    const before = await owner().query<{ steps_hash: string }>(
      `SELECT steps_hash FROM procedure_version WHERE id = $1`,
      [id],
    );
    await app.query(
      `UPDATE procedure_version SET steps = $2::jsonb, source_md = 'new' WHERE id = $1`,
      [id, JSON.stringify({ ...STEPS, autosend: 'allowed' })],
    );
    const after = await owner().query<{ steps_hash: string }>(
      `SELECT steps_hash FROM procedure_version WHERE id = $1`,
      [id],
    );
    expect(after.rows[0]?.steps_hash).not.toBe(before.rows[0]?.steps_hash);
    expect(
      await code(
        app.query(
          `INSERT INTO procedure_version (procedure_id, status, steps) VALUES ($1, 'confirmed', '{}'::jsonb)`,
          [procedureId],
        ),
      ),
    ).toBe(RESTRICT_VIOLATION);
  });

  it('refuses steps that are not an object, and a text over 8 KB', async () => {
    const procedureId = await newProcedure(await newIntent('shape'));
    expect(
      await code(
        app.query(`INSERT INTO procedure_version (procedure_id, steps) VALUES ($1, '[]'::jsonb)`, [
          procedureId,
        ]),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await code(
        app.query(
          `INSERT INTO procedure_version (procedure_id, steps, source_md) VALUES ($1, '{}'::jsonb, $2)`,
          [procedureId, 'x'.repeat(8193)],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });
});

describe('a version that left draft is frozen', () => {
  it('refuses a change of the text or the steps, for the owner too, and a delete', async () => {
    const procedureId = await newProcedure(await newIntent('frozen'));
    const id = await newVersion(procedureId);
    await confirm(id);
    for (const pool of [app, owner()]) {
      expect(
        await code(pool.query(`UPDATE procedure_version SET source_md = 'x' WHERE id = $1`, [id])),
      ).toBe(RESTRICT_VIOLATION);
      expect(
        await code(
          pool.query(`UPDATE procedure_version SET steps = '{"a":1}'::jsonb WHERE id = $1`, [id]),
        ),
      ).toBe(RESTRICT_VIOLATION);
    }
    expect(
      await code(
        owner().query(`UPDATE procedure_version SET steps_hash = $2 WHERE id = $1`, [
          id,
          'a'.repeat(64),
        ]),
      ),
    ).toBe(RESTRICT_VIOLATION);
    expect(
      await code(
        owner().query(`UPDATE procedure_version SET confirmed_by = $2 WHERE id = $1`, [
          id,
          person(),
        ]),
      ),
    ).toBe(RESTRICT_VIOLATION);
    expect(await code(app.query(`DELETE FROM procedure_version WHERE id = $1`, [id]))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await code(owner().query(`DELETE FROM procedure_version WHERE id = $1`, [id]))).toBe(
      RESTRICT_VIOLATION,
    );
  });

  it('only moves forward along the allowed edges', async () => {
    const procedureId = await newProcedure(await newIntent('edges'));
    const id = await newVersion(procedureId);
    // draft -> simulated skips confirm; the CHECKs and the trigger both say no.
    expect(
      await code(
        app.query(`UPDATE procedure_version SET status = 'simulated' WHERE id = $1`, [id]),
      ),
    ).toBeDefined();
    await confirm(id);
    expect(
      await code(app.query(`UPDATE procedure_version SET status = 'draft' WHERE id = $1`, [id])),
    ).toBe(RESTRICT_VIOLATION);
  });

  it('keeps the application role away from the columns that make a version published or retired', async () => {
    const procedureId = await newProcedure(await newIntent('privileges'));
    const id = await newVersion(procedureId);
    await confirm(id);
    expect(
      await code(
        app.query(`UPDATE procedure_version SET published_by = $2 WHERE id = $1`, [id, person()]),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await code(
        app.query(`UPDATE procedure_version SET simulation_id = $2 WHERE id = $1`, [
          id,
          randomUUID(),
        ]),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await code(app.query(`UPDATE procedure_version SET retired_at = now() WHERE id = $1`, [id])),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    // Setting only the status gets stopped by the CHECK that demands the columns it cannot write.
    expect(
      await code(
        app.query(`UPDATE procedure_version SET status = 'published' WHERE id = $1`, [id]),
      ),
    ).toBeDefined();
    expect(await statusOf(id)).toBe('confirmed');
  });
});

describe('procedure_simulation', () => {
  it('is append-only, bound to the hash of the version, and refuses a draft', async () => {
    const procedureId = await newProcedure(await newIntent('sim_rules'));
    const id = await newVersion(procedureId);
    expect(await code(simulate(id))).toBe(RESTRICT_VIOLATION);
    await confirm(id);
    const simId = await simulate(id);
    const sim = await owner().query<{ steps_hash: string }>(
      `SELECT steps_hash FROM procedure_simulation WHERE id = $1`,
      [simId],
    );
    const version = await owner().query<{ steps_hash: string }>(
      `SELECT steps_hash FROM procedure_version WHERE id = $1`,
      [id],
    );
    expect(sim.rows[0]?.steps_hash).toBe(version.rows[0]?.steps_hash);
    for (const pool of [app, owner()]) {
      expect(
        await code(
          pool.query(`UPDATE procedure_simulation SET passed = false WHERE id = $1`, [simId]),
        ),
      ).toBeDefined();
      expect(
        await code(pool.query(`DELETE FROM procedure_simulation WHERE id = $1`, [simId])),
      ).toBeDefined();
    }
    expect(
      await code(
        owner().query(`UPDATE procedure_simulation SET passed = false WHERE id = $1`, [simId]),
      ),
    ).toBe(RESTRICT_VIOLATION);
    expect(await code(owner().query(`TRUNCATE procedure_simulation CASCADE`))).toBeDefined();
    const left = await owner().query(`SELECT 1 FROM procedure_simulation WHERE id = $1`, [simId]);
    expect(left.rowCount).toBe(1);
  });

  it('moves a confirmed version to simulated when it passes and back to confirmed when it fails', async () => {
    const procedureId = await newProcedure(await newIntent('sim_status'));
    const id = await newVersion(procedureId);
    await confirm(id);
    await simulate(id, { passed: false });
    expect(await statusOf(id)).toBe('confirmed');
    const passing = await simulate(id);
    expect(await statusOf(id)).toBe('simulated');
    const pointer = await owner().query<{ simulation_id: string }>(
      `SELECT simulation_id FROM procedure_version WHERE id = $1`,
      [id],
    );
    expect(pointer.rows[0]?.simulation_id).toBe(passing);
    await simulate(id, { passed: false });
    expect(await statusOf(id)).toBe('confirmed');
  });

  it('cannot say it passed with no case', async () => {
    const procedureId = await newProcedure(await newIntent('sim_cases'));
    const id = await newVersion(procedureId);
    await confirm(id);
    expect(
      await code(
        app.query(
          `INSERT INTO procedure_simulation (procedure_version_id, passed, case_count) VALUES ($1, true, 0)`,
          [id],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });
});

describe('publish_procedure_version()', () => {
  it('refuses without a passing simulation (an empty simulation table means no publish)', async () => {
    const intentId = await newIntent('pub_none');
    const procedureId = await newProcedure(intentId);
    const id = await newVersion(procedureId);
    await confirm(id);
    // Confirmed but never simulated.
    expect(await code(publish(id, person()))).toBe('WT110');
    await simulate(id, { passed: false });
    expect(await code(publish(id, person()))).toBe('WT110');
    expect(await pointerOf(intentId)).toBeNull();
    expect(await code(publish(id, null))).toBe(CHECK_VIOLATION);
    expect(await code(publish(randomUUID(), person()))).toBe('P0002');
  });

  it('refuses a simulation older than 30 days', async () => {
    const intentId = await newIntent('pub_old');
    const procedureId = await newProcedure(intentId);
    const id = await newVersion(procedureId);
    await confirm(id);
    await simulate(id, { ageDays: 31 });
    expect(await code(publish(id, person()))).toBe('WT112');
    expect(await statusOf(id)).toBe('simulated');
  });

  it('publishes a simulated version, points the intent at it, retires the one before, and rolls back', async () => {
    const intentId = await newIntent('pub_flow');
    const procedureId = await newProcedure(intentId);
    const first = await newVersion(procedureId);
    await confirm(first);
    const firstSim = await simulate(first);
    const publisher = person();
    expect((await publish(first, publisher)).rows[0]?.previous).toBeNull();
    expect(await statusOf(first)).toBe('published');
    expect(await pointerOf(intentId)).toBe(first);
    const published = await owner().query<{ published_by: string; simulation_id: string }>(
      `SELECT published_by, simulation_id FROM procedure_version WHERE id = $1`,
      [first],
    );
    expect(published.rows[0]).toEqual({ published_by: publisher, simulation_id: firstSim });

    const second = await newVersion(procedureId, { ...STEPS, autosend: 'allowed' });
    await confirm(second);
    await simulate(second);
    expect((await publish(second, person())).rows[0]?.previous).toBe(first);
    expect(await statusOf(first)).toBe('retired');
    expect(await statusOf(second)).toBe('published');
    expect(await pointerOf(intentId)).toBe(second);
    // At most one is published, whoever tries.
    expect(
      await code(
        owner().query(
          `INSERT INTO procedure_version (procedure_id, steps) VALUES ($1, '{}'::jsonb)`,
          [procedureId],
        ),
      ),
    ).toBeUndefined();
    expect(
      await code(
        owner().query(
          `UPDATE procedure_version SET status = 'published', published_by = $2, published_at = now(), retired_at = NULL, retired_by = NULL WHERE id = $1`,
          [first, person()],
        ),
      ),
    ).toBe(UNIQUE_VIOLATION);

    // Rollback: the old version is published again; its simulation is still fresh.
    expect((await publish(first, person())).rows[0]?.previous).toBe(second);
    expect(await pointerOf(intentId)).toBe(first);
    expect(await statusOf(second)).toBe('retired');
    // A version that was never published cannot be reached from `retired`.
    const never = await newVersion(procedureId);
    await app.query(`SELECT public.retire_procedure_version($1::uuid, $2::uuid)`, [
      never,
      person(),
    ]);
    expect(await code(publish(never, person()))).toBe('WT110');
  });

  it('does not let the application role move the pointer or publish by hand', async () => {
    const intentId = await newIntent('pub_pointer');
    const procedureId = await newProcedure(intentId);
    const id = await newVersion(procedureId);
    expect(
      await code(
        app.query(`UPDATE intent SET procedure_version_id = $2 WHERE id = $1`, [intentId, id]),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    // The rest of the intent can still be edited by the application.
    await app.query(`UPDATE intent SET name = 'Renamed' WHERE id = $1`, [intentId]);
  });

  it('is not shadowed by TEMP tables of the same names', async () => {
    const intentId = await newIntent('pub_temp');
    const procedureId = await newProcedure(intentId);
    const id = await newVersion(procedureId);
    await confirm(id);
    await simulate(id);
    const client = await owner().connect();
    try {
      await client.query(`CREATE TEMP TABLE procedure_version (LIKE public.procedure_version)`);
      await client.query(
        `CREATE TEMP TABLE procedure_simulation (LIKE public.procedure_simulation)`,
      );
      await client.query(`CREATE TEMP TABLE procedure (LIKE public.procedure)`);
      await client.query(`CREATE TEMP TABLE intent (LIKE public.intent)`);
      await client.query(`SELECT public.publish_procedure_version($1::uuid, $2::uuid)`, [
        id,
        person(),
      ]);
      await client.query(
        `DROP TABLE pg_temp.procedure_version, pg_temp.procedure_simulation, pg_temp.procedure, pg_temp.intent`,
      );
    } finally {
      client.release();
    }
    expect(await statusOf(id)).toBe('published');
    expect(await pointerOf(intentId)).toBe(id);
  });

  it('is not callable without being the application role or the owner', async () => {
    const executable = await owner().query<{ ok: boolean }>(
      `SELECT has_function_privilege('public', 'public.publish_procedure_version(uuid, uuid)', 'EXECUTE') AS ok`,
    );
    expect(executable.rows[0]?.ok).toBe(false);
    const retire = await owner().query<{ ok: boolean }>(
      `SELECT has_function_privilege('public', 'public.retire_procedure_version(uuid, uuid)', 'EXECUTE') AS ok`,
    );
    expect(retire.rows[0]?.ok).toBe(false);
  });
});

describe('retire_procedure_version()', () => {
  it('clears the pointer of a published version and throws away a draft', async () => {
    const intentId = await newIntent('retire');
    const procedureId = await newProcedure(intentId);
    const id = await newVersion(procedureId);
    await confirm(id);
    await simulate(id);
    await publish(id, person());
    const retired = await app.query<{ was: boolean }>(
      `SELECT public.retire_procedure_version($1::uuid, $2::uuid) AS was`,
      [id, person()],
    );
    expect(retired.rows[0]?.was).toBe(true);
    expect(await pointerOf(intentId)).toBeNull();
    expect(await statusOf(id)).toBe('retired');
    expect(
      await code(
        app.query(`SELECT public.retire_procedure_version($1::uuid, $2::uuid)`, [id, person()]),
      ),
    ).toBe('WT110');
    const draft = await newVersion(procedureId);
    const thrown = await app.query<{ was: boolean }>(
      `SELECT public.retire_procedure_version($1::uuid, $2::uuid) AS was`,
      [draft, person()],
    );
    expect(thrown.rows[0]?.was).toBe(false);
    expect(await statusOf(draft)).toBe('retired');
  });
});

describe('stage 3 intents (rules that wait for the owner to open stage 3)', () => {
  it('needs a second person and a simulation on real tickets', async () => {
    // The stage CHECKs of the day are lifted in this throwaway database only, to exercise the rule.
    const checks = await owner().query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'public.intent'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%autonomy_stage%'`,
    );
    for (const { conname } of checks.rows) {
      await owner().query(`ALTER TABLE intent DROP CONSTRAINT ${conname}`);
    }
    const intentId = await newIntent('stage3');
    await owner().query(`UPDATE intent SET autonomy_stage = 3 WHERE id = $1`, [intentId]);
    const procedureId = await newProcedure(intentId);
    const id = await newVersion(procedureId);
    const confirmer = person();
    await confirm(id, confirmer);
    await simulate(id, { seedOnly: true });
    expect(await code(publish(id, person()))).toBe('WT114');
    await simulate(id);
    expect(await code(publish(id, confirmer))).toBe('WT113');
    await publish(id, person());
    expect(await statusOf(id)).toBe('published');
  });
});

describe('permissions', () => {
  it('seeds procedure.read, procedure.author and procedure.publish for the intended roles', async () => {
    const rows = await owner().query<{ role: string; permission: string }>(
      `SELECT role, permission FROM role_permissions WHERE permission LIKE 'procedure.%' ORDER BY permission, role`,
    );
    expect(rows.rows.map((row) => `${row.permission}:${row.role}`)).toEqual([
      'procedure.author:head',
      'procedure.author:lead',
      'procedure.publish:head',
      'procedure.publish:lead',
      'procedure.read:agent',
      'procedure.read:dev',
      'procedure.read:head',
      'procedure.read:lead',
    ]);
  });
});

describe('0097 goes down and up again', () => {
  it('drops the tables and the functions and brings them back', async () => {
    const later = await migrationsAfter('0097_procedures');
    const reverted = await migrateDown(owner(), { steps: later.length + 1 });
    expect(reverted[reverted.length - 1]).toBe('0097_procedures');
    expect(await sqlstate(owner().query(`SELECT 1 FROM procedure_version`))).toBe(UNDEFINED_TABLE);
    expect(await sqlstate(owner().query(`SELECT 1 FROM procedure_simulation`))).toBe(
      UNDEFINED_TABLE,
    );
    expect(
      (await owner().query(`SELECT 1 FROM pg_proc WHERE proname LIKE '%procedure_version%'`))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await owner().query(
          `SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_run' AND column_name = 'procedure_version_id'`,
        )
      ).rowCount,
    ).toBe(0);

    expect(await migrateUp(owner())).toEqual(['0097_procedures', ...later]);
    expect((await owner().query(`SELECT 1 FROM procedure_version`)).rowCount).toBe(0);
    expect(
      (
        await owner().query(
          `SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_run' AND column_name = 'procedure_version_id'`,
        )
      ).rowCount,
    ).toBe(1);
  });
});
