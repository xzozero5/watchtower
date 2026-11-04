import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0109 (T-306e, ADR-025 section 7): ai_replay_result, ai_run.response_model, the sampling setting.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';
const RESTRICT_VIOLATION = '23001';
const UNDEFINED_TABLE = '42P01';

let testDb: TestDatabase;
let app: Pool;
let intentId = '';
let headId = '';
let agentId = '';
const owner = () => testDb.owner.pool;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 2 });
  intentId =
    (
      await owner().query<{ id: string }>(
        `INSERT INTO intent (key, name) VALUES ('replay_test', 'Replay test') RETURNING id`,
      )
    ).rows[0]?.id ?? '';
  headId =
    (
      await owner().query<{ id: string }>(
        `INSERT INTO users (email, name, role) VALUES ('head@example.test', 'Head', 'head') RETURNING id`,
      )
    ).rows[0]?.id ?? '';
  agentId =
    (
      await owner().query<{ id: string }>(
        `INSERT INTO users (email, name, role) VALUES ('agent@example.test', 'Agent', 'agent') RETURNING id`,
      )
    ).rows[0]?.id ?? '';
});
afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

const code = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const record = (
  actor: string,
  over: Partial<{ caseCount: number; violations: number; redaction: boolean; mock: boolean }> = {},
) =>
  app.query<{ id: string }>(
    `SELECT public.record_replay_result($1::uuid, $2::uuid, 'eval', 'sonnet', 'opus', 2, 1, NULL, $3::int, $4::int, $5::boolean, $6::boolean) AS id`,
    [
      actor,
      intentId,
      over.caseCount ?? 10,
      over.violations ?? 0,
      over.redaction ?? true,
      over.mock ?? false,
    ],
  );
const passedOf = async (id: string) =>
  (
    await owner().query<{ passed: boolean }>(`SELECT passed FROM ai_replay_result WHERE id = $1`, [
      id,
    ])
  ).rows[0]?.passed;

describe('ai_replay_result', () => {
  it('is written only through record_replay_result(), by a person who holds ai.autonomy.promote', async () => {
    expect(
      await code(
        app.query(
          `INSERT INTO ai_replay_result (intent_id, source, drafter_model, grader_model, drafter_prompt_version,
             grader_prompt_version, case_count, violations, redaction_passed, passed, recorded_by)
           VALUES ($1, 'eval', 'a', 'b', 1, 1, 5, 0, true, true, $2)`,
          [intentId, headId],
        ),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await code(record(agentId))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await code(record('00000000-0000-4000-8000-000000000000'))).toBe(INSUFFICIENT_PRIVILEGE);
    const made = await record(headId);
    expect(await passedOf(made.rows[0]?.id ?? '')).toBe(true);
  });

  it('is never passed for a mock run, an empty run, a violation or a failed redaction eval', async () => {
    for (const over of [
      { mock: true },
      { caseCount: 0 },
      { violations: 1 },
      { redaction: false },
    ]) {
      const made = await record(headId, over);
      expect(await passedOf(made.rows[0]?.id ?? ''), JSON.stringify(over)).toBe(false);
    }
    // And the table itself refuses a row that says otherwise.
    expect(
      await code(
        owner().query(
          `INSERT INTO ai_replay_result (intent_id, source, drafter_model, grader_model, drafter_prompt_version,
             grader_prompt_version, case_count, violations, redaction_passed, mock, passed, recorded_by)
           VALUES ($1, 'eval', 'a', 'b', 1, 1, 5, 0, true, true, true, $2)`,
          [intentId, headId],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('is append-only, even for the schema owner', async () => {
    const made = await record(headId);
    const id = made.rows[0]?.id ?? '';
    expect(
      await code(owner().query(`UPDATE ai_replay_result SET passed = false WHERE id = $1`, [id])),
    ).toBe(RESTRICT_VIOLATION);
    expect(await code(owner().query(`DELETE FROM ai_replay_result WHERE id = $1`, [id]))).toBe(
      RESTRICT_VIOLATION,
    );
  });
});

describe('ai_run.response_model', () => {
  const insert = (model: string | null) =>
    app.query(
      `INSERT INTO ai_run (started_at, agent, provider, model, response_model, tier, prompt_id, prompt_version, prompt_hash,
                           input_hmac, redaction, status)
       VALUES (now(), 'grader', 'anthropic', 'opus', $1, 'deep', 'grader_pre_send', 1, repeat('a', 64), repeat('b', 64),
               '{"total":0,"byKind":{}}', 'ok')`,
      [model],
    );
  it('holds the id the provider answered with, or null, never an empty or very long string', async () => {
    await insert('claude-opus-dated');
    await insert(null);
    expect(await code(insert(''))).toBe(CHECK_VIOLATION);
    expect(await code(insert('x'.repeat(201)))).toBe(CHECK_VIOLATION);
  });
});

describe('the sampling setting', () => {
  it('starts at 100% of the first 20 and 20% after, and a bad value is refused', async () => {
    const row = await owner().query<{ value: Record<string, number> }>(
      `SELECT value FROM instance_setting WHERE key = 'autosend.sampling'`,
    );
    expect(row.rows[0]?.value).toEqual({ initialCount: 20, initialPercent: 100, percent: 20 });
    const set = (value: unknown) =>
      app.query(`UPDATE instance_setting SET value = $1::jsonb WHERE key = 'autosend.sampling'`, [
        JSON.stringify(value),
      ]);
    await set({ initialCount: 0, initialPercent: 0, percent: 100 });
    for (const bad of [
      { initialCount: 20, initialPercent: 101, percent: 20 },
      { initialCount: -1, initialPercent: 100, percent: 20 },
      { initialCount: 20, initialPercent: 100, percent: 20.5 },
      { initialCount: 20, initialPercent: 100 },
      { initialCount: '20', initialPercent: 100, percent: 20 },
      [],
    ]) {
      expect(await code(set(bad)), JSON.stringify(bad)).toBe(CHECK_VIOLATION);
    }
  });
});

describe('0109 goes down and up again', () => {
  it('drops the table, the column and the setting, and brings them back', async () => {
    const later = await migrationsAfter('0109_replay_result_run_model');
    const reverted = await migrateDown(owner(), { steps: later.length + 1 });
    expect(reverted[reverted.length - 1]).toBe('0109_replay_result_run_model');
    expect(await code(owner().query(`SELECT 1 FROM ai_replay_result`))).toBe(UNDEFINED_TABLE);
    expect(
      (await owner().query(`SELECT 1 FROM instance_setting WHERE key = 'autosend.sampling'`))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await owner().query(
          `SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_run' AND column_name = 'response_model'`,
        )
      ).rowCount,
    ).toBe(0);

    expect(await migrateUp(owner())).toEqual(['0109_replay_result_run_model', ...later]);
    expect((await owner().query(`SELECT 1 FROM ai_replay_result`)).rowCount).toBe(0);
  });
});
