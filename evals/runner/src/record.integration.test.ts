import { MockLlmProvider, type LlmProvider } from '@watchtower/ai';
import { createDatabase, type Database } from '@watchtower/db';
import { replayPassedForSet } from '@watchtower/domain';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { formatRecord, recordReplay, type RecordOptions } from './record.js';
import { redactionCorpusSchema } from './redaction-eval.js';
import { createRig, EvalSetupError } from './rig.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// T-306g: the recorder against Postgres (restricted application role, migration 0109). The "real" provider is a
// fake with a kind other than mock: no token, no socket.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

const corpus = redactionCorpusSchema.parse(
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../redaction/corpus.json', import.meta.url)), 'utf8'),
  ),
).cases;

const DRAFT = JSON.stringify({
  language: 'en',
  sentences: [
    { text: 'Thanks for writing to us.', kind: 'courtesy', evidenceIds: [], newParagraph: false },
  ],
});
const GRADE = JSON.stringify({
  resolutionClass: 'assumed',
  draftVerdict: 'no_draft',
  reasons: [{ text: 'No confirmation from the customer.', factIds: [] }],
});

function fakeProvider(draft: string = DRAFT): LlmProvider {
  const inner = new MockLlmProvider({
    rules: [
      { promptId: 'drafter', text: draft },
      { promptId: 'grader', text: GRADE },
    ],
  });
  return { kind: 'claude-cli', generate: (request) => inner.generate(request) };
}

const REAL_ENV = {
  AI_MODEL_DEEP: 'fake-deep',
  AI_MODEL_STANDARD: 'fake-standard',
  AI_MODEL_LIGHT: 'fake-light',
  AI_MODEL_PRICES: JSON.stringify({
    'fake-deep': { inputUsdPerMTok: 1, outputUsdPerMTok: 1 },
    'fake-standard': { inputUsdPerMTok: 1, outputUsdPerMTok: 1 },
    'fake-light': { inputUsdPerMTok: 1, outputUsdPerMTok: 1 },
  }),
};

let testDb: TestDatabase;
let app: Database;
const headEmail = 'head@example.test';
let realOrg = '';
const SECRET_TEXT = 'my-very-private-sentence-qzx';

const owner = () => testDb.owner.pool;
const q = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
  (await owner().query<T>(text, values)).rows;

async function ticketOf(intentId: string, over: { seed?: boolean; staff?: boolean } = {}) {
  let orgId = realOrg;
  let batchId: string | null = null;
  if (over.seed === true) {
    const [batch] = await q<{ id: string }>(
      `INSERT INTO seed_batch (kind, loaded_by) VALUES ('demo', 't306g') RETURNING id`,
    );
    batchId = batch?.id ?? null;
    const [org] = await q<{ id: string }>(
      `INSERT INTO organization (name, seed_batch_id) VALUES ('Seed Org', $1) RETURNING id`,
      [batchId],
    );
    orgId = org?.id ?? '';
  }
  const [row] = await q<{ id: string }>(
    `INSERT INTO ticket (subject, intent_id, status, channel, org_id, seed_batch_id) VALUES ('Cannot sign in', $1, 'resolved', 'portal', $2, $3) RETURNING id`,
    [intentId, orgId, batchId],
  );
  const id = row?.id ?? '';
  await owner().query(
    `INSERT INTO message (ticket_id, direction, visibility, body_text) VALUES ($1, 'inbound', 'public', $2)`,
    [id, `I cannot sign in. ${SECRET_TEXT}`],
  );
  if (over.staff !== false) {
    await owner().query(
      `INSERT INTO message (ticket_id, direction, visibility, body_text) VALUES ($1, 'outbound', 'public', 'Please reset it.')`,
      [id],
    );
  }
  return id;
}

async function intent(key: string) {
  const [row] = await q<{ id: string }>(
    `INSERT INTO intent (key, name) VALUES ($1, $1) RETURNING id`,
    [key],
  );
  return row?.id ?? '';
}

const options = (over: Partial<RecordOptions> & Pick<RecordOptions, 'rig' | 'intentKey'>) =>
  ({
    database: app,
    actorEmail: headEmail,
    days: 30,
    limit: 20,
    dryRun: false,
    redactionCorpus: corpus,
    ...over,
  }) satisfies RecordOptions;

const realRig = (draft?: string, maxCalls = 50) =>
  createRig({
    provider: 'claude-cli',
    maxCalls,
    env: REAL_ENV,
    providerImpl: fakeProvider(draft),
  });

const stored = (id: string) =>
  q<{ passed: boolean; mock: boolean; case_count: number; violations: number }>(
    `SELECT passed, mock, case_count, violations FROM ai_replay_result WHERE id = $1`,
    [id],
  );

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  app = createDatabase({ url: testDb.appUrl, max: 2, applicationName: 'wt-record-test' });
  realOrg =
    (await q<{ id: string }>(`INSERT INTO organization (name) VALUES ('Real Org') RETURNING id`))[0]
      ?.id ?? '';
  await owner().query(
    `INSERT INTO users (email, name, role) VALUES ('head@example.test', 'Head', 'head'), ('agent@example.test', 'Agent', 'agent')`,
  );
});
afterAll(async () => {
  await app.close();
  await testDb.cleanup();
});

