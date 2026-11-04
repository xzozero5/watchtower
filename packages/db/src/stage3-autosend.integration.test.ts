import { createHash } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from './client.js';
import { migrateDown, migrateUp } from './migrator.js';
import { setOwnerApproval } from './owner-approval.js';
import { createTestDatabase, migrationsAfter, type TestDatabase } from './testing.js';

// Migration 0096 (T-304b, ADR-025): stage 3 is reachable only through the promotion door, an ai_auto
// delivery needs a fresh independent grade of exactly its text, seed data is marked by the schema owner
// only, and the whole thing goes down again. `app` is the restricted login role of the api and worker.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const CHECK_VIOLATION = '23514';
const INTEGRITY = '23000';
const INSUFFICIENT_PRIVILEGE = '42501';
const RESTRICT_VIOLATION = '23001';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

let testDb: TestDatabase;
let app: Pool;
const owner = (): Pool => testDb.owner.pool;

async function scalar<T>(pool: Pool, text: string, values: unknown[] = []): Promise<T> {
  const result = await pool.query<{ value: T }>(text, values);
  const row = result.rows[0];
  if (row === undefined) throw new Error('query returned no row');
  return row.value;
}

let head: string;
let ownerPerson: string;
let agent: string;
let counter = 0;
const unique = (prefix: string): string => `${prefix}_${String((counter += 1))}`;

async function newIntent(): Promise<{ id: string; key: string }> {
  const key = unique('intent');
  const id = await scalar<string>(
    app,
    `INSERT INTO intent (key, name) VALUES ($1, 'Probe') RETURNING id AS value`,
    [key],
  );
  return { id, key };
}

async function newReport(
  intentId: string,
  overrides: { status?: string; windowDays?: number; generatedDaysAgo?: number } = {},
): Promise<string> {
  const status = overrides.status ?? 'green';
  const windowDays = overrides.windowDays ?? 30;
  const generatedDaysAgo = overrides.generatedDaysAgo ?? 0;
  return scalar<string>(
    app,
    `INSERT INTO autonomy_gate_report (intent_id, status, trigger_kind, window_start, window_end, generated_at)
     VALUES ($1, $2, 'on_demand', now() - make_interval(days => $3), now(), now() - make_interval(days => $4))
     RETURNING id AS value`,
    [intentId, status, windowDays, generatedDaysAgo],
  );
}

const request = (intentId: string, reportId: string, actor = head, reason = 'ready for stage 3') =>
  app.query<{ value: string }>(
    'SELECT request_stage_promotion($1::uuid, $2::uuid, $3::uuid, $4) AS value',
    [intentId, reportId, actor, reason],
  );
const decide = (
  promotionId: string,
  approve: boolean,
  actor: string,
  key: string,
  reauth = 'now()',
  reason = 'approved by the owner',
) =>
  app.query<{ value: string }>(
    `SELECT decide_stage_promotion($1::uuid, $2, $3::uuid, $4, ${reauth}, $5) AS value`,
    [promotionId, approve, actor, reason, key],
  );
const apply = (promotionId: string, actor = ownerPerson) =>
  app.query<{ value: string }>('SELECT apply_stage_promotion($1::uuid, $2::uuid) AS value', [
    promotionId,
    actor,
  ]);

/** The whole door: report, request by the head, approval by the owner, apply. */
async function promoteToStage3(intent: { id: string; key: string }): Promise<string> {
  const report = await newReport(intent.id);
  const promotionId = (await request(intent.id, report)).rows[0]?.value ?? '';
  await decide(promotionId, true, ownerPerson, intent.key);
  expect((await apply(promotionId)).rows[0]?.value).toBe('applied');
  return promotionId;
}

async function stageOf(intentId: string): Promise<number> {
  return scalar<number>(owner(), 'SELECT autonomy_stage::int AS value FROM intent WHERE id = $1', [
    intentId,
  ]);
}

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = new Pool({ connectionString: testDb.appUrl, max: 4 });
  head = await scalar<string>(
    owner(),
    `INSERT INTO users (email, name, role) VALUES ('head@example.com', 'H', 'head') RETURNING id AS value`,
  );
  agent = await scalar<string>(
    owner(),
    `INSERT INTO users (email, name, role) VALUES ('agent@example.com', 'A', 'agent') RETURNING id AS value`,
  );
  // The owner is a person in the head role who also holds the owner permission (granted by the schema owner).
  ownerPerson = await scalar<string>(
    owner(),
    `INSERT INTO users (email, name, role, permissions)
     VALUES ('owner@example.com', 'O', 'head', ARRAY['ai.autonomy.owner_approve']) RETURNING id AS value`,
  );
});

afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

