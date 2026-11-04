import type { Browser, BrowserContext, Page } from '@playwright/test';

import {
  Api,
  expect,
  findOrgId,
  gmailSends,
  newActor,
  signInDev,
  signInStaff,
  test,
  unique,
} from './support';
import { aiKnobs, fakeGmailAuthenticated, flagOn, setAiKnobs, sql, until } from './stage3-support';

/**
 * Stage 3 auto-send, end to end (T-306b, ADR-025): the real api, worker and web, Postgres, Redis and the
 * stack's in-memory Gmail, in a throwaway stack. Run it three ways (see README, "Stage 3"):
 *
 *   flag OFF  + fake-live provider   -> `describe('flag OFF')`   shadow mode, nothing is ever sent
 *   flag ON   + fake-live provider   -> `describe('flag ON')`    gate, send, hold, rollback, promotion
 *   flag ON   + the plain mock       -> `describe("mock")`       a mock grade can never clear a send
 *
 * "fake-live provider" = `E2E_AI_FAKE_LIVE_FILE` (tools/e2e-stack/worker-runner.mjs): the dev mock answers every prompt
 * but is wrapped as a provider that is not of kind `mock`, because a grade made by kind `mock` can never clear an
 * automatic send (decide.ts `grade_mock`, by design), and the grader's model and answer come from a JSON file.
 * `AI_AUTOSEND_ENABLED=true` exists only inside the stack the flag-ON runs start (`E2E_AUTOSEND_FLAG=on`).
 *
 * Existing in-process tests of the same rules (cited, not repeated): apps/worker/src/ai/autosend.integration.test.ts
 * (the gate, shadow, the hold, claim-time checks), apps/worker/src/autonomy/autonomy-watch.integration.test.ts
 * (rollback rules, gate report, replay), apps/api/src/autonomy/promotion.integration.test.ts and step-up.integration.test.ts
 * (the promotion door). What those cannot show is the real processes: the flag read at boot by two processes, the
 * queue and outbox between them, the dispatcher, the notification, the browser.
 */

const fakeLive = Boolean(process.env.E2E_AI_FAKE_LIVE_FILE);
const ON = flagOn();

interface Actor {
  context: BrowserContext;
  page: Page;
  api: Api;
}

interface Shared {
  head: Actor;
  agentApi: Api;
  leadApi: Api;
  headId: string;
  orgId: string;
  /** Prompt versions the first ai_run rows carry; a replay must name them (ADR-025 C-4). */
  drafterPromptVersion: number;
  graderPromptVersion: number;
}

const S = {} as Shared;

async function actor(
  browser: Browser,
  role: 'head' | 'lead' | 'agent',
  name: string,
): Promise<Actor> {
  const made = await newActor(browser);
  await signInDev(made.page, role, name);
  return { ...made, api: new Api(made.context.request) };
}

async function setup(browser: Browser): Promise<void> {
  if (fakeLive) setAiKnobs();
  const head = await newActor(browser);
  await signInStaff(head.page);
  const api = new Api(head.context.request);
  S.head = { ...head, api };
  S.headId = (await api.get<{ user: { id: string } }>('/v1/auth/session')).json.user.id;
  S.orgId = await findOrgId(api, 'Acme Logistics');
  // The fake channel files mail under the Gmail account of this name; a reply needs that account to have a mailbox address
  // (the same registration ac1-gmail makes), or the dispatcher answers `channel_not_connected`.
  const mailbox = await api.post('/v1/admin/channel-accounts', {
    type: 'gmail',
    name: 'Fake Gmail mailbox (test)',
    emailAddress: `support-${unique('s3')}@mail.example.test`,
  });
  expect(mailbox.status).toBe(201);
  S.agentApi = (await actor(browser, 'agent', unique('agent'))).api;
  S.leadApi = (await actor(browser, 'lead', unique('lead'))).api;
}

// ---------------------------------------------------------------- builders

interface IntentSetup {
  id: string;
  key: string;
  word: string;
}

/** A customer-facing KB article that mentions `word`, written by an agent, published by a lead, indexed. */
async function publishArticle(word: string): Promise<void> {
  const created = await S.agentApi.post<{ id: string; version: number }>('/v1/kb/articles', {
    slug: `reset-${word}`,
    // Worded like the customer's mail (subject and question), so the search puts it first whatever the mock vectors say.
    title: `Cannot sign in ${word}: reset a password`,
    lang: 'en',
    visibility: 'customer',
    intentTags: [],
    bodyMd: `# Cannot sign in ${word}: reset a password\n\nHow do I reset my password ${word}? I cannot sign in ${word}. You can reset your password ${word} with the Forgot password link on the sign in page.\n`,
  });
  expect(created.status).toBe(201);
  const id = created.json.id;
  await S.agentApi.post(`/v1/kb/articles/${id}/transition`, { to: 'in_review' });
  const published = await S.leadApi.post(`/v1/kb/articles/${id}/publish`, {
    version: created.json.version,
    visibility: 'customer',
    orgIds: [],
  });
  expect(published.status).toBe(200);
  // Indexing is the worker's job after the publish.
  await until('the article in the search index', async () => {
    const found = await S.agentApi.get<{ hits: { articleId: string }[] }>(
      `/v1/kb/search?q=${encodeURIComponent(word)}`,
    );
    return found.json.hits.some((hit) => hit.articleId === id) ? true : undefined;
  });
  // The dev mock ranks with made-up vectors, so with the other articles of the demo data (and of earlier scenarios) in the
  // index this one lands in the top 3 only by chance. Only this scenario's article stays published: the search, the cards
  // and the drafter then do the same thing every run. (Throwaway database; nothing is deleted, the others are marked deprecated.)
  sql(
    'admin',
    `UPDATE kb_article SET status = 'deprecated', published_version_id = NULL WHERE id <> $1 AND status = 'published'`,
    [id],
  );
}