describe('recordReplay', () => {
  it('stores a mock run but never as passed, and says so in numbers only', async () => {
    const key = 'sign_in_mock';
    const id = await intent(key);
    await ticketOf(id);
    const rig = createRig({ provider: 'mock', maxCalls: 50, env: {} });
    const outcome = await recordReplay(options({ rig, intentKey: key }));
    expect(outcome.mock).toBe(true);
    expect(outcome.wouldPass).toBe(false);
    expect(outcome.caseCount).toBe(2);
    const [row] = await stored(outcome.recordedId ?? '');
    expect(row).toMatchObject({ passed: false, mock: true, case_count: 2 });
    expect(outcome.set.drafterModel).toMatch(/^mock-/);
    expect(await replayPassedForSet(app.db, outcome.set)).toBe(false);
    const text = formatRecord(outcome);
    expect(text).not.toContain(SECRET_TEXT);
    expect(text).not.toContain('sign in');
  });

  it('passes on a non-mock provider with no violation, on the set the gate reads', async () => {
    const key = 'sign_in_real';
    const id = await intent(key);
    await ticketOf(id);
    await ticketOf(id, { seed: true });
    const outcome = await recordReplay(options({ rig: realRig(), intentKey: key }));
    expect(outcome.tickets).toBe(1); // the seeded ticket is not replayed
    expect(outcome).toMatchObject({ caseCount: 2, violations: 0, redactionPassed: true });
    expect(outcome.wouldPass).toBe(true);
    expect(outcome.set).toMatchObject({
      drafterModel: 'fake-deep',
      intentId: id,
      procedureVersionId: null,
    });
    const [row] = await stored(outcome.recordedId ?? '');
    expect(row).toMatchObject({ passed: true, mock: false, violations: 0 });
    // The gate reads the same set and finds the row (no procedure published for this intent).
    expect(await replayPassedForSet(app.db, outcome.set)).toBe(true);
  });

  it('records a violation when the draft breaks a check, and the database says not passed', async () => {
    const key = 'sign_in_bad';
    const id = await intent(key);
    await ticketOf(id);
    // The customer writes in English; a draft in Thai breaks the language check.
    const bad = JSON.stringify({
      language: 'th',
      sentences: [
        { text: 'ขอบคุณที่ติดต่อมา', kind: 'courtesy', evidenceIds: [], newParagraph: false },
      ],
    });
    const outcome = await recordReplay(options({ rig: realRig(bad), intentKey: key }));
    expect(outcome.violations).toBe(1);
    expect(outcome.wouldPass).toBe(false);
    expect((await stored(outcome.recordedId ?? ''))[0]?.passed).toBe(false);
  });

  it('records an empty run as not passed', async () => {
    const key = 'sign_in_empty';
    await intent(key);
    const outcome = await recordReplay(options({ rig: realRig(), intentKey: key }));
    expect(outcome.caseCount).toBe(0);
    expect((await stored(outcome.recordedId ?? ''))[0]?.passed).toBe(false);
  });

  it('--dry-run stores nothing', async () => {
    const key = 'sign_in_dry';
    const id = await intent(key);
    await ticketOf(id);
    const before = await q(`SELECT 1 FROM ai_replay_result WHERE intent_id = $1`, [id]);
    const outcome = await recordReplay(options({ rig: realRig(), intentKey: key, dryRun: true }));
    expect(outcome.recordedId).toBeNull();
    expect(outcome.wouldPass).toBe(true);
    expect(await q(`SELECT 1 FROM ai_replay_result WHERE intent_id = $1`, [id])).toEqual(before);
  });

  it('refuses a user without ai.autonomy.promote (the database checks)', async () => {
    const key = 'sign_in_agent';
    const id = await intent(key);
    await ticketOf(id);
    await expect(
      recordReplay(options({ rig: realRig(), intentKey: key, actorEmail: 'agent@example.test' })),
    ).rejects.toThrow();
    expect(await q(`SELECT 1 FROM ai_replay_result WHERE intent_id = $1`, [id])).toHaveLength(0);
  });

  it('stops on the call budget instead of recording a skipped call as a violation', async () => {
    const key = 'sign_in_budget';
    const id = await intent(key);
    await ticketOf(id);
    await expect(
      recordReplay(options({ rig: realRig(undefined, 1), intentKey: key })),
    ).rejects.toBeInstanceOf(EvalSetupError);
    expect(await q(`SELECT 1 FROM ai_replay_result WHERE intent_id = $1`, [id])).toHaveLength(0);
  });

  it('refuses an unknown intent and an unknown user', async () => {
    await expect(
      recordReplay(options({ rig: realRig(), intentKey: 'no_such_intent' })),
    ).rejects.toBeInstanceOf(EvalSetupError);
    await intent('sign_in_who');
    await expect(
      recordReplay(
        options({ rig: realRig(), intentKey: 'sign_in_who', actorEmail: 'nobody@example.test' }),
      ),
    ).rejects.toBeInstanceOf(EvalSetupError);
  });
});
