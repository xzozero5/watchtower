import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from './migrator.js';
import { createTestDatabase, type TestDatabase } from './testing.js';

// Migration 0108 (T-306f, review T-306a C-5 .. C-9): what the application role can no longer write by itself
// (gate report, ai_grade, procedure_simulation), and the doors that replace the INSERT. Every attack is made
// with the restricted login role of the api and the worker (`app`).
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';
const INTEGRITY = '23000';

let testDb: TestDatabase;
let app: Pool;
const owner = (): Pool => testDb.owner.pool;

async function scalar<T>(pool: Pool, text: string, values: unknown[] = []): Promise<T> {
  const result = await pool.query<{ value: T }>(text, values);
  const row = result.rows[0];
  if (row === undefined) throw new Error('query returned no row');
  return row.value;
}

let counter = 0;
const unique = (prefix: string): string => `${prefix}_${String((counter += 1))}`;

let head: string;
let agent: string;
let ownerPerson: string;
let orgId: string;
let accountId: string;

async function newIntent(daysOld = 90): Promise<{ id: string; key: string }> {
  const key = unique('hard');
  const id = await scalar<string>(
    owner(),
    `INSERT INTO intent (key, name, created_at) VALUES ($1, 'Probe', now() - make_interval(days => $2))
     RETURNING id AS value`,
    [key, daysOld],
  );
  return { id, key };
}

const metrics = JSON.stringify({ resolved: 40, aiShare: 0.5 });
const passing = JSON.stringify([{ key: 'precision', pass: true, value: 0.99, threshold: 0.95 }]);
const failing = JSON.stringify([{ key: 'precision', pass: false, value: 0.5, threshold: 0.95 }]);

const recordReport = (
  intentId: string,
  overrides: {
    status?: string;
    metrics?: string;
    criteria?: string;
    windowDays?: number;
    pool?: Pool;
  } = {},
) =>
  (overrides.pool ?? app).query<{ value: string }>(
    `SELECT public.record_autonomy_gate_report($1::uuid, $2, 'on_demand', now() - make_interval(days => $3), now(),
                                               $4::jsonb, $5::jsonb, true, NULL) AS value`,
    [
      intentId,
      overrides.status ?? 'green',
      overrides.windowDays ?? 30,
      overrides.metrics ?? metrics,
      overrides.criteria ?? passing,
    ],
  );

async function aiRun(
  ticketId: string,
  agentName: string,
  model: string,
  provider = 'anthropic',
  procedureVersionId: string | null = null,
): Promise<string> {
  return scalar<string>(
    owner(),
    `INSERT INTO ai_run (started_at, agent, ticket_id, provider, model, tier, prompt_id, prompt_version, prompt_hash,
                         input_hmac, redaction, status, procedure_version_id)
     VALUES (now(), $2, $1, $3, $4, 'standard', 'p', 1, repeat('a', 64), repeat('a', 64), '{"total":0,"byKind":{}}'::jsonb, 'ok', $5)
     RETURNING id AS value`,
    [ticketId, agentName, provider, model, procedureVersionId],
  );
}

async function newTicket(intentId: string | null): Promise<string> {
  return scalar<string>(
    owner(),
    `INSERT INTO ticket (subject, org_id, intent_id, channel, channel_account_id, priority)
     VALUES ('hard', $1, $2, 'gmail', $3, 'P3') RETURNING id AS value`,
    [orgId, intentId, accountId],
  );
}

async function newDraft(
  ticketId: string,
  runId: string | null,
  body = 'We reset it.',
): Promise<string> {
  return scalar<string>(
    owner(),
    `INSERT INTO ai_draft (ticket_id, body_text, ai_run_id) VALUES ($1, $2, $3) RETURNING id AS value`,
    [ticketId, body, runId],
  );
}