type ProcedureKind = 'allowed' | 'never' | 'require_human' | 'none';

/** An intent (stage 2, backdated so a 28 day report window fits) with its allow-list and, optionally, a published procedure. */
function createIntent(
  word: string,
  options: { shadow?: boolean; procedure?: ProcedureKind } = {},
): IntentSetup {
  const key = `reset_${word}`;
  const [intent] = sql<{ id: string }>(
    'admin',
    `INSERT INTO intent (key, name, created_at, autonomy_stage, autosend_shadow)
     VALUES ($1, $2, now() - interval '60 days', 2, $3) RETURNING id`,
    [key, `Reset a password ${word}`, options.shadow ?? false],
  );
  const id = intent?.id ?? '';
  sql('admin', `UPDATE intent SET autosend_policy = $2::jsonb WHERE id = $1`, [
    id,
    JSON.stringify({ channels: ['gmail', 'portal'] }),
  ]);
  const kind = options.procedure ?? 'allowed';
  if (kind !== 'none') {
    const steps =
      kind === 'require_human'
        ? [
            {
              kind: 'require_human',
              id: 'always_a_person',
              when: { all: [{ field: 'ticket.priority', op: 'eq', value: 'P3' }] },
              reason: 'A person reads every reply of this intent.',
            },
          ]
        : [];
    const procedure = sql<{ id: string }>(
      'admin',
      `INSERT INTO procedure (intent_id, created_by) VALUES ($1, $2) RETURNING id`,
      [id, S.headId],
    );
    const version = sql<{ id: string }>(
      'admin',
      `INSERT INTO procedure_version (procedure_id, source_md, steps, authored_by)
       VALUES ($1, 'Answer from the knowledge base.', $2::jsonb, $3) RETURNING id`,
      [
        procedure[0]?.id,
        JSON.stringify({
          schemaVersion: 1,
          autosend: kind === 'never' ? 'never' : 'allowed',
          steps,
        }),
        S.headId,
      ],
    );
    const versionId = version[0]?.id;
    sql(
      'admin',
      `UPDATE procedure_version SET status = 'confirmed', confirmed_by = $2, confirmed_at = now() WHERE id = $1`,
      [versionId, S.headId],
    );
    sql(
      'admin',
      `INSERT INTO procedure_simulation (procedure_version_id, passed, seed_only, case_count, metrics)
       VALUES ($1, true, false, 5, '{"violations":0}'::jsonb)`,
      [versionId],
    );
    sql('admin', `SELECT public.publish_procedure_version($1::uuid, $2::uuid)`, [
      versionId,
      S.headId,
    ]);
  }
  return { id, key, word };
}

function publishedProcedureId(intentId: string): string | null {
  const rows = sql<{ id: string }>(
    'admin',
    `SELECT pv.id FROM procedure p JOIN procedure_version pv ON pv.procedure_id = p.id AND pv.status = 'published'
      WHERE p.intent_id = $1`,
    [intentId],
  );
  return rows[0]?.id ?? null;
}

/** A passing replay of the combination in force, written through `record_replay_result()` as the head (the app role). */
function recordReplay(
  intentId: string,
  over: { violations?: number; mock?: boolean; graderModel?: string } = {},
): string {
  const knobs = aiKnobs();
  const rows = sql<{ id: string }>(
    'app',
    `SELECT public.record_replay_result($1::uuid, $2::uuid, 'eval', $3, $4, $5::int, $6::int, $7::uuid, 12::int, $8::int, true, $9::boolean) AS id`,
    [
      S.headId,
      intentId,
      knobs.drafterModel,
      over.graderModel ?? knobs.graderModel,
      S.drafterPromptVersion,
      S.graderPromptVersion,
      publishedProcedureId(intentId),
      over.violations ?? 0,
      over.mock ?? false,
    ],
  );
  return rows[0]?.id ?? '';
}

interface TicketRow {
  id: string;
  key: string;
}

/**
 * A verified customer writes in; resolves with the ticket once the worker has evaluated the draft (the
 * `ai_autosend_evaluation` row), or - when `evaluated` is false - once the draft exists.
 */
async function customerWrites(
  intent: IntentSetup,
  options: {
    body?: string;
    verified?: boolean;
    auth?: 'pass' | 'none';
    evaluated?: boolean;
    draftWaitMs?: number;
  } = {},
): Promise<TicketRow> {
  const tag = unique('c').replace(/-/g, '');
  const customer = `ada-${tag}@acme-logistics.example.com`;
  sql(
    'admin',
    `INSERT INTO contact (org_id, name, emails, verified_at)
     VALUES ($1, 'Ada', ARRAY[$2], CASE WHEN $3::boolean THEN now() ELSE NULL END)`,
    [S.orgId, customer, options.verified ?? true],
  );
  const subject = `Cannot sign in ${intent.word} ${tag}`;
  fakeGmailAuthenticated({
    from: customer,
    subject,
    body: options.body ?? `Hello, how do I reset my password ${intent.word}? I cannot sign in.`,
    threadId: `thr-${tag}`,
    messageId: `m1-${tag}@mail.example.test`,
    auth: options.auth ?? 'pass',
  });
  const ticket = await until(
    'the ticket',
    () =>
      sql<TicketRow>('admin', `SELECT id, 'OPS-' || number AS key FROM ticket WHERE subject = $1`, [
        subject,
      ])[0],
  );
  if (options.evaluated === false) {
    // With `draftWaitMs` a ticket that gets no draft in time is returned as it is (the caller looks at `drafts()`).
    await until(
      'the draft',
      () => (drafts(ticket.id).length > 0 ? true : undefined),
      options.draftWaitMs ?? 60_000,
    ).catch((error: unknown) => {
      if (options.draftWaitMs === undefined) throw error;
    });
  } else {
    try {
      await until(
        'the evaluation',
        () => (evaluations(ticket.id).length > 0 ? true : undefined),
        60_000,
      );
    } catch (error) {
      throw new Error(`${String(error)}; state: ${diagnose(ticket.id)}`, { cause: error });
    }
  }
  return ticket;
}