describe('the stage 3 ceiling and the promotion door', () => {
  it('lets stage 0 to 3 exist and nothing above', async () => {
    await expect(
      owner().query(`INSERT INTO intent (key, name, autonomy_stage) VALUES ('probe_4', 'P', 4)`),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      owner().query(`INSERT INTO intent (key, name, autonomy_stage) VALUES ('probe_m1', 'P', -1)`),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('refuses to create an intent at stage 3, for the owner and the application alike', async () => {
    for (const pool of [owner(), app]) {
      await expect(
        pool.query(`INSERT INTO intent (key, name, autonomy_stage) VALUES ($1, 'P', 3)`, [
          unique('direct3'),
        ]),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(23514|42501)$/) as string });
    }
  });

  it('refuses a direct UPDATE to stage 3 and set_intent_autonomy(3) (WT003)', async () => {
    const intent = await newIntent();
    await expect(
      app.query('UPDATE intent SET autonomy_stage = 3 WHERE id = $1', [intent.id]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    // Even the schema owner is stopped by the trigger: no approved promotion, no stage 3.
    await expect(
      owner().query('UPDATE intent SET autonomy_stage = 3 WHERE id = $1', [intent.id]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      app.query('SELECT set_intent_autonomy($1::uuid, 3::smallint, NULL, $2::uuid, $3)', [
        intent.id,
        head,
        'skip the line',
      ]),
    ).rejects.toMatchObject({ code: 'WT003' });
    expect(await stageOf(intent.id)).toBe(2);
  });

  it('still refuses the owner UPDATE while the promotion is only requested', async () => {
    const intent = await newIntent();
    const report = await newReport(intent.id);
    await request(intent.id, report);
    await expect(
      owner().query('UPDATE intent SET autonomy_stage = 3 WHERE id = $1', [intent.id]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('does not let the application write promotions, reports are append-only', async () => {
    const intent = await newIntent();
    const report = await newReport(intent.id);
    await expect(
      app.query(
        `INSERT INTO intent_autonomy_promotion (intent_id, gate_report_id, requested_by, request_reason)
         VALUES ($1, $2, $3, 'forged')`,
        [intent.id, report, head],
      ),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      app.query(`UPDATE autonomy_gate_report SET status = 'red' WHERE id = $1`, [report]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      owner().query(`UPDATE autonomy_gate_report SET status = 'red' WHERE id = $1`, [report]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    // A green report must exclude seed data and cover 28 days.
    await expect(newReport(intent.id, { windowDays: 20 })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
  });

  it('refuses a request that does not meet the conditions, with a reason code', async () => {
    const intent = await newIntent();
    // Not a head.
    await expect(request(intent.id, await newReport(intent.id), agent)).rejects.toMatchObject({
      code: 'WT004',
    });
    // A report that is not green, too old, or about another intent.
    await expect(
      request(intent.id, await newReport(intent.id, { status: 'red' })),
    ).rejects.toMatchObject({
      code: 'WT011',
      message: expect.stringContaining('report_not_green') as string,
    });
    await expect(
      request(intent.id, await newReport(intent.id, { generatedDaysAgo: 8 })),
    ).rejects.toMatchObject({
      code: 'WT011',
      message: expect.stringContaining('report_too_old') as string,
    });
    const other = await newIntent();
    await expect(request(intent.id, await newReport(other.id))).rejects.toMatchObject({
      code: 'WT011',
      message: expect.stringContaining('report_not_found') as string,
    });
    // Reason length.
    await expect(request(intent.id, await newReport(intent.id), head, 'no')).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    // An intent that is not at stage 2.
    const low = await newIntent();
    await app.query('SELECT set_intent_autonomy($1::uuid, 1::smallint, NULL, $2::uuid, $3)', [
      low.id,
      head,
      'lowered for a while',
    ]);
    await expect(request(low.id, await newReport(low.id))).rejects.toMatchObject({
      code: 'WT011',
      message: expect.stringContaining('not_at_stage_2') as string,
    });
  });

  it('wants the whole window at stage 2: a change inside it blocks the request', async () => {
    const intent = await newIntent();
    await app.query('SELECT set_intent_autonomy($1::uuid, 1::smallint, NULL, $2::uuid, $3)', [
      intent.id,
      head,
      'dip down',
    ]);
    await app.query('SELECT set_intent_autonomy($1::uuid, 2::smallint, NULL, $2::uuid, $3)', [
      intent.id,
      head,
      'back up to two',
    ]);
    await expect(request(intent.id, await newReport(intent.id))).rejects.toMatchObject({
      code: 'WT011',
      message: expect.stringContaining('window_not_at_stage_2') as string,
    });
  });

  it('refuses while the stage cap switch is on, or the intent is pinned', async () => {
    const intent = await newIntent();
    const report = await newReport(intent.id);
    await app.query('SELECT set_ai_switch($1, true, $2::uuid, $3)', [
      'ai_stage_cap_pinned',
      head,
      'cap on',
    ]);
    try {
      await expect(request(intent.id, report)).rejects.toMatchObject({
        code: 'WT011',
        message: expect.stringContaining('stage_cap_on') as string,
      });
    } finally {
      await app.query('SELECT set_ai_switch($1, false, $2::uuid, $3)', [
        'ai_stage_cap_pinned',
        head,
        'cap off',
      ]);
    }
    await app.query('SELECT set_intent_autonomy($1::uuid, NULL, true, $2::uuid, $3)', [
      intent.id,
      head,
      'pin it',
    ]);
    await expect(request(intent.id, report)).rejects.toMatchObject({
      code: 'WT011',
      message: expect.stringContaining('pinned') as string,
    });
  });

  it('needs the owner permission, a fresh re-auth and the typed key to approve', async () => {
    const intent = await newIntent();
    const promotionId = (await request(intent.id, await newReport(intent.id))).rows[0]?.value ?? '';
    // A head without the owner permission cannot approve, even another person's request.
    await expect(decide(promotionId, true, head, intent.key)).rejects.toMatchObject({
      code: 'WT004',
    });
    // Re-auth too old, in the future, or missing; wrong or empty key.
    await expect(
      decide(promotionId, true, ownerPerson, intent.key, `now() - interval '6 minutes'`),
    ).rejects.toMatchObject({ code: 'WT012' });
    await expect(
      decide(promotionId, true, ownerPerson, intent.key, `now() + interval '2 minutes'`),
    ).rejects.toMatchObject({ code: 'WT012' });
    await expect(
      decide(promotionId, true, ownerPerson, intent.key, 'NULL::timestamptz'),
    ).rejects.toMatchObject({
      code: 'WT012',
    });
    await expect(decide(promotionId, true, ownerPerson, 'wrong_key')).rejects.toMatchObject({
      code: 'WT012',
    });
    await expect(decide(promotionId, true, ownerPerson, '')).rejects.toMatchObject({
      code: 'WT012',
    });
    expect(
      await scalar<string>(
        owner(),
        'SELECT status AS value FROM intent_autonomy_promotion WHERE id = $1',
        [promotionId],
      ),
    ).toBe('requested');
    // Nothing happened to the stage.
    expect(await stageOf(intent.id)).toBe(2);
    // The one that holds the permission, inside 5 minutes, with the key, can.
    expect((await decide(promotionId, true, ownerPerson, intent.key)).rows[0]?.value).toBe(
      'approved',
    );
    const row = await owner().query<{ self_approved: boolean; decided_by: string }>(
      'SELECT self_approved, decided_by FROM intent_autonomy_promotion WHERE id = $1',
      [promotionId],
    );
    expect(row.rows[0]).toEqual({ self_approved: false, decided_by: ownerPerson });
  });

  it('lets the owner approve a request of their own, flagged self_approved (owner decision 1)', async () => {
    const intent = await newIntent();
    const promotionId =
      (await request(intent.id, await newReport(intent.id), ownerPerson)).rows[0]?.value ?? '';
    expect((await decide(promotionId, true, ownerPerson, intent.key)).rows[0]?.value).toBe(
      'approved',
    );
    const row = await owner().query<{ self_approved: boolean }>(
      'SELECT self_approved FROM intent_autonomy_promotion WHERE id = $1',
      [promotionId],
    );
    expect(row.rows[0]?.self_approved).toBe(true);
    expect((await apply(promotionId)).rows[0]?.value).toBe('applied');
    expect(await stageOf(intent.id)).toBe(3);
  });

  it('does not let a head without the owner permission approve their own request', async () => {
    const intent = await newIntent();
    const promotionId =
      (await request(intent.id, await newReport(intent.id), head)).rows[0]?.value ?? '';
    await expect(decide(promotionId, true, head, intent.key)).rejects.toMatchObject({
      code: 'WT004',
    });
    // The table itself says the same, whoever writes it (CHECK requested_by <> decided_by unless self_approved).
    await expect(
      owner().query(
        `UPDATE intent_autonomy_promotion SET status = 'approved', decided_by = requested_by, decided_at = now(),
           decision_reason = 'forged', reauth_at = now(), confirmed_key = $2 WHERE id = $1`,
        [promotionId, intent.key],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('applies an approved promotion once: stage 3, a history row, no second apply', async () => {
    const intent = await newIntent();
    const promotionId = await promoteToStage3(intent);
    expect(await stageOf(intent.id)).toBe(3);
    const history = await owner().query<{
      change: string;
      from_stage: number;
      to_stage: number;
      promotion_id: string;
      changed_by: string;
    }>(
      `SELECT change, from_stage, to_stage, promotion_id, changed_by FROM intent_autonomy_history
        WHERE intent_id = $1 ORDER BY changed_at`,
      [intent.id],
    );
    expect(history.rows).toEqual([
      {
        change: 'promotion',
        from_stage: 2,
        to_stage: 3,
        promotion_id: promotionId,
        changed_by: ownerPerson,
      },
    ]);
    await expect(apply(promotionId)).rejects.toMatchObject({ code: 'WT014' });
    // The application cannot undo or redo it by hand.
    await expect(
      app.query(`UPDATE intent_autonomy_promotion SET status = 'approved' WHERE id = $1`, [
        promotionId,
      ]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });

  it('expires an approval after 72 hours', async () => {
    const intent = await newIntent();
    const promotionId = (await request(intent.id, await newReport(intent.id))).rows[0]?.value ?? '';
    await decide(promotionId, true, ownerPerson, intent.key);
    await owner().query(
      `UPDATE intent_autonomy_promotion SET decided_at = now() - interval '73 hours' WHERE id = $1`,
      [promotionId],
    );
    expect((await apply(promotionId)).rows[0]?.value).toBe('expired');
    expect(await stageOf(intent.id)).toBe(2);
    // The stale approval does not open the trigger for a direct write either.
    await expect(
      owner().query('UPDATE intent SET autonomy_stage = 3 WHERE id = $1', [intent.id]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('blocks the apply when the report went stale or the cap came on after the approval', async () => {
    const intent = await newIntent();
    const promotionId = (await request(intent.id, await newReport(intent.id))).rows[0]?.value ?? '';
    await decide(promotionId, true, ownerPerson, intent.key);
    await app.query('SELECT set_ai_switch($1, true, $2::uuid, $3)', [
      'ai_stage_cap_pinned',
      head,
      'cap on',
    ]);
    try {
      await expect(apply(promotionId)).rejects.toMatchObject({ code: 'WT011' });
    } finally {
      await app.query('SELECT set_ai_switch($1, false, $2::uuid, $3)', [
        'ai_stage_cap_pinned',
        head,
        'cap off',
      ]);
    }
    expect((await apply(promotionId)).rows[0]?.value).toBe('applied');
  });

  it('lets only one request stay open per intent, and a rejection or withdrawal closes it', async () => {
    const intent = await newIntent();
    const report = await newReport(intent.id);
    const first = (await request(intent.id, report)).rows[0]?.value ?? '';
    await expect(request(intent.id, report)).rejects.toMatchObject({ code: '23505' });
    expect(
      (await decide(first, false, head, intent.key, 'now()', 'changed my mind')).rows[0]?.value,
    ).toBe('cancelled');
    const second = (await request(intent.id, report)).rows[0]?.value ?? '';
    expect(
      (await decide(second, false, ownerPerson, intent.key, 'now()', 'not yet')).rows[0]?.value,
    ).toBe('rejected');
    await expect(decide(second, true, ownerPerson, intent.key)).rejects.toMatchObject({
      code: 'WT014',
    });
  });

  it('rolls back to stage 2 by itself: idempotent, no person behind the history row', async () => {
    const intent = await newIntent();
    await promoteToStage3(intent);
    const first = await scalar<number>(
      app,
      `SELECT rollback_intent_autonomy($1::uuid, $2, '{"trigger":"policy_violation"}'::jsonb) AS value`,
      [intent.id, 'policy violation found'],
    );
    expect(first).toBe(1);
    expect(await stageOf(intent.id)).toBe(2);
    expect(
      await scalar<number>(app, `SELECT rollback_intent_autonomy($1::uuid, $2, NULL) AS value`, [
        intent.id,
        'again',
      ]),
    ).toBe(0);
    const row = await owner().query<{ changed_by: string | null; evidence: { trigger: string } }>(
      `SELECT changed_by, evidence FROM intent_autonomy_history WHERE intent_id = $1 AND change = 'auto_rollback'`,
      [intent.id],
    );
    expect(row.rows).toEqual([{ changed_by: null, evidence: { trigger: 'policy_violation' } }]);
    // The old report cannot promote it again: the window that counts starts after the rollback.
    await expect(request(intent.id, await newReport(intent.id))).rejects.toMatchObject({
      code: 'WT011',
      message: expect.stringContaining('window_not_at_stage_2') as string,
    });
  });

  it('lets a person lower a stage 3 intent with set_intent_autonomy()', async () => {
    const intent = await newIntent();
    await promoteToStage3(intent);
    await app.query('SELECT set_intent_autonomy($1::uuid, 1::smallint, NULL, $2::uuid, $3)', [
      intent.id,
      head,
      'lowered by the head',
    ]);
    expect(await stageOf(intent.id)).toBe(1);
  });
});

describe('the rules of a stage 3 intent', () => {
  it('lets the application edit the auto-send rules below stage 3 and tighten them at 3', async () => {
    const intent = await newIntent();
    await app.query(
      `UPDATE intent SET autosend_shadow = true, autosend_min_score = 0.8, autosend_daily_cap = 50,
         autosend_policy = '{"channels":["gmail"]}'::jsonb WHERE id = $1`,
      [intent.id],
    );
    await promoteToStage3(intent);
    await app.query(
      `UPDATE intent SET autosend_min_score = 0.9, autosend_daily_cap = 10 WHERE id = $1`,
      [intent.id],
    );
    await app.query(`UPDATE intent SET autosend_shadow = false WHERE id = $1`, [intent.id]);
  });

  it('keeps score within 0.70 to 1.00 and the cap within 0 to 1000', async () => {
    const intent = await newIntent();
    await expect(
      app.query('UPDATE intent SET autosend_min_score = 0.69 WHERE id = $1', [intent.id]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      app.query('UPDATE intent SET autosend_daily_cap = 1001 WHERE id = $1', [intent.id]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await app.query('UPDATE intent SET autosend_min_score = 0.70 WHERE id = $1', [intent.id]);
  });

  it('makes a head and a history row necessary to loosen them at stage 3', async () => {
    const intent = await newIntent();
    await promoteToStage3(intent);
    for (const sql of [
      'UPDATE intent SET autosend_min_score = 0.75 WHERE id = $1',
      'UPDATE intent SET autosend_daily_cap = 21 WHERE id = $1',
      `UPDATE intent SET autosend_policy = '{"channels":["gmail","portal"]}'::jsonb WHERE id = $1`,
    ]) {
      await expect(app.query(sql, [intent.id])).rejects.toMatchObject({
        code: INSUFFICIENT_PRIVILEGE,
      });
    }
    await expect(
      app.query(
        `SELECT set_intent_autosend($1::uuid, NULL, 0.75, NULL, NULL, $2::uuid, 'agents may not') AS value`,
        [intent.id, agent],
      ),
    ).rejects.toMatchObject({ code: 'WT004' });
    expect(
      await scalar<number>(
        app,
        `SELECT set_intent_autosend($1::uuid, NULL, 0.75, 30, NULL, $2::uuid, 'wider while we watch') AS value`,
        [intent.id, head],
      ),
    ).toBe(1);
    const history = await owner().query<{
      change: string;
      evidence: { after: { min_score: string } };
    }>(
      `SELECT change, evidence FROM intent_autonomy_history WHERE intent_id = $1 AND change = 'autosend'`,
      [intent.id],
    );
    expect(history.rows).toHaveLength(1);
    expect(Number(history.rows[0]?.evidence.after.min_score)).toBe(0.75);
  });
});

describe('A-9, A-10, A-11', () => {
  it('stops the application from renaming an intent key or id, and from deleting an intent', async () => {
    const intent = await newIntent();
    await expect(
      app.query(`UPDATE intent SET key = 'renamed_in_place' WHERE id = $1`, [intent.id]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      app.query(`UPDATE intent SET id = gen_random_uuid() WHERE id = $1`, [intent.id]),
    ).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
    await expect(app.query('DELETE FROM intent WHERE id = $1', [intent.id])).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
    await app.query(`UPDATE intent SET name = 'still editable', is_active = false WHERE id = $1`, [
      intent.id,
    ]);
  });

  it('wants a reason of 3 to 500 characters from the switch function and the stage function', async () => {
    for (const reason of ['', '  ', 'ab', 'x'.repeat(501)]) {
      await expect(
        app.query('SELECT set_ai_switch($1, true, $2::uuid, $3)', ['ai_kill_switch', head, reason]),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
    const intent = await newIntent();
    await expect(
      app.query('SELECT set_intent_autonomy($1::uuid, 1::smallint, NULL, $2::uuid, $3)', [
        intent.id,
        head,
        'no',
      ]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await app.query('SELECT set_intent_autonomy($1::uuid, 1::smallint, NULL, $2::uuid, $3)', [
      intent.id,
      head,
      'abc',
    ]);
  });

  it('makes a partition created later as append-only as its parent, whatever the caller asks', async () => {
    const created = await scalar<number>(
      app,
      `SELECT ensure_monthly_partitions('audit_log'::regclass, 30, false) AS value`,
    );
    expect(created).toBeGreaterThan(0);
    const rows = await owner().query<{ relname: string; can_update: boolean; can_delete: boolean }>(
      `SELECT c.relname,
              has_table_privilege($1, c.oid, 'UPDATE') AS can_update,
              has_table_privilege($1, c.oid, 'DELETE') AS can_delete
         FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid
        WHERE i.inhparent = 'audit_log'::regclass`,
      [new URL(testDb.appUrl).username],
    );
    expect(rows.rows.length).toBeGreaterThan(30);
    for (const row of rows.rows) {
      expect(row.can_update, row.relname).toBe(false);
      expect(row.can_delete, row.relname).toBe(false);
    }
  });
});

describe('owner approval and TEMP tables against the doors', () => {
  it('grants and revokes the owner permission from the command line, with the owner connection only', async () => {
    const email = 'grantee@example.com';
    await owner().query(`INSERT INTO users (email, name, role) VALUES ($1, 'G', 'head')`, [email]);
    const granted = await setOwnerApproval(testDb.owner, email, true);
    expect(granted?.change).toBe('granted');
    expect((await setOwnerApproval(testDb.owner, email, true))?.change).toBe('unchanged');
    const holds = await scalar<boolean>(
      owner(),
      `SELECT 'ai.autonomy.owner_approve' = ANY (permissions) AS value FROM users WHERE email = $1`,
      [email],
    );
    expect(holds).toBe(true);
    const audit = await owner().query(
      `SELECT metadata FROM audit_log WHERE action = 'autonomy.owner_approval_set' AND target_id = $1`,
      [granted?.userId],
    );
    expect(audit.rows).toEqual([
      { metadata: { permission: 'ai.autonomy.owner_approve', granted: true } },
    ]);
    // The application connection is refused by the trigger.
    const asApp = createDatabase({
      url: testDb.appUrl,
      max: 1,
      applicationName: 'owner-approval-app',
    });
    try {
      await expect(setOwnerApproval(asApp, 'agent@example.com', true)).rejects.toThrow();
    } finally {
      await asApp.close();
    }
    expect((await setOwnerApproval(testDb.owner, email, false))?.change).toBe('revoked');
    expect(await setOwnerApproval(testDb.owner, 'nobody@example.com', true)).toBeNull();
  });

  it('lets only the schema owner give out the owner permission', async () => {
    await expect(
      app.query(`UPDATE users SET permissions = ARRAY['ai.autonomy.owner_approve'] WHERE id = $1`, [
        head,
      ]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      app.query(
        `INSERT INTO users (email, name, role, permissions) VALUES ('sneaky@example.com', 'S', 'agent', ARRAY['ai.autonomy.owner_approve'])`,
      ),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    // The application can still give other extras (a service identity).
    await app.query(`UPDATE users SET permissions = ARRAY['kb.read'] WHERE id = $1`, [agent]);
    await app.query(`UPDATE users SET permissions = '{}' WHERE id = $1`, [agent]);
  });

  it('is not fooled by a TEMP table that stands in for users, the report or the promotion', async () => {
    await owner().query(
      `GRANT TEMPORARY ON DATABASE ${testDb.name} TO ${new URL(testDb.appUrl).username}`,
    );
    const client = await app.connect();
    try {
      const intent = await newIntent();
      const realReport = await newReport(intent.id);
      await client.query('SET search_path = pg_temp, public');
      // A fake person who holds everything, a fake green report, a fake approved promotion.
      await client.query(
        `CREATE TEMP TABLE users (id uuid, status text, role text, permissions text[])`,
      );
      await client.query(
        `INSERT INTO users VALUES ($1, 'active', 'head', ARRAY['ai.autonomy.promote', 'ai.autonomy.owner_approve', 'ai.autonomy.set.any'])`,
        [agent],
      );
      await client.query('CREATE TEMP TABLE role_permissions (role text, permission text)');
      await client.query(`INSERT INTO role_permissions VALUES ('agent', 'ai.autonomy.promote')`);
      await client.query(
        'CREATE TEMP TABLE autonomy_gate_report (LIKE public.autonomy_gate_report)',
      );
      await client.query(
        `CREATE TEMP TABLE intent_autonomy_promotion (LIKE public.intent_autonomy_promotion)`,
      );
      await client.query(`CREATE TEMP TABLE intent (LIKE public.intent)`);
      // The "person" is an agent in the real table: the real answer is no.
      await expect(
        client.query('SELECT public.request_stage_promotion($1::uuid, $2::uuid, $3::uuid, $4)', [
          intent.id,
          realReport,
          agent,
          'let me in through the side door',
        ]),
      ).rejects.toMatchObject({ code: 'WT004' });
      await expect(
        client.query(
          `SELECT public.set_intent_autosend($1::uuid, NULL, 0.7, NULL, NULL, $2::uuid, 'fake head')`,
          [intent.id, agent],
        ),
      ).rejects.toMatchObject({ code: 'WT004' });
      // A promotion written into the shadow table does nothing to the real trigger.
      await client.query(
        `INSERT INTO pg_temp.intent_autonomy_promotion (id, requested_at, self_approved, intent_id, gate_report_id, status, requested_by, request_reason, decided_by, decided_at, decision_reason, reauth_at, confirmed_key)
         VALUES (gen_random_uuid(), now(), false, $1, $2, 'approved', $3, 'fake', $4, now(), 'fake', now(), 'k')`,
        [intent.id, realReport, head, agent],
      );
      await expect(
        owner().query('UPDATE public.intent SET autonomy_stage = 3 WHERE id = $1', [intent.id]),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
      expect(await stageOf(intent.id)).toBe(2);
    } finally {
      client.release(true);
      await owner().query(
        `REVOKE TEMPORARY ON DATABASE ${testDb.name} FROM ${new URL(testDb.appUrl).username}`,
      );
    }
  });
});

describe('seed batches', () => {
  it('lets the schema owner mark rows and nobody else', async () => {
    await expect(app.query(`INSERT INTO seed_batch (kind) VALUES ('demo')`)).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
    const batch = await scalar<string>(
      owner(),
      `INSERT INTO seed_batch (kind, note) VALUES ('demo', 'test') RETURNING id AS value`,
    );
    await expect(
      owner().query(`UPDATE seed_batch SET note = 'x' WHERE id = $1`, [batch]),
    ).rejects.toMatchObject({
      code: RESTRICT_VIOLATION,
    });
    await expect(
      owner().query(`INSERT INTO seed_batch (kind) VALUES ('other')`),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    const org = await scalar<string>(
      owner(),
      `INSERT INTO organization (name, seed_batch_id) VALUES ($1, $2) RETURNING id AS value`,
      [unique('Seed Org'), batch],
    );
    const ticket = await scalar<string>(
      owner(),
      `INSERT INTO ticket (subject, org_id, seed_batch_id) VALUES ('seed ticket', $1, $2) RETURNING id AS value`,
      [org, batch],
    );
    // The application cannot set, clear or move the batch of a row.
    await expect(
      app.query('UPDATE ticket SET seed_batch_id = NULL WHERE id = $1', [ticket]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      app.query('UPDATE organization SET seed_batch_id = NULL WHERE id = $1', [org]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      app.query(`INSERT INTO ticket (subject, org_id, seed_batch_id) VALUES ('mark me', $1, $2)`, [
        org,
        batch,
      ]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    // It can still use the row like any other.
    await app.query(`UPDATE ticket SET subject = 'renamed by staff' WHERE id = $1`, [ticket]);
    // A seed ticket lives in an organization of its own batch.
    const realOrg = await scalar<string>(
      owner(),
      `INSERT INTO organization (name) VALUES ($1) RETURNING id AS value`,
      [unique('Real Org')],
    );
    await expect(
      owner().query(
        `INSERT INTO ticket (subject, org_id, seed_batch_id) VALUES ('stray', $1, $2)`,
        [realOrg, batch],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      app.query(`UPDATE ticket SET org_id = $2 WHERE id = $1`, [ticket, realOrg]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    // The ordinary insert by the application leaves it null.
    const plain = await scalar<string | null>(
      app,
      `INSERT INTO ticket (subject, org_id) VALUES ('plain', $1) RETURNING seed_batch_id AS value`,
      [realOrg],
    );
    expect(plain).toBeNull();
  });

  it('has the partial index the reports read through', async () => {
    const def = await scalar<string>(
      owner(),
      `SELECT indexdef AS value FROM pg_indexes WHERE indexname = 'ticket_intent_resolved_real_idx'`,
    );
    expect(def).toContain('WHERE (seed_batch_id IS NULL)');
  });
});

describe('an ai_auto delivery', () => {
  let orgId: string;
  let accountId: string;

  beforeAll(async () => {
    orgId = await scalar<string>(
      owner(),
      `INSERT INTO organization (name) VALUES ('Auto Org') RETURNING id AS value`,
    );
    accountId = await scalar<string>(
      owner(),
      `INSERT INTO channel_account (type, name) VALUES ('gmail', 'support@example.com') RETURNING id AS value`,
    );
  });

  interface Fixture {
    intent: { id: string; key: string };
    ticketId: string;
    draftId: string;
    messageId: string;
    text: string;
  }

  async function fixture(
    options: {
      priority?: string;
      attachments?: string;
      senderUser?: string | null;
      text?: string;
    } = {},
  ): Promise<Fixture> {
    const intent = await newIntent();
    await promoteToStage3(intent);
    const ticketId = await scalar<string>(
      app,
      `INSERT INTO ticket (subject, org_id, intent_id, channel, channel_account_id, priority)
       VALUES ('auto', $1, $2, 'gmail', $3, $4) RETURNING id AS value`,
      [orgId, intent.id, accountId, options.priority ?? 'P3'],
    );
    const text = options.text ?? `Hello, we reset it for you. (${unique('t')})`;
    const messageId = await scalar<string>(
      owner(),
      `INSERT INTO message (ticket_id, channel_account_id, direction, body_text, visibility, sender_user_id, attachments)
       VALUES ($1, $2, 'outbound', $3, 'public', $4, $5::jsonb) RETURNING id AS value`,
      [ticketId, accountId, text, options.senderUser ?? null, options.attachments ?? '[]'],
    );
    const draftId = await scalar<string>(
      app,
      `INSERT INTO ai_draft (ticket_id, body_text) VALUES ($1, $2) RETURNING id AS value`,
      [ticketId, 'Hello, we reset it for you.'],
    );
    return { intent, ticketId, draftId, messageId, text };
  }

  async function grade(
    f: Fixture,
    options: {
      text?: string;
      graderModel?: string;
      drafterModel?: string;
      passed?: boolean;
      score?: number;
      minutesAgo?: number;
      phase?: string;
      mock?: boolean;
    } = {},
  ): Promise<string> {
    const violations = options.passed === false ? '[{"code":"uncited"}]' : '[]';
    return scalar<string>(
      app,
      `INSERT INTO ai_grade (ai_draft_id, ticket_id, phase, graded_text, content_hash, grader_provider, grader_model,
                             drafter_provider, drafter_model, score, passed, violations, violation_count, prompt_version, mock, graded_at)
       VALUES ($1, $2, $3, $4, 'ffff', 'claude-cli', $5, 'claude-cli', $6, $7, $8, $9::jsonb, $10, 1, $11,
               now() - make_interval(mins => $12)) RETURNING id AS value`,
      [
        f.draftId,
        f.ticketId,
        options.phase ?? 'pre_send',
        options.text ?? f.text,
        options.graderModel ?? 'opus',
        options.drafterModel ?? 'sonnet',
        options.score ?? 0.95,
        options.passed ?? true,
        violations,
        options.passed === false ? 1 : 0,
        options.mock ?? false,
        options.minutesAgo ?? 0,
      ],
    );
  }

  const autoApprove = (draftId: string) =>
    app.query(
      `UPDATE ai_draft SET status = 'auto_approved', auto_approved_at = now() WHERE id = $1`,
      [draftId],
    );

  const insertDelivery = (
    f: Fixture,
    gradeId: string | null,
    overrides: {
      channel?: string;
      hold?: number;
      createdBy?: string | null;
      approvedBy?: string | null;
    } = {},
  ) =>
    app.query(
      `INSERT INTO outbound_delivery (ticket_id, message_id, channel_account_id, channel, origin, ai_draft_id, ai_grade_id,
                                      content_hash, approved_by, created_by, hold_seconds, next_attempt_at)
       VALUES ($1, $2, $3, $4, 'ai_auto', $5, $6, $7, $8, $9, $10, now() + interval '120 seconds')`,
      [
        f.ticketId,
        f.messageId,
        accountId,
        overrides.channel ?? 'gmail',
        f.draftId,
        gradeId,
        sha256('0'),
        overrides.approvedBy ?? null,
        overrides.createdBy ?? null,
        overrides.hold ?? 120,
      ],
    );

  it('goes through with a fresh, passing, independent grade of exactly its text', async () => {
    const f = await fixture();
    const gradeId = await grade(f);
    await autoApprove(f.draftId);
    await insertDelivery(f, gradeId);
    const row = await owner().query<{
      origin: string;
      content_hash: string;
      created_by: string | null;
      approved_by: string | null;
    }>(
      'SELECT origin, content_hash, created_by, approved_by FROM outbound_delivery WHERE ticket_id = $1',
      [f.ticketId],
    );
    expect(row.rows).toEqual([
      { origin: 'ai_auto', content_hash: sha256(f.text), created_by: null, approved_by: null },
    ]);
    // The grade clears one send.
    const second = await fixture();
    await expect(insertDelivery({ ...second, ticketId: f.ticketId }, gradeId)).rejects.toThrow();
  });

  it('computes the grade hash from the text, whatever the caller writes', async () => {
    const f = await fixture();
    const gradeId = await grade(f);
    expect(
      await scalar<string>(owner(), 'SELECT content_hash AS value FROM ai_grade WHERE id = $1', [
        gradeId,
      ]),
    ).toBe(sha256(f.text));
  });

  it('refuses the draft status without a grade, and with one that is not good enough', async () => {
    const none = await fixture();
    await expect(autoApprove(none.draftId)).rejects.toMatchObject({ code: INTEGRITY });
    const stale = await fixture();
    await grade(stale, { minutesAgo: 11 });
    await expect(autoApprove(stale.draftId)).rejects.toMatchObject({ code: INTEGRITY });
    const sameModel = await fixture();
    await grade(sameModel, { graderModel: 'sonnet', drafterModel: 'sonnet' });
    await expect(autoApprove(sameModel.draftId)).rejects.toMatchObject({ code: INTEGRITY });
    const failed = await fixture();
    await grade(failed, { passed: false });
    await expect(autoApprove(failed.draftId)).rejects.toMatchObject({ code: INTEGRITY });
    const low = await fixture();
    await grade(low, { score: 0.6 });
    await expect(autoApprove(low.draftId)).rejects.toMatchObject({ code: INTEGRITY });
    const mock = await fixture();
    await grade(mock, { mock: true });
    await expect(autoApprove(mock.draftId)).rejects.toMatchObject({ code: INTEGRITY });
    const sampled = await fixture();
    await grade(sampled, { phase: 'sampled' });
    await expect(autoApprove(sampled.draftId)).rejects.toMatchObject({ code: INTEGRITY });
  });

  it('refuses an insert at stage 2, with no grade, with another text, from a grader that is the drafter', async () => {
    // Stage 2: the draft was approved, then the intent was rolled back before the delivery was written.
    const lowered = await fixture();
    const loweredGrade = await grade(lowered);
    await autoApprove(lowered.draftId);
    await app.query(`SELECT rollback_intent_autonomy($1::uuid, 'rolled back', NULL)`, [
      lowered.intent.id,
    ]);
    await expect(insertDelivery(lowered, loweredGrade)).rejects.toMatchObject({ code: INTEGRITY });

    const noGrade = await fixture();
    await grade(noGrade);
    await autoApprove(noGrade.draftId);
    await expect(insertDelivery(noGrade, null)).rejects.toMatchObject({ code: INTEGRITY });

    const other = await fixture();
    const otherGrade = await grade(other, { text: 'Some other text than the one in the message' });
    await grade(other); // a good grade of the right text is what lets the draft be auto-approved
    await autoApprove(other.draftId);
    await expect(insertDelivery(other, otherGrade)).rejects.toMatchObject({ code: INTEGRITY });

    const same = await fixture();
    await grade(same);
    await autoApprove(same.draftId);
    const sameGrade = await grade(same, { graderModel: 'sonnet', drafterModel: 'sonnet' });
    await expect(insertDelivery(same, sameGrade)).rejects.toMatchObject({ code: INTEGRITY });

    const stale = await fixture();
    const staleGrade = await grade(stale, { minutesAgo: 11 });
    await grade(stale);
    await autoApprove(stale.draftId);
    await expect(insertDelivery(stale, staleGrade)).rejects.toMatchObject({ code: INTEGRITY });
  });

  it('refuses attachments, an author, P1/P2, a switch that is on, other channels and a person behind it', async () => {
    const files = await fixture({ attachments: '[{"name":"a.txt"}]' });
    const filesGrade = await grade(files);
    await autoApprove(files.draftId);
    await expect(insertDelivery(files, filesGrade)).rejects.toMatchObject({ code: INTEGRITY });

    const authored = await fixture({ senderUser: head });
    const authoredGrade = await grade(authored);
    await autoApprove(authored.draftId);
    await expect(insertDelivery(authored, authoredGrade)).rejects.toMatchObject({
      code: INTEGRITY,
    });

    const urgent = await fixture({ priority: 'P2' });
    const urgentGrade = await grade(urgent);
    await autoApprove(urgent.draftId);
    await expect(insertDelivery(urgent, urgentGrade)).rejects.toMatchObject({ code: INTEGRITY });

    const line = await fixture();
    const lineGrade = await grade(line);
    await autoApprove(line.draftId);
    await expect(insertDelivery(line, lineGrade, { channel: 'line' })).rejects.toMatchObject({
      code: expect.stringMatching(/^(23000|23514)$/) as string,
    });

    const person = await fixture();
    const personGrade = await grade(person);
    await autoApprove(person.draftId);
    await expect(insertDelivery(person, personGrade, { createdBy: head })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    await expect(insertDelivery(person, personGrade, { approvedBy: head })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    // The hold is 30 to 300 seconds for an automatic send.
    await expect(insertDelivery(person, personGrade, { hold: 5 })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });

    const switched = await fixture();
    const switchedGrade = await grade(switched);
    await autoApprove(switched.draftId);
    await app.query('SELECT set_ai_switch($1, true, $2::uuid, $3)', [
      'ai_kill_switch',
      head,
      'stop everything',
    ]);
    try {
      await expect(insertDelivery(switched, switchedGrade)).rejects.toMatchObject({
        code: INTEGRITY,
      });
      // And no new draft can be auto-approved while it is on.
      const another = await fixture();
      await grade(another);
      await expect(autoApprove(another.draftId)).rejects.toMatchObject({ code: INTEGRITY });
    } finally {
      await app.query('SELECT set_ai_switch($1, false, $2::uuid, $3)', [
        'ai_kill_switch',
        head,
        'carry on',
      ]);
    }
  });

  it('keeps grades and evaluations append-only, and the grade must belong to the draft ticket', async () => {
    const f = await fixture();
    const gradeId = await grade(f);
    await expect(
      app.query(`UPDATE ai_grade SET passed = false WHERE id = $1`, [gradeId]),
    ).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
    await expect(
      owner().query(`UPDATE ai_grade SET passed = false WHERE id = $1`, [gradeId]),
    ).rejects.toMatchObject({
      code: RESTRICT_VIOLATION,
    });
    await expect(
      owner().query(`DELETE FROM ai_grade WHERE id = $1`, [gradeId]),
    ).rejects.toMatchObject({
      code: RESTRICT_VIOLATION,
    });
    const otherTicket = await scalar<string>(
      app,
      `INSERT INTO ticket (subject, org_id) VALUES ('elsewhere', $1) RETURNING id AS value`,
      [orgId],
    );
    await expect(grade({ ...f, ticketId: otherTicket })).rejects.toMatchObject({ code: INTEGRITY });
    // An evaluation: the result must agree with the list of failed conditions.
    await app.query(
      `INSERT INTO ai_autosend_evaluation (ai_draft_id, ticket_id, intent_id, mode, would_auto_send, failed_conditions, effective_stage, ai_grade_id)
       VALUES ($1, $2, $3, 'shadow', false, ARRAY['grader_not_independent'], 2, $4)`,
      [f.draftId, f.ticketId, f.intent.id, gradeId],
    );
    await expect(
      app.query(
        `INSERT INTO ai_autosend_evaluation (ai_draft_id, ticket_id, intent_id, mode, would_auto_send, failed_conditions, effective_stage)
         VALUES ($1, $2, $3, 'shadow', true, ARRAY['x'], 2)`,
        [f.draftId, f.ticketId, f.intent.id],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      app.query(`UPDATE ai_autosend_evaluation SET would_auto_send = true`),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });
});

describe('0096 goes down and up again', () => {
  let db: TestDatabase;
  let pool: Pool;

  // Each migration goes down in its own transaction, so a refusal by 0096 comes after the newer ones
  // were already reverted. Revert those first, expect 0096 alone to refuse, then bring them all back.
  async function expectDownRefused(later: string[], message: RegExp): Promise<void> {
    if (later.length > 0) await migrateDown(pool, { steps: later.length });
    await expect(migrateDown(pool, { steps: 1 })).rejects.toThrow(message);
    await migrateUp(pool);
  }

  beforeAll(async () => {
    db = await createTestDatabase(adminUrl);
    pool = db.owner.pool;
  });

  afterAll(async () => {
    await db.cleanup();
  });

  it('refuses to go down while an intent is at stage 3, and goes down and up when none is', async () => {
    const later = await migrationsAfter('0096_stage3_autosend');
    const steps = 1 + later.length;
    const appPool = new Pool({ connectionString: db.appUrl, max: 2 });
    try {
      const person = await scalar<string>(
        pool,
        `INSERT INTO users (email, name, role, permissions) VALUES ('o@example.com', 'O', 'head', ARRAY['ai.autonomy.owner_approve']) RETURNING id AS value`,
      );
      const intentId = await scalar<string>(
        appPool,
        `INSERT INTO intent (key, name) VALUES ('down_probe', 'P') RETURNING id AS value`,
      );
      const report = await scalar<string>(
        appPool,
        `INSERT INTO autonomy_gate_report (intent_id, status, trigger_kind, window_start, window_end)
         VALUES ($1, 'green', 'on_demand', now() - interval '30 days', now()) RETURNING id AS value`,
        [intentId],
      );
      const promotion = await scalar<string>(
        appPool,
        `SELECT request_stage_promotion($1::uuid, $2::uuid, $3::uuid, 'down test') AS value`,
        [intentId, report, person],
      );
      await appPool.query(
        `SELECT decide_stage_promotion($1::uuid, true, $2::uuid, 'ok, go', now(), 'down_probe')`,
        [promotion, person],
      );
      await appPool.query('SELECT apply_stage_promotion($1::uuid, $2::uuid)', [promotion, person]);

      await expectDownRefused(later, /stage 3/);
      // 0096 itself was not reverted: it ran in one transaction.
      expect(
        await scalar<string | null>(pool, `SELECT to_regclass('public.ai_grade')::text AS value`),
      ).toBe('ai_grade');

      await appPool.query(`SELECT rollback_intent_autonomy($1::uuid, 'back to two', NULL)`, [
        intentId,
      ]);
      const reverted = await migrateDown(pool, { steps });
      expect(reverted).toEqual([...later.toReversed(), '0096_stage3_autosend']);
      expect(
        await scalar<string | null>(pool, `SELECT to_regclass('public.ai_grade')::text AS value`),
      ).toBeNull();
      expect(
        await scalar<number>(
          pool,
          `SELECT count(*)::int AS value FROM permissions WHERE key LIKE 'ai.autonomy.%'`,
        ),
      ).toBe(2);
      // The old ceiling is back and so is the history without the new kinds.
      await expect(
        pool.query(`INSERT INTO intent (key, name, autonomy_stage) VALUES ('three_again', 'P', 3)`),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
      expect(
        await scalar<number>(
          pool,
          `SELECT count(*)::int AS value FROM intent_autonomy_history WHERE change NOT IN ('stage', 'pin', 'unpin')`,
        ),
      ).toBe(0);

      expect(await migrateUp(pool)).toEqual(['0096_stage3_autosend', ...later]);
      expect(
        await scalar<string | null>(pool, `SELECT to_regclass('public.ai_grade')::text AS value`),
      ).toBe('ai_grade');
    } finally {
      await appPool.end();
    }
  });

  it('refuses to go down while an ai_auto delivery is scheduled', async () => {
    const later = await migrationsAfter('0096_stage3_autosend');
    const appPool = new Pool({ connectionString: db.appUrl, max: 2 });
    try {
      const person = await scalar<string>(
        pool,
        `SELECT id AS value FROM users WHERE email = 'o@example.com'`,
      );
      const intentId = await scalar<string>(
        appPool,
        `INSERT INTO intent (key, name) VALUES ('down_auto', 'P') RETURNING id AS value`,
      );
      const report = await scalar<string>(
        appPool,
        `INSERT INTO autonomy_gate_report (intent_id, status, trigger_kind, window_start, window_end)
         VALUES ($1, 'green', 'on_demand', now() - interval '30 days', now()) RETURNING id AS value`,
        [intentId],
      );
      const promotion = await scalar<string>(
        appPool,
        `SELECT request_stage_promotion($1::uuid, $2::uuid, $3::uuid, 'down test') AS value`,
        [intentId, report, person],
      );
      await appPool.query(
        `SELECT decide_stage_promotion($1::uuid, true, $2::uuid, 'ok, go', now(), 'down_auto')`,
        [promotion, person],
      );
      await appPool.query('SELECT apply_stage_promotion($1::uuid, $2::uuid)', [promotion, person]);
      const org = await scalar<string>(
        pool,
        `INSERT INTO organization (name) VALUES ('Down Org') RETURNING id AS value`,
      );
      const account = await scalar<string>(
        pool,
        `INSERT INTO channel_account (type, name) VALUES ('gmail', 'down@example.com') RETURNING id AS value`,
      );
      const ticket = await scalar<string>(
        appPool,
        `INSERT INTO ticket (subject, org_id, intent_id, channel, channel_account_id) VALUES ('d', $1, $2, 'gmail', $3) RETURNING id AS value`,
        [org, intentId, account],
      );
      const text = 'Down test reply';
      const message = await scalar<string>(
        pool,
        `INSERT INTO message (ticket_id, channel_account_id, direction, body_text, visibility)
         VALUES ($1, $2, 'outbound', $3, 'public') RETURNING id AS value`,
        [ticket, account, text],
      );
      const draft = await scalar<string>(
        appPool,
        `INSERT INTO ai_draft (ticket_id, body_text) VALUES ($1, $2) RETURNING id AS value`,
        [ticket, text],
      );
      const grade = await scalar<string>(
        appPool,
        `INSERT INTO ai_grade (ai_draft_id, ticket_id, phase, graded_text, grader_provider, grader_model, drafter_provider,
                               drafter_model, score, passed, prompt_version)
         VALUES ($1, $2, 'pre_send', $3, 'p', 'opus', 'p', 'sonnet', 0.95, true, 1) RETURNING id AS value`,
        [draft, ticket, text],
      );
      await appPool.query(
        `UPDATE ai_draft SET status = 'auto_approved', auto_approved_at = now() WHERE id = $1`,
        [draft],
      );
      await appPool.query(
        `INSERT INTO outbound_delivery (ticket_id, message_id, channel_account_id, channel, origin, ai_draft_id, ai_grade_id,
                                        content_hash, hold_seconds, next_attempt_at)
         VALUES ($1, $2, $3, 'gmail', 'ai_auto', $4, $5, $6, 120, now() + interval '2 minutes')`,
        [ticket, message, account, draft, grade, sha256(text)],
      );
      // The intent goes back to stage 2: only the scheduled delivery is left in the way.
      await appPool.query(`SELECT rollback_intent_autonomy($1::uuid, 'back to two', NULL)`, [
        intentId,
      ]);
      await expectDownRefused(later, /ai_auto delivery is still scheduled/);
      await pool.query(
        `UPDATE outbound_delivery SET state = 'cancelled', cancelled_at = now() WHERE ai_grade_id = $1`,
        [grade],
      );
      // Even a cancelled one is a record that cannot be converted.
      await expectDownRefused(later, /ai_auto deliveries exist/);
    } finally {
      await appPool.end();
    }
  });
});