const recordGrade = (
  draftId: string,
  ticketId: string,
  runId: string | null,
  text = 'We reset it.\n\nnotice',
  pool: Pool = app,
) =>
  pool.query<{ value: string }>(
    `SELECT public.record_ai_grade($1::uuid, $2::uuid, 'pre_send', $3, $4::uuid, 0.95, true, '[]'::jsonb, 1) AS value`,
    [draftId, ticketId, text, runId],
  );

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
  ownerPerson = await scalar<string>(
    owner(),
    `INSERT INTO users (email, name, role, permissions)
     VALUES ('owner@example.com', 'O', 'head', ARRAY['ai.autonomy.owner_approve']) RETURNING id AS value`,
  );
  orgId = await scalar<string>(
    owner(),
    `INSERT INTO organization (name) VALUES ('Hard Org') RETURNING id AS value`,
  );
  accountId = await scalar<string>(
    owner(),
    `INSERT INTO channel_account (type, name) VALUES ('gmail', 'hard@example.com') RETURNING id AS value`,
  );
  await owner().query(`UPDATE ai_switch SET is_on = false`);
});

afterAll(async () => {
  await app.end();
  await testDb.cleanup();
});

describe('the application role no longer inserts evidence by itself (C-6, C-9)', () => {
  it('is refused a direct INSERT of a gate report, a grade and a simulation result', async () => {
    const intent = await newIntent();
    await expect(
      app.query(
        `INSERT INTO autonomy_gate_report (intent_id, status, trigger_kind, window_start, window_end)
         VALUES ($1, 'green', 'on_demand', now() - interval '30 days', now())`,
        [intent.id],
      ),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    const ticket = await newTicket(intent.id);
    const draft = await newDraft(ticket, null);
    await expect(
      app.query(
        `INSERT INTO ai_grade (ai_draft_id, ticket_id, phase, graded_text, grader_provider, grader_model,
                               drafter_provider, drafter_model, score, passed, prompt_version)
         VALUES ($1, $2, 'pre_send', 'x', 'p', 'opus', 'p', 'sonnet', 0.95, true, 1)`,
        [draft, ticket],
      ),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      app.query(
        `INSERT INTO procedure_simulation (procedure_version_id, passed, case_count) VALUES (gen_random_uuid(), true, 3)`,
      ),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });
});

describe('record_autonomy_gate_report (C-6)', () => {
  it('writes a report with numbers and refuses empty metrics, a made-up window and a green that does not pass', async () => {
    const intent = await newIntent();
    const written = await recordReport(intent.id);
    expect(written.rows[0]?.value).toMatch(/^[0-9a-f-]{36}$/);

    await expect(recordReport(intent.id, { metrics: '{}' })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    // The intent is 90 days old; a window of 120 days reaches back before it existed.
    await expect(recordReport(intent.id, { windowDays: 120 })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    await expect(recordReport(intent.id, { criteria: failing })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    await expect(recordReport(intent.id, { criteria: '[]' })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    // A red report with the same failing criteria is a report like any other.
    await expect(
      recordReport(intent.id, { status: 'red', criteria: failing }),
    ).resolves.toBeDefined();
  });

  it('promotion_blocker also refuses a report whose window starts before the intent existed', async () => {
    const intent = await newIntent(10);
    // Written by the schema owner (the only way left to make such a row), to prove the second wall.
    const report = await scalar<string>(
      owner(),
      `INSERT INTO autonomy_gate_report (intent_id, status, trigger_kind, window_start, window_end, metrics, criteria)
       VALUES ($1, 'green', 'on_demand', now() - interval '30 days', now(), $2::jsonb, $3::jsonb) RETURNING id AS value`,
      [intent.id, metrics, passing],
    );
    await expect(
      app.query(`SELECT request_stage_promotion($1::uuid, $2::uuid, $3::uuid, 'ask')`, [
        intent.id,
        report,
        head,
      ]),
    ).rejects.toThrow(/window_before_intent/);
  });
});

describe('record_ai_grade (C-9)', () => {
  it('takes the models from the ai_run rows: the caller cannot name them, and an unrelated run is refused', async () => {
    const intent = await newIntent();
    const ticket = await newTicket(intent.id);
    const drafterRun = await aiRun(ticket, 'drafter', 'sonnet');
    const draft = await newDraft(ticket, drafterRun);
    const graderRun = await aiRun(ticket, 'grader', 'opus');

    const id = (await recordGrade(draft, ticket, graderRun)).rows[0]?.value ?? '';
    const row = await owner().query<{
      grader_model: string;
      drafter_model: string;
      independent: boolean;
      mock: boolean;
    }>(`SELECT grader_model, drafter_model, independent, mock FROM ai_grade WHERE id = $1`, [id]);
    expect(row.rows[0]).toMatchObject({
      grader_model: 'opus',
      drafter_model: 'sonnet',
      independent: true,
      mock: false,
    });

    // The same model on both sides is stored as it is: not independent, which no send can use.
    const sameRun = await aiRun(ticket, 'grader', 'sonnet');
    const sameId = (await recordGrade(draft, ticket, sameRun)).rows[0]?.value ?? '';
    expect(
      await scalar<boolean>(owner(), `SELECT independent AS value FROM ai_grade WHERE id = $1`, [
        sameId,
      ]),
    ).toBe(false);
    // A mock provider is a mock grade, whatever the caller says.
    const mockRun = await aiRun(ticket, 'grader', 'opus', 'mock');
    const mockId = (await recordGrade(draft, ticket, mockRun)).rows[0]?.value ?? '';
    expect(
      await scalar<boolean>(owner(), `SELECT mock AS value FROM ai_grade WHERE id = $1`, [mockId]),
    ).toBe(true);

    // No run, a run that is not a grader run, a run of another ticket: nothing is written.
    await expect(recordGrade(draft, ticket, null)).rejects.toMatchObject({ code: INTEGRITY });
    await expect(recordGrade(draft, ticket, drafterRun)).rejects.toMatchObject({ code: INTEGRITY });
    const otherTicket = await newTicket(intent.id);
    const foreign = await aiRun(otherTicket, 'grader', 'opus');
    await expect(recordGrade(draft, ticket, foreign)).rejects.toMatchObject({ code: INTEGRITY });
    // A draft without a drafter run has no model to compare against.
    const orphan = await newDraft(ticket, null);
    await expect(recordGrade(orphan, ticket, graderRun)).rejects.toMatchObject({ code: INTEGRITY });
    // A draft of another ticket.
    await expect(recordGrade(draft, otherTicket, graderRun)).rejects.toMatchObject({
      code: INTEGRITY,
    });
  });
});

describe('the ai_auto delivery holds the message against the draft (C-9)', () => {
  it('refuses a message that is not the draft plus the notice of the instance', async () => {
    const intent = await newIntent();
    const ticket = await newTicket(intent.id);
    const drafterRun = await aiRun(ticket, 'drafter', 'sonnet');
    const draft = await newDraft(ticket, drafterRun, 'We reset it.');
    const graderRun = await aiRun(ticket, 'grader', 'opus');
    const notice = await scalar<string>(
      owner(),
      `SELECT value #>> '{text,en}' AS value FROM instance_setting WHERE key = 'autosend.disclosure'`,
    );

    // Put the intent at stage 3 the way the schema owner may (the promotion door is covered elsewhere).
    await owner().query(`ALTER TABLE intent DISABLE TRIGGER intent_require_promotion`);
    await owner().query(`UPDATE intent SET autonomy_stage = 3 WHERE id = $1`, [intent.id]);
    await owner().query(`ALTER TABLE intent ENABLE TRIGGER intent_require_promotion`);

    const schedule = async (text: string) => {
      const message = await scalar<string>(
        owner(),
        `INSERT INTO message (ticket_id, channel_account_id, direction, body_text, visibility)
         VALUES ($1, $2, 'outbound', $3, 'public') RETURNING id AS value`,
        [ticket, accountId, text],
      );
      const grade = (await recordGrade(draft, ticket, graderRun, text)).rows[0]?.value ?? '';
      await owner().query(
        `UPDATE ai_draft SET status = 'auto_approved', auto_approved_at = now() WHERE id = $1 AND status = 'draft'`,
        [draft],
      );
      return app.query(
        `INSERT INTO outbound_delivery (ticket_id, message_id, channel_account_id, channel, origin, ai_draft_id, ai_grade_id,
                                        content_hash, hold_seconds, next_attempt_at)
         VALUES ($1, $2, $3, 'gmail', 'ai_auto', $4, $5, encode(sha256(convert_to($6, 'UTF8')), 'hex'), 120,
                 now() + interval '2 minutes')`,
        [ticket, message, accountId, draft, grade, text],
      );
    };

    // The grade covers exactly the text, and the text is still not the draft: a sentence was added.
    await expect(
      schedule(`We reset it. Also a refund of 500 baht.\n\n${notice}`),
    ).rejects.toMatchObject({
      code: INTEGRITY,
    });
    await expect(schedule('Something else entirely.')).rejects.toMatchObject({ code: INTEGRITY });
    // The draft and the notice: through.
    await expect(schedule(`We reset it.\n\n${notice}`)).resolves.toBeDefined();
  });
});

describe('apply and publish check who is asking (C-9)', () => {
  it('refuses an actor that is not a real holder of the permission', async () => {
    const intent = await newIntent();
    const report = (await recordReport(intent.id)).rows[0]?.value ?? '';
    const asked = await scalar<string>(
      app,
      `SELECT request_stage_promotion($1::uuid, $2::uuid, $3::uuid, 'ask') AS value`,
      [intent.id, report, head],
    );
    await app.query(
      `SELECT decide_stage_promotion($1::uuid, true, $2::uuid, 'ok, go', now(), $3)`,
      [asked, ownerPerson, intent.key],
    );
    for (const actor of ['6f3b1c1e-5a7a-4a0e-9c3b-0a1b2c3d4e5f', agent, head]) {
      await expect(
        app.query('SELECT apply_stage_promotion($1::uuid, $2::uuid)', [asked, actor]),
      ).rejects.toMatchObject({ code: 'WT004' });
    }
    expect(
      (
        await app.query<{ value: string }>(
          'SELECT apply_stage_promotion($1::uuid, $2::uuid) AS value',
          [asked, ownerPerson],
        )
      ).rows[0]?.value,
    ).toBe('applied');
  });

  it('publish_procedure_version needs a real, active user with procedure.publish', async () => {
    const intent = await newIntent();
    const procedure = await scalar<string>(
      owner(),
      `INSERT INTO procedure (intent_id, created_by) VALUES ($1, $2) RETURNING id AS value`,
      [intent.id, head],
    );
    const version = await scalar<string>(
      owner(),
      `INSERT INTO procedure_version (procedure_id, source_md, steps, authored_by)
       VALUES ($1, 'x', '{"schemaVersion":1,"steps":[]}'::jsonb, $2) RETURNING id AS value`,
      [procedure, head],
    );
    await owner().query(
      `UPDATE procedure_version SET status = 'confirmed', confirmed_by = $2, confirmed_at = now() WHERE id = $1`,
      [version, head],
    );
    await owner().query(
      `INSERT INTO procedure_simulation (procedure_version_id, passed, case_count, metrics)
       VALUES ($1, true, 5, '{"mode":"instance"}'::jsonb)`,
      [version],
    );
    for (const actor of ['6f3b1c1e-5a7a-4a0e-9c3b-0a1b2c3d4e5f', agent]) {
      await expect(
        app.query('SELECT public.publish_procedure_version($1::uuid, $2::uuid)', [version, actor]),
      ).rejects.toMatchObject({ code: 'WT004' });
    }
    await owner().query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [agent]);
    await owner().query(`UPDATE users SET status = 'active' WHERE id = $1`, [agent]);
    await expect(
      app.query('SELECT public.publish_procedure_version($1::uuid, $2::uuid)', [version, head]),
    ).resolves.toBeDefined();
  });
});

describe('record_procedure_simulation (C-9)', () => {
  async function confirmedVersion(): Promise<{
    intent: { id: string };
    ticket: string;
    version: string;
  }> {
    const intent = await newIntent();
    const procedure = await scalar<string>(
      owner(),
      `INSERT INTO procedure (intent_id, created_by) VALUES ($1, $2) RETURNING id AS value`,
      [intent.id, head],
    );
    const version = await scalar<string>(
      owner(),
      `INSERT INTO procedure_version (procedure_id, source_md, steps, authored_by)
       VALUES ($1, 'x', '{"schemaVersion":1,"steps":[]}'::jsonb, $2) RETURNING id AS value`,
      [procedure, head],
    );
    await owner().query(
      `UPDATE procedure_version SET status = 'confirmed', confirmed_by = $2, confirmed_at = now() WHERE id = $1`,
      [version, head],
    );
    return { intent, ticket: await newTicket(intent.id), version };
  }

  const result = (
    mode: 'instance' | 'fixture',
    failReasons: string[],
    extra: { seeded?: number; drafted?: number; caseCount?: number } = {},
  ) =>
    JSON.stringify({
      mode,
      caseCount: extra.caseCount ?? 5,
      failedCases: 0,
      seededCases: extra.seeded ?? 0,
      candidate: {
        editDistance: 10,
        uncitedClaims: 0,
        drafted: extra.drafted ?? 5,
        violations: 0,
        disclosureLeaks: 0,
      },
      failReasons,
    });

  const record = (
    version: string,
    passed: boolean,
    seedOnly: boolean,
    caseCount: number,
    json: string,
  ) =>
    app.query<{ value: string }>(
      `SELECT public.record_procedure_simulation($1::uuid, $2, $3, $4, $5::jsonb, NULL) AS value`,
      [version, passed, seedOnly, caseCount, json],
    );

  it('does not let the caller say passed: it must follow from the metrics, the seed flag and the drafter runs', async () => {
    const { ticket, version } = await confirmedVersion();
    // passed = true with a fail reason, with no cases, on a fixture, with a lying seed flag, with no runs: all refused.
    await expect(
      record(version, true, false, 5, result('instance', ['policy_violation'])),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    await expect(
      record(version, true, false, 0, result('instance', [], { caseCount: 0 })),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    await expect(record(version, true, false, 5, result('fixture', []))).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    await expect(
      record(version, true, false, 5, result('instance', [], { seeded: 2 })),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    await expect(record(version, true, false, 5, result('instance', []))).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    // The honest ones: a failed run needs no runs; a passed run needs the drafter runs of this very version.
    await expect(
      record(version, false, false, 5, result('instance', ['policy_violation'])),
    ).resolves.toBeDefined();
    for (let index = 0; index < 5; index += 1)
      await aiRun(ticket, 'drafter', 'sonnet', 'anthropic', version);
    await expect(record(version, true, false, 5, result('instance', []))).resolves.toBeDefined();
    expect(
      await scalar<string>(owner(), `SELECT status AS value FROM procedure_version WHERE id = $1`, [
        version,
      ]),
    ).toBe('simulated');
    // A seed flag that matches the metrics is stored as it is.
    await expect(
      record(version, true, true, 5, result('instance', [], { seeded: 2 })),
    ).resolves.toBeDefined();
  });
});

describe('0108 goes down and up again', () => {
  it('gives the application role its INSERT back on the way down and takes it away again', async () => {
    const db = await createTestDatabase(adminUrl);
    try {
      const pool = db.owner.pool;
      const login = new Pool({ connectionString: db.appUrl, max: 2 });
      try {
        const canInsert = (): Promise<boolean> =>
          scalar<boolean>(
            login,
            `SELECT has_table_privilege(current_user, 'autonomy_gate_report', 'INSERT') AS value`,
          );
        expect(await canInsert()).toBe(false);
        expect(await migrateDown(pool, { steps: 1 })).toEqual(['0108_review_hardening']);
        expect(await canInsert()).toBe(true);
        expect(
          await scalar<string | null>(
            pool,
            `SELECT to_regprocedure('public.record_ai_grade(uuid,uuid,text,text,uuid,numeric,boolean,jsonb,integer)')::text AS value`,
          ),
        ).toBeNull();
        expect(await migrateUp(pool)).toEqual(['0108_review_hardening']);
        expect(await canInsert()).toBe(false);
      } finally {
        await login.end();
      }
    } finally {
      await db.cleanup();
    }
  });
});