// ---------------------------------------------------------------- reads

/** What the worker did with a ticket, for the message of a timeout. */
function diagnose(ticketId: string): string {
  const insight = sql(
    'admin',
    `SELECT state, reason_code, intent_key, stage FROM ai_ticket_insight WHERE ticket_id = $1`,
    [ticketId],
  );
  const ticket = sql('admin', `SELECT intent_id, priority FROM ticket WHERE id = $1`, [ticketId]);
  const evidence = sql(
    'admin',
    `SELECT e->>'id' AS id, e->>'kind' AS kind, e->>'title' AS title, e->>'customerSafe' AS safe
       FROM ai_ticket_insight i, jsonb_array_elements(i.evidence) e WHERE i.ticket_id = $1`,
    [ticketId],
  );
  const citations = sql('admin', `SELECT citations FROM ai_draft WHERE ticket_id = $1`, [ticketId]);
  const delivery = sql(
    'admin',
    `SELECT origin, state, attempts, error_code, channel, route, hold_seconds, next_attempt_at, now() AS db_now
       FROM outbound_delivery WHERE ticket_id = $1`,
    [ticketId],
  );
  return JSON.stringify({
    insight,
    ticket,
    drafts: drafts(ticketId).length,
    evidence,
    citations,
    delivery,
  });
}

interface Evaluation {
  mode: string;
  would_auto_send: boolean;
  failed_conditions: string[];
  effective_stage: number;
}
const evaluations = (ticketId: string) =>
  sql<Evaluation>(
    'admin',
    `SELECT mode, would_auto_send, failed_conditions, effective_stage FROM ai_autosend_evaluation
      WHERE ticket_id = $1 ORDER BY evaluated_at`,
    [ticketId],
  );
const drafts = (ticketId: string) =>
  sql<{ id: string; status: string; body_text: string }>(
    'admin',
    `SELECT id, status, body_text FROM ai_draft WHERE ticket_id = $1 ORDER BY created_at`,
    [ticketId],
  );
const deliveries = (ticketId: string) =>
  sql<{ id: string; origin: string; state: string; hold_seconds: number; sent_at: string | null }>(
    'admin',
    `SELECT id, origin, state, hold_seconds, sent_at FROM outbound_delivery WHERE ticket_id = $1 ORDER BY created_at`,
    [ticketId],
  );
const outboundMessages = (ticketId: string) =>
  sql<{ body_text: string; sender_user_id: string | null }>(
    'admin',
    `SELECT body_text, sender_user_id FROM message WHERE ticket_id = $1 AND direction = 'outbound' AND visibility <> 'internal'`,
    [ticketId],
  );
const heldNotes = (ticketId: string) =>
  sql<{ payload: { reason?: string; failed?: string[] } }>(
    'admin',
    `SELECT payload FROM ticket_event WHERE ticket_id = $1 AND type = 'autonomy.autosend_held' ORDER BY created_at`,
    [ticketId],
  );
const stageOf = (intentId: string) =>
  Number(
    sql<{ s: number }>('admin', `SELECT autonomy_stage AS s FROM intent WHERE id = $1`, [
      intentId,
    ])[0]?.s,
  );

/** Nothing reached the customer for this ticket, and the draft is still a draft for a person. */
function expectNothingSent(ticketId: string): void {
  expect(deliveries(ticketId)).toEqual([]);
  expect(outboundMessages(ticketId)).toEqual([]);
  expect(drafts(ticketId).map((draft) => draft.status)).toEqual(['draft']);
}

/** One held reason is recorded: in the evaluation, and as a note on the ticket's timeline. */
function expectHeldFor(ticketId: string, reason: string): void {
  const rows = evaluations(ticketId);
  const live = rows.filter((row) => row.mode === 'live');
  expect(live.length, 'one live evaluation').toBe(1);
  expect(live[0]?.would_auto_send).toBe(false);
  expect(live[0]?.failed_conditions, diagnose(ticketId)).toContain(reason);
  const notes = heldNotes(ticketId);
  expect(notes.length, 'a "held" note on the ticket').toBeGreaterThanOrEqual(1);
  expect(notes[0]?.payload.reason, JSON.stringify(live[0]) + diagnose(ticketId)).toBe(reason);
}

// ---------------------------------------------------------------- the promotion door (API, as people)

interface Promotion {
  id: string;
}

/** A head who also holds `ai.autonomy.owner_approve` (the schema owner grants it from the CLI in real life), signed in just now. */
async function freshOwner(browser: Browser): Promise<Actor> {
  const name = unique('owner');
  const first = await actor(browser, 'head', name);
  const id = (await first.api.get<{ user: { id: string } }>('/v1/auth/session')).json.user.id;
  sql('admin', `UPDATE users SET permissions = ARRAY['ai.autonomy.owner_approve'] WHERE id = $1`, [
    id,
  ]);
  await first.context.close();
  // A new session after the grant: the step-up of a dev stack is "the session is at most 5 minutes old".
  return actor(browser, 'head', name);
}

/** A green gate report row (what four weeks of real data would give). The report itself is the input to people, not the decider. */
function seedGreenReport(intentId: string): string {
  return (
    sql<{ id: string }>(
      'admin',
      `INSERT INTO autonomy_gate_report (intent_id, status, trigger_kind, window_start, window_end)
       VALUES ($1, 'green', 'on_demand', now() - interval '30 days', now()) RETURNING id`,
      [intentId],
    )[0]?.id ?? ''
  );
}

/** Stage 2 -> 3 the way the product does it: head asks, owner approves (fresh sign-in, typed key), owner applies. */
async function promote(browser: Browser, intent: IntentSetup): Promise<void> {
  const reportId = seedGreenReport(intent.id);
  const asked = await S.head.api.post<Promotion>(`/v1/intents/${intent.id}/autonomy/promotions`, {
    gateReportId: reportId,
    reason: 'Four weeks green (e2e)',
  });
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const owner = await freshOwner(browser);
  const decided = await owner.api.post(`/v1/autonomy/promotions/${asked.json.id}/decide`, {
    approve: true,
    reason: 'Reviewed the report (e2e)',
    confirmKey: intent.key,
  });
  expect(decided.status, JSON.stringify(decided.json)).toBe(200);
  const applied = await owner.api.post(`/v1/autonomy/promotions/${asked.json.id}/apply`, {});
  expect(applied.status, JSON.stringify(applied.json)).toBe(200);
  await owner.context.close();
  expect(stageOf(intent.id)).toBe(3);
}

/** Learns the prompt versions the drafter and the grader ran with, from the first rows of `ai_run`. */
function learnPromptVersions(): void {
  const version = (promptId: string): number =>
    Number(
      sql<{ v: number }>(
        'admin',
        `SELECT prompt_version AS v FROM ai_run WHERE prompt_id = $1 AND status = 'ok' ORDER BY created_at DESC LIMIT 1`,
        [promptId],
      )[0]?.v,
    );
  S.drafterPromptVersion = version('drafter');
  S.graderPromptVersion = version('grader_pre_send');
  expect(Number.isFinite(S.drafterPromptVersion) && Number.isFinite(S.graderPromptVersion)).toBe(
    true,
  );
}

/** An automatic reply goes out when its 120 s hold has run out (nothing here shortens it). */
async function waitSent(ticketId: string): Promise<void> {
  await until(
    'the automatic reply to be sent',
    () => (deliveries(ticketId).some((row) => row.state === 'sent') ? true : undefined),
    180_000,
  ).catch((error: unknown) => {
    throw new Error(`${String(error)} ${diagnose(ticketId)}`);
  });
}

// =====================================================================================================
// Flag OFF: shadow mode
// =====================================================================================================

test.describe.serial('Stage 3 / flag OFF: shadow mode only', () => {
  test.skip(
    ON || !fakeLive,
    'run with E2E_AUTOSEND_FLAG unset (flag off) and E2E_AI_FAKE_LIVE_FILE',
  );
  const word = `zebra${unique('o').replace(/-/g, '')}`;
  let intent: IntentSetup;
  let stage3NoShadow: IntentSetup;

  test.beforeAll(async ({ browser }) => {
    await setup(browser);
    await publishArticle(word);
  });

  test('the api says the flag is off, and a request to promote is refused with 409 autosend_flag_off', async () => {
    const state = await S.head.api.get<{ autosendFlag: boolean }>('/v1/autonomy');
    expect(state.json.autosendFlag).toBe(false);
    intent = createIntent(word, { shadow: true });
    const asked = await S.head.api.post(`/v1/intents/${intent.id}/autonomy/promotions`, {
      gateReportId: seedGreenReport(intent.id),
      reason: 'try it with the flag off',
    });
    expect(asked.status).toBe(409);
    expect(JSON.stringify(asked.json)).toContain('autosend_flag_off');
    // The boot of a flag-OFF stack leaves no flag-boot audit row (the flag is not set at all).
    expect(
      sql('admin', `SELECT 1 FROM audit_log WHERE action = 'autonomy.autosend_flag_boot'`).length,
    ).toBe(0);
  });

  test('an intent at stage 3 in the database acts as stage 2: shadow rows, nothing is sent', async () => {
    // Warm-up of the models: the first drafts also tell us the prompt versions a replay must name.
    const first = await customerWrites(intent);
    learnPromptVersions();
    recordReplay(intent.id);
    // Stage 3 exists in the database (the owner turned the flag off after promoting): the trigger that only a
    // promotion may pass is lifted for this one UPDATE, in the throwaway database, to set the situation up.
    sql('admin', `ALTER TABLE intent DISABLE TRIGGER intent_require_promotion`);
    try {
      sql('admin', `UPDATE intent SET autonomy_stage = 3 WHERE id = $1`, [intent.id]);
    } finally {
      sql('admin', `ALTER TABLE intent ENABLE TRIGGER intent_require_promotion`);
    }
    expect(stageOf(intent.id)).toBe(3);
    expectNothingSent(first.id);

    const ticket = await customerWrites(intent);
    const rows = evaluations(ticket.id);
    expect(rows.length).toBe(1);
    // Everything else about this ticket is fine: shadow says "would have sent", and still sends nothing.
    expect(rows[0]?.failed_conditions, diagnose(ticket.id)).toEqual([]);
    expect(rows[0]).toMatchObject({ mode: 'shadow', effective_stage: 2, would_auto_send: true });
    expectNothingSent(ticket.id);
    // Not even after the 120 s hold of a live send would have run out: there is nothing to wait for.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expectNothingSent(ticket.id);
    expect(gmailSends().filter((send) => send.requestedThreadId?.includes(ticket.key))).toEqual([]);
    expect(
      sql('admin', `SELECT 1 FROM outbound_delivery WHERE origin = 'ai_auto'`).length,
      'no ai_auto delivery in the whole database',
    ).toBe(0);
  });

  test('a stage 3 intent without shadow mode is not evaluated at all while the flag is off', async () => {
    // A word of its own: the dev mock classifier matches intent words as substrings of the mail.
    const other = `yak${unique('q').replace(/-/g, '')}`;
    stage3NoShadow = createIntent(other, { procedure: 'allowed' });
    await publishArticle(other);
    sql('admin', `ALTER TABLE intent DISABLE TRIGGER intent_require_promotion`);
    try {
      sql('admin', `UPDATE intent SET autonomy_stage = 3 WHERE id = $1`, [stage3NoShadow.id]);
    } finally {
      sql('admin', `ALTER TABLE intent ENABLE TRIGGER intent_require_promotion`);
    }
    const ticket = await customerWrites(stage3NoShadow, { evaluated: false });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(evaluations(ticket.id)).toEqual([]);
    expectNothingSent(ticket.id);
  });

  test('the head sees the whole thing in the timeline of a shadow ticket as a draft waiting for a person', async () => {
    const ticket = await customerWrites(intent);
    const page = S.head.page;
    await page.goto(`/?ticket=${ticket.key}`);
    await expect(page.getByText('Sent automatically by AI')).toHaveCount(0);
    expect(outboundMessages(ticket.id)).toEqual([]);
  });
});

// =====================================================================================================
// Flag ON: the live path
// =====================================================================================================

test.describe.serial('Stage 3 / flag ON: the gate, the send, rollback, the eval gate', () => {
  test.skip(!ON || !fakeLive, 'run with E2E_AUTOSEND_FLAG=on and E2E_AI_FAKE_LIVE_FILE');
  const base = unique('n').replace(/-/g, '');
  let happy: IntentSetup;
  let browserRef: Browser;

  test.beforeAll(async ({ browser }) => {
    browserRef = browser;
    await setup(browser);
  });

  test('both processes booted with the flag on: the api shows it, and each wrote its flag-boot audit row', async () => {
    const state = await S.head.api.get<{ autosendFlag: boolean }>('/v1/autonomy');
    expect(state.json.autosendFlag).toBe(true);
    const rows = sql<{ source: string }>(
      'admin',
      `SELECT metadata->>'process' AS source FROM audit_log WHERE action = 'autonomy.autosend_flag_boot'`,
    );
    expect(rows.map((row) => row.source).sort()).toEqual(['api', 'worker']);
  });

  test('warm-up: an intent in shadow mode learns the prompt versions; with no replay everything is held as replay_missing', async () => {
    const word = `warm${base}`;
    await publishArticle(word);
    const intent = createIntent(word, { shadow: true });
    const ticket = await customerWrites(intent);
    learnPromptVersions();
    const rows = evaluations(ticket.id);
    expect(rows[0]?.mode).toBe('shadow');
    expect(rows[0]?.failed_conditions).toContain('replay_missing');
    expectNothingSent(ticket.id);
  });

  test('a stage 3 intent without a passing replay: the draft is held with replay_missing, nothing is sent', async () => {
    const word = `norp${base}`;
    await publishArticle(word);
    const intent = createIntent(word);
    await promote(browserRef, intent);
    const ticket = await customerWrites(intent);
    expectHeldFor(ticket.id, 'replay_missing');
    expectNothingSent(ticket.id);
    // The reason is on the page for the person who picks the draft up.
    const page = S.head.page;
    await page.goto(`/?ticket=${ticket.key}`);
    const line = page.getByText(/AI meant to send but was held/);
    await expect(line).toBeVisible();
    // B-009: the line has no words for this reason yet (it says `the check "replay_missing" did not pass`); recorded, not asserted.
    test.info().annotations.push({
      type: 'held line (B-009)',
      description: (await line.textContent()) ?? '',
    });
  });

  test('every condition met: an ai_auto reply is held 120 s, then sent with the AI footer in the customer thread', async () => {
    test.setTimeout(300_000); // the real hold is 120 s
    const word = `happy${base}`;
    await publishArticle(word);
    happy = createIntent(word);
    await promote(browserRef, happy);
    recordReplay(happy.id);
    const ticket = await customerWrites(happy);
    const live = evaluations(ticket.id).filter((row) => row.mode === 'live');
    expect(live[0], JSON.stringify(evaluations(ticket.id))).toMatchObject({
      would_auto_send: true,
      failed_conditions: [],
      effective_stage: 3,
    });
    const [delivery] = deliveries(ticket.id);
    expect(delivery).toMatchObject({ origin: 'ai_auto', state: 'scheduled', hold_seconds: 120 });
    expect(drafts(ticket.id).map((draft) => draft.status)).toEqual(['auto_approved']);
    // Held: a person can still stop it, so it has not gone out 30 seconds in.
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    expect(deliveries(ticket.id)[0]?.state).toBe('scheduled');
    expect(gmailSends().length).toBe(0);
    // ... and it goes out once the hold has run out (the real 120 s).
    await until(
      'the send after the hold',
      () => (deliveries(ticket.id)[0]?.state === 'sent' ? true : undefined),
      150_000,
    ).catch((error: unknown) => {
      throw new Error(`${String(error)} ${diagnose(ticket.id)}`);
    });
    const sent = outboundMessages(ticket.id);
    expect(sent.length).toBe(1);
    expect(sent[0]?.sender_user_id, 'an automatic reply has no author').toBeNull();
    expect(sent[0]?.body_text).toContain('This reply was sent automatically by our AI assistant');
    expect(
      sql<{ ai_handled: boolean }>('admin', `SELECT ai_handled FROM ticket WHERE id = $1`, [
        ticket.id,
      ])[0]?.ai_handled,
    ).toBe(true);
    const mail =
      gmailSends().find((send) => send.requestedThreadId === `thr-${ticket.key}`) ??
      gmailSends().at(-1);
    expect(mail, 'a reply went through the (in-memory) Gmail').toBeDefined();
    // The page labels it, for the person reading the ticket.
    const page = S.head.page;
    await page.goto(`/?ticket=${ticket.key}`);
    await expect(page.getByText('Sent automatically by AI').first()).toBeVisible();
    // The audit trail of the AI action: the prompt, the model, the grade.
    expect(
      sql(
        'admin',
        `SELECT 1 FROM ai_grade WHERE ticket_id = $1 AND phase = 'pre_send' AND passed`,
        [ticket.id],
      ).length,
    ).toBe(1);
  });

  // ------------------------------------------------------------ conditions that must hold the send

  /** A stage 3 intent with its article, its replay and (unless told otherwise) a procedure that allows auto-send. */
  async function liveIntent(
    prefix: string,
    options: { procedure?: ProcedureKind; replay?: boolean } = {},
  ): Promise<IntentSetup> {
    const word = `${prefix}${base}`;
    await publishArticle(word);
    const intent = createIntent(word, { procedure: options.procedure });
    await promote(browserRef, intent);
    if (options.replay !== false) recordReplay(intent.id);
    return intent;
  }

  const heldCases: {
    name: string;
    prefix: string;
    reason: string;
    intent?: { procedure: ProcedureKind };
    mail?: { body?: string; verified?: boolean; auth?: 'pass' | 'none' };
    knobs?: () => void;
  }[] = [
    {
      name: 'the customer asks for a person',
      prefix: 'human',
      reason: 'customer_wants_human',
      mail: {
        body: 'Hello, I cannot sign in. Please let me talk to a human agent, not a bot. {W}',
      },
    },
    {
      name: 'the procedure of the intent says auto-send is never allowed',
      prefix: 'never',
      reason: 'procedure_not_autosend',
      intent: { procedure: 'never' },
    },
    {
      name: 'a require_human step of the procedure matched this ticket',
      prefix: 'reqhum',
      reason: 'procedure_requires_human',
      intent: { procedure: 'require_human' },
    },
    {
      name: 'the grader is the same model as the drafter (not independent)',
      prefix: 'samemod',
      reason: 'grader_not_independent',
      knobs: () => {
        setAiKnobs({ graderModel: aiKnobs().drafterModel });
      },
    },
    {
      name: 'the sender of the mail was not authenticated',
      prefix: 'noauth',
      reason: 'sender_unauthenticated',
      mail: { auth: 'none' },
    },
    {
      name: 'the contact is not verified',
      prefix: 'unver',
      reason: 'contact_unverified',
      mail: { verified: false },
    },
  ];

  for (const held of heldCases) {
    test(`held, with the reason recorded and nothing sent: ${held.name}`, async () => {
      const intent = await liveIntent(held.prefix, held.intent ?? {});
      held.knobs?.();
      try {
        const ticket = await customerWrites(intent, {
          ...held.mail,
          ...(held.mail?.body ? { body: held.mail.body.replace('{W}', intent.word) } : {}),
        });
        expectHeldFor(ticket.id, held.reason);
        expectNothingSent(ticket.id);
        // A person still has the draft to send, with the reason on the timeline.
        const page = S.head.page;
        await page.goto(`/?ticket=${ticket.key}`);
        await expect(page.getByText(/AI meant to send but was held/)).toBeVisible();
      } finally {
        setAiKnobs();
      }
    });
  }

  // ------------------------------------------------------------ rollback

  /** A stage 3 intent with `count` customers answered automatically (the hold skipped), each ticket sent. */
  async function sentReplies(
    prefix: string,
    count: number,
  ): Promise<{ intent: IntentSetup; tickets: TicketRow[] }> {
    const intent = await liveIntent(prefix);
    const tickets: TicketRow[] = [];
    for (let i = 0; i < count; i += 1) {
      const ticket = await customerWrites(intent);
      expect(
        evaluations(ticket.id).find((row) => row.mode === 'live')?.would_auto_send,
        diagnose(ticket.id),
      ).toBe(true);
      tickets.push(ticket);
    }
    // All the tickets wait out their hold (120 s) side by side.
    for (const ticket of tickets) await waitSent(ticket.id);
    return { intent, tickets };
  }

  async function reopen(ticket: TicketRow): Promise<void> {
    const resolved = await S.head.api.post(`/v1/tickets/${ticket.key}/status`, {
      status: 'resolved',
    });
    expect(resolved.status, JSON.stringify(resolved.json)).toBe(200);
    const open = await S.head.api.post(`/v1/tickets/${ticket.key}/status`, { status: 'open' });
    expect(open.status, JSON.stringify(open.json)).toBe(200);
  }

  const lastHistory = (intentId: string) =>
    sql<{ change: string; evidence: { rule?: string } | null; reason: string | null }>(
      'admin',
      `SELECT change, evidence, reason FROM intent_autonomy_history WHERE intent_id = $1 ORDER BY changed_at DESC LIMIT 1`,
      [intentId],
    )[0];

  /** The rollback notification of an intent, as the head reads it (written just after the rollback, so wait for it). */
  async function rollbackNotice(
    intentKey: string,
  ): Promise<{ kind: string; severity: string; data: Record<string, unknown> }> {
    return until(
      'the autonomy.rollback notification of the head',
      async () => {
        const answer = await S.head.api.get<{
          items: { kind: string; severity: string; data: Record<string, unknown> }[];
        }>('/v1/notifications?limit=100');
        expect(answer.status).toBe(200);
        return answer.json.items.find(
          (item) => item.kind === 'autonomy.rollback' && item.data.intent === intentKey,
        );
      },
      30_000,
    );
  }

  test('rollback: one policy violation in an automatic reply moves the intent to stage 2 at once, and the head is told', async () => {
    test.setTimeout(240_000);
    const { intent, tickets } = await sentReplies('viol', 1);
    expect(stageOf(intent.id)).toBe(3);
    // The sampled grade of the sent reply finds a violation (the grader's answer changes after the send).
    setAiKnobs({
      violations: [{ code: 'policy', text: 'The reply promised a refund.', factIds: [] }],
    });
    try {
      // One reopen is one bad reply of the 20: not a reason by itself. The violation is.
      await reopen(tickets[0] as TicketRow);
      await until(
        'the rollback to stage 2',
        () => (stageOf(intent.id) === 2 ? true : undefined),
        90_000,
      );
    } finally {
      setAiKnobs();
    }
    expect(lastHistory(intent.id)).toMatchObject({
      change: 'auto_rollback',
      evidence: { rule: 'violation' },
    });
    expect(await rollbackNotice(intent.key)).toMatchObject({
      severity: 'high',
      data: { rule: 'violation' },
    });
    // New mail of this intent is a draft for a person again, not an automatic reply.
    const next = await customerWrites(intent, { evaluated: false });
    await new Promise((resolve) => setTimeout(resolve, 5000));
    expect(evaluations(next.id)).toEqual([]);
    expectNothingSent(next.id);
  });

  test('rollback: 2 reopened replies among the last 20 move the intent to stage 2; 1 does not', async () => {
    test.setTimeout(300_000);
    const { intent, tickets } = await sentReplies('twob', 2);
    await reopen(tickets[0] as TicketRow);
    // Give the watch time to look (an event enqueues a job within seconds): one bad reply leaves the intent at stage 3.
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    expect(stageOf(intent.id)).toBe(3);
    // The watch job of an intent is one per minute (jobId by minute): the second event goes into the next minute, see B-010
    // and the slow test below for what happens when both fall into the same one.
    await new Promise((resolve) => setTimeout(resolve, 62_000 - (Date.now() % 60_000)));
    await reopen(tickets[1] as TicketRow);
    await until(
      'the rollback to stage 2',
      () => (stageOf(intent.id) === 2 ? true : undefined),
      90_000,
    );
    expect(lastHistory(intent.id)).toMatchObject({
      change: 'auto_rollback',
      evidence: { rule: 'reopen_or_csat' },
    });
    expect(await rollbackNotice(intent.key)).toMatchObject({ data: { rule: 'reopen_or_csat' } });
  });

  // Slow (up to 20 minutes), so off unless E2E_STAGE3_SLOW=1: the finding B-010 in docs/qa/bugs.md. The watch job of an
  // intent has a jobId made of the minute, so a bad reply in the same minute as an earlier one, whose job has already
  // run and found only one, enqueues nothing; the rollback then waits for the run every 15 minutes. ADR-025 section 7
  // says "event + every 15 minutes", which reads as: the event is what makes it prompt. Expected here: rolled back
  // within 3 minutes of the second reopen.
  test('rollback timing: a second reopened reply in the same minute is rolled back promptly (B-010)', async () => {
    test.skip(process.env.E2E_STAGE3_SLOW !== '1', 'slow: set E2E_STAGE3_SLOW=1');
    test.setTimeout(30 * 60_000);
    const { intent, tickets } = await sentReplies('sameminute', 2);
    await new Promise((resolve) => setTimeout(resolve, 61_000 - (Date.now() % 60_000))); // 1 s into a minute
    await reopen(tickets[0] as TicketRow);
    await new Promise((resolve) => setTimeout(resolve, 15_000)); // the job of the first event looks and finds one bad reply
    expect(stageOf(intent.id)).toBe(3);
    await reopen(tickets[1] as TicketRow); // still the same minute
    const startedAt = Date.now();
    await until(
      'the rollback',
      () => (stageOf(intent.id) === 2 ? true : undefined),
      20 * 60_000,
      5_000,
    );
    const waitedS = Math.round((Date.now() - startedAt) / 1000);
    test.info().annotations.push({
      type: 'seconds from the second reopen to the rollback',
      description: String(waitedS),
    });
    expect(waitedS).toBeLessThan(180);
  });

  // ------------------------------------------------------------ the eval gate

  test('eval gate: no replay = the gate report cannot be green and the request is refused; a recorded replay shows as passed; the owner approves only with a fresh sign-in', async () => {
    const word = `evalg${base}`;
    await publishArticle(word);
    const intent = createIntent(word);
    const criterion = async (key: string) => {
      const made = await S.head.api.post<{
        id: string;
        status: string;
        criteria: { key: string; pass: boolean | null; value: unknown }[];
      }>(`/v1/intents/${intent.id}/autonomy/gate-reports`, {});
      expect(made.status, JSON.stringify(made.json)).toBe(200);
      return { report: made.json, criterion: made.json.criteria.find((item) => item.key === key) };
    };
    // 1. No replay: not measured, so the report is never green, and a request on it is refused.
    const before = await criterion('eval_replay_violations');
    expect(before.criterion).toMatchObject({ pass: null, value: 'not_measured' });
    expect(before.report.status).not.toBe('green');
    const refused = await S.head.api.post(`/v1/intents/${intent.id}/autonomy/promotions`, {
      gateReportId: before.report.id,
      reason: 'try without a replay',
    });
    expect(refused.status).toBe(403);
    // B-011: the OpenAPI text promises a `reason` code (`report_not_green`); the body carries only the message.
    test.info().annotations.push({
      type: 'refusal body (B-011)',
      description: JSON.stringify(refused.json),
    });
    expect(stageOf(intent.id)).toBe(2);
    expect(
      sql('admin', `SELECT 1 FROM intent_autonomy_promotion WHERE intent_id = $1`, [intent.id]),
    ).toEqual([]);

    // 2. A replay that ran on the mock, or found a violation, does not count as passed.
    await warmForReplay(intent);
    recordReplay(intent.id, { mock: true });
    expect((await criterion('eval_replay_violations')).criterion?.pass).toBeNull();
    recordReplay(intent.id, { violations: 2 });
    const failedReport = await criterion('eval_replay_violations');
    expect(failedReport.criterion).toMatchObject({ pass: false, value: 2 });
    expect(failedReport.report.status).toBe('red');

    // 3. A passing replay of the combination in force is measured as passed (the other criteria still need four weeks of real data).
    recordReplay(intent.id);
    const passed = await criterion('eval_replay_violations');
    expect(passed.criterion).toMatchObject({ pass: true, value: 0 });
    expect((await criterion('redaction_eval')).criterion).toMatchObject({ pass: true });

    // 4. With a green report (seeded: four weeks of data cannot be made here) the owner's approval needs a session that
    //    signed in within 5 minutes: an older one is refused, a fresh one goes through.
    const asked = await S.head.api.post<Promotion>(`/v1/intents/${intent.id}/autonomy/promotions`, {
      gateReportId: seedGreenReport(intent.id),
      reason: 'Replay passed, four weeks green (e2e)',
    });
    expect(asked.status, JSON.stringify(asked.json)).toBe(200);
    const stale = await freshOwner(browserRef);
    sql(
      'admin',
      `UPDATE sessions SET created_at = now() - interval '10 minutes' WHERE user_id = (SELECT id FROM users WHERE permissions @> ARRAY['ai.autonomy.owner_approve'] ORDER BY created_at DESC LIMIT 1)`,
    );
    const late = await stale.api.post(`/v1/autonomy/promotions/${asked.json.id}/decide`, {
      approve: true,
      reason: 'late approval',
      confirmKey: intent.key,
    });
    expect(late.status).toBe(403);
    expect(JSON.stringify(late.json)).toContain('reauth_required');
    const wrongKey = await (
      await freshOwner(browserRef)
    ).api.post(`/v1/autonomy/promotions/${asked.json.id}/decide`, {
      approve: true,
      reason: 'typed the wrong key',
      confirmKey: 'not_the_key',
    });
    expect(wrongKey.status).toBeGreaterThanOrEqual(400);
    expect(stageOf(intent.id)).toBe(2);
    const owner = await freshOwner(browserRef);
    const approved = await owner.api.post(`/v1/autonomy/promotions/${asked.json.id}/decide`, {
      approve: true,
      reason: 'Reviewed the report and the replay (e2e)',
      confirmKey: intent.key,
    });
    expect(approved.status, JSON.stringify(approved.json)).toBe(200);
    const applied = await owner.api.post(`/v1/autonomy/promotions/${asked.json.id}/apply`, {});
    expect(applied.status, JSON.stringify(applied.json)).toBe(200);
    expect(stageOf(intent.id)).toBe(3);
  });

  /** The replay names the prompt versions of the drafter and the grader, which an intent's own tickets have not made yet. */
  async function warmForReplay(intent: IntentSetup): Promise<void> {
    if (Number.isFinite(S.drafterPromptVersion)) return;
    await customerWrites({ ...intent, id: intent.id });
    learnPromptVersions();
  }
});

// =====================================================================================================
// Flag ON with the plain mock provider: nothing can clear a send
// =====================================================================================================

test.describe
  .serial('Stage 3 / flag ON with AI_PROVIDER=mock: a mock grade never clears an automatic send', () => {
  test.skip(!ON || fakeLive, 'run with E2E_AUTOSEND_FLAG=on and no E2E_AI_FAKE_LIVE_FILE');
  test('a stage 3 intent is held, among other reasons as grade_mock: the grade of the mock provider never clears a send', async ({
    browser,
  }) => {
    await setup(browser);
    const word = `mockp${unique('m').replace(/-/g, '')}`;
    await publishArticle(word);
    const intent = createIntent(word);
    await promote(browser, intent);
    // The dev mock's classifier is only sometimes sure enough of the intent for the AI to draft on its own (its confidence is
    // a hash of the input), so write until a draft comes: about four tries at most in practice.
    let ticket: TicketRow | undefined;
    for (let attempt = 0; attempt < 6 && ticket === undefined; attempt += 1) {
      const candidate = await customerWrites(intent, { evaluated: false, draftWaitMs: 20_000 });
      if (drafts(candidate.id).length > 0) ticket = candidate;
    }
    if (ticket === undefined)
      throw new Error('the mock classifier never trusted the intent in 6 tries');
    await until(
      'the evaluation',
      () => (evaluations(ticket.id).length > 0 ? true : undefined),
      30_000,
    );
    const live = evaluations(ticket.id).filter((row) => row.mode === 'live');
    expect(live[0]?.would_auto_send).toBe(false);
    // The mock's grader is a model of its own (so independence is not what stops it): its grade is flagged `mock`, and the
    // gate never lets that clear a send, whatever else holds.
    expect(live[0]?.failed_conditions).toContain('grade_mock');
    expectNothingSent(ticket.id);
    expect(sql('admin', `SELECT 1 FROM outbound_delivery WHERE origin = 'ai_auto'`).length).toBe(0);
  });
});
