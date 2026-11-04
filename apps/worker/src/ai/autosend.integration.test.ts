import { randomBytes, randomUUID } from 'node:crypto';

import { gmail, line } from '@watchtower/channels';
import {
  DevMockLlmProvider,
  mockSettings,
  type LlmProvider,
  type LlmRequest,
  type SettingsSource,
} from '@watchtower/ai';
import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import {
  composeAutoSendText,
  createDomain,
  createPolicyGate,
  instanceOrigins,
  recordPreSendGrade,
  resolveAiCaps,
  type Domain,
} from '@watchtower/domain';
import { AUDIT_ACTIONS, AUTONOMY_TICKET_EVENTS, type RealtimeEvent } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../logger.js';
import { createOutboundDispatcher, type OutboundDispatcher } from '../outbound/dispatcher.js';
import { testConfig } from '../testing/support.js';
import { runAutoSendStep, type AutoSendStepInput } from './autosend.js';
import { createAiRuntime, type AiRuntime } from './runtime.js';

// ADR-025 sections 3, 4 and 11 in the worker: shadow mode, the live path from the draft to the dispatcher, and
// every way the dispatcher refuses at claim time. Postgres (restricted application role), the in-memory Gmail,
// the real gate. The model is a fake provider with a model id other than the drafter's for the grader.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const net = disableNetConnect();

const T0 = new Date('2030-01-07T10:00:00.000Z');
const clock = { now: T0 };
const HOST = 'desk.example.test';
const ORIGIN = 'https://desk.example.test';

let testDb: TestDatabase;
let database: Database;
let gateOn: Domain;
let gateOff: Domain;
let runtime: AiRuntime;
let runtimeSameModel: AiRuntime;
let fakeGmail: gmail.FakeGmailTransport;
let gmailId = '';
let portalId = '';
let headId = '';
let ownerPersonId = '';
let graderAnswer: { score: number; violations: unknown[] } = { score: 0.95, violations: [] };
let graderCalls = 0;
const events: RealtimeEvent[] = [];
const logger = createLogger(testConfig());
const owner = () => testDb.owner.db;
const sink = { publish: (event: RealtimeEvent) => (events.push(event), Promise.resolve()) };

/** A provider that is not the mock (so a grade it makes is not `mock`): it answers the grader with `graderAnswer`. */
function fakeProvider(): LlmProvider {
  const inner = new DevMockLlmProvider();
  return {
    kind: 'anthropic',
    generate(request: LlmRequest) {
      if (request.prompt.id === 'grader_pre_send') {
        graderCalls += 1;
        return Promise.resolve({
          text: JSON.stringify(graderAnswer),
          finishReason: 'stop' as const,
          usage: { inputTokens: 10, outputTokens: 5 },
          model: request.model,
        });
      }
      return inner.generate(request);
    },
  };
}

function settingsWith(graderModel: string | undefined): SettingsSource {
  const base = mockSettings();
  const tiers = {
    deep: { provider: 'anthropic' as const, model: 'drafter-fixture' },
    standard: { provider: 'anthropic' as const, model: 'drafter-fixture' },
    light: { provider: 'anthropic' as const, model: 'drafter-fixture' },
  };
  const settings = {
    ...base,
    tiers,
    agentModels: graderModel === undefined ? {} : { grader: graderModel },
  };
  return { load: () => Promise.resolve(settings) };
}

function domainWith(flag: boolean): Domain {
  return createDomain({
    ticketKeyPrefix: 'OPS',
    sealKey: randomBytes(32),
    portalUrl: `${ORIGIN}/portal`,
    autosendEnabled: flag,
    policyGate: createPolicyGate({
      db: database.db,
      autosendEnabled: flag,
      aiCaps: resolveAiCaps({}),
      linkOrigins: instanceOrigins(ORIGIN),
    }),
    now: () => clock.now,
  });
}

function dispatcherFor(domain: Domain): OutboundDispatcher {
  const adapter = new gmail.GmailAdapter({ transport: fakeGmail });
  const lineAdapter = new line.LineAdapter({
    transport: new line.FakeLineTransport({ now: () => clock.now }),
    getChannelSecret: () => Promise.resolve('unused'),
  });
  return createOutboundDispatcher({
    database,
    domain,
    channels: {
      gmail: () => ({
        from: { address: 'support@desk.example.test', name: 'Support' },
        send: (input) => adapter.send(input),
      }),
      line: () => ({ send: (input) => lineAdapter.send(input) }),
    },
    appHost: HOST,
    realtime: sink,
    logger,
  });
}

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  database = createDatabase({ url: testDb.appUrl, max: 8, applicationName: 'wt-autosend-test' });
  gateOn = domainWith(true);
  gateOff = domainWith(false);
  const make = (settings: SettingsSource): AiRuntime =>
    createAiRuntime(testConfig(), database, logger, {
      providers: { anthropic: fakeProvider() },
      settings,
    });
  runtime = make(settingsWith('grader-fixture'));
  runtimeSameModel = make(settingsWith(undefined));
  await owner()
    .insert(schema.slaPolicy)
    .values({
      name: 'standard',
      tier: 'standard',
      targets: { P3: { first_response_min: 60, resolution_min: 240, calendar: '24x7' } },
    });
  const [mailbox] = await owner()
    .insert(schema.channelAccount)
    .values({ type: 'gmail', name: 'Support mailbox' })
    .returning();
  gmailId = mailbox?.id ?? '';
  // The portal account is seeded by a migration (one per instance).
  const [portal] = await owner()
    .select()
    .from(schema.channelAccount)
    .where(eq(schema.channelAccount.type, 'portal'));
  portalId = portal?.id ?? '';
  const [head] = await owner()
    .insert(schema.users)
    .values({ email: `${randomUUID()}@example.test`, name: 'Head', role: 'head' })
    .returning({ id: schema.users.id });
  headId = head?.id ?? '';
  const [person] = await owner()
    .insert(schema.users)
    .values({ email: `${randomUUID()}@example.test`, name: 'Owner', role: 'head' })
    .returning({ id: schema.users.id });
  ownerPersonId = person?.id ?? '';
  await testDb.owner.pool.query(
    `UPDATE users SET permissions = ARRAY['ai.autonomy.owner_approve'] WHERE id = $1`,
    [ownerPersonId],
  );
  await testDb.owner.pool.query(`UPDATE ai_switch SET is_on = false`);
});

afterAll(async () => {
  await database.close();
  await testDb.cleanup();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

beforeEach(() => {
  clock.now = T0;
  graderAnswer = { score: 0.95, violations: [] };
  graderCalls = 0;
  events.length = 0;
  fakeGmail = new gmail.FakeGmailTransport({ now: () => clock.now });
});

// --- fixtures -------------------------------------------------------------------------------------

async function publishProcedure(intentId: string, autosend: 'allowed' | 'never'): Promise<void> {
  const person = randomUUID();
  const procedure = await testDb.owner.pool.query<{ id: string }>(
    `INSERT INTO procedure (intent_id, created_by) VALUES ($1, $2) RETURNING id`,
    [intentId, person],
  );
  const version = await testDb.owner.pool.query<{ id: string }>(
    `INSERT INTO procedure_version (procedure_id, source_md, steps, authored_by)
     VALUES ($1, 'Answer from the knowledge base.', $2::jsonb, $3) RETURNING id`,
    [procedure.rows[0]?.id, JSON.stringify({ schemaVersion: 1, autosend, steps: [] }), person],
  );
  const id = version.rows[0]?.id;
  await testDb.owner.pool.query(
    `UPDATE procedure_version SET status = 'confirmed', confirmed_by = $2, confirmed_at = now() WHERE id = $1`,
    [id, person],
  );
  await testDb.owner.pool.query(
    `INSERT INTO procedure_simulation (procedure_version_id, passed, seed_only, case_count, metrics)
     VALUES ($1, true, false, 5, '{"violations":0}'::jsonb)`,
    [id],
  );
  await testDb.owner.pool.query(`SELECT public.publish_procedure_version($1::uuid, $2::uuid)`, [
    id,
    person,
  ]);
}

/** The promotion door, end to end: report, request, owner approval with re-auth and key, apply. */
async function promote(intentId: string, key: string): Promise<void> {
  const [report] = await database.db
    .insert(schema.autonomyGateReport)
    .values({
      intentId,
      status: 'green',
      triggerKind: 'on_demand',
      windowStart: new Date(Date.now() - 30 * 86_400_000),
      windowEnd: new Date(),
    })
    .returning({ id: schema.autonomyGateReport.id });
  const reportId = report?.id ?? '';
  const requested = await database.db.transaction((tx) =>
    gateOn.autonomy.requestPromotion(tx, gateOn.context({ actor: { type: 'user', id: headId } }), {
      intentId,
      gateReportId: reportId,
      reason: 'the numbers are good',
    }),
  );
  const ownerCtx = gateOn.context({ actor: { type: 'user', id: ownerPersonId } });
  await database.db.transaction((tx) =>
    gateOn.autonomy.decidePromotion(tx, ownerCtx, {
      promotionId: requested.value.promotionId,
      approve: true,
      reason: 'approved',
      reauthAt: new Date(),
      confirmKey: key,
    }),
  );
  await database.db.transaction((tx) =>
    gateOn.autonomy.applyPromotion(tx, ownerCtx, { promotionId: requested.value.promotionId }),
  );
}

interface Scenario {
  intentId: string;
  intentKey: string;
  ticketId: string;
  draftId: string;
  body: string;
  input: AutoSendStepInput;
}

async function scenario(
  options: {
    stage?: 2 | 3;
    shadow?: boolean;
    procedure?: 'allowed' | 'never' | 'none';
    channel?: 'gmail' | 'portal';
    policyChannels?: ('gmail' | 'portal')[];
    verified?: boolean;
    priority?: string;
  } = {},
): Promise<Scenario> {
  const key = `intent_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
  const [intent] = await owner()
    .insert(schema.intent)
    .values({
      key,
      name: 'Reset a password',
      autonomyStage: 2,
      autosendShadow: options.shadow ?? false,
    })
    .returning();
  const intentId = intent?.id ?? '';
  await owner()
    .update(schema.intent)
    .set({ autosendPolicy: { channels: options.policyChannels ?? ['gmail', 'portal'] } })
    .where(eq(schema.intent.id, intentId));
  if ((options.procedure ?? 'allowed') !== 'none') {
    await publishProcedure(intentId, options.procedure === 'never' ? 'never' : 'allowed');
  }
  if (options.stage === 3) await promote(intentId, key);

  // A real customer mail, so the reply joins its thread.
  const threadId = `thread-${randomUUID()}`;
  const messageId = `${randomUUID()}@customer.example.test`;
  const fromAddress = `${randomUUID().slice(0, 8)}@customer.example.test`;
  const raw = gmail.buildFakeMime({
    from: fromAddress,
    fromName: 'Customer',
    to: 'support@desk.example.test',
    subject: 'Cannot sign in',
    body: 'How do I reset my password?',
    messageId,
  });
  fakeGmail.deliver(raw.raw, { threadId });
  const ingested = await database.db.transaction((tx) =>
    gateOn.inbound.ingest(tx, gateOn.context({ actor: { type: 'system', id: null } }), {
      message: {
        channelAccountId: gmailId,
        providerMessageId: `g-${randomUUID()}`,
        rfc822MessageId: messageId,
        threadKey: `gmail:${threadId}`,
        threadCandidates: [{ kind: 'gmail_thread_id', value: threadId }],
        from: { address: fromAddress, name: 'Customer', lineUserId: null },
        subject: 'Cannot sign in',
        bodyText: 'How do I reset my password?',
        bodyHtml: null,
        attachments: [],
        receivedAt: clock.now,
        rawObjectKey: null,
        automated: { disposition: 'human', subtype: 'none', signals: [] },
      },
    }),
  );
  const ticketId = ingested.value.ticketId ?? '';
  const [ticket] = await owner()
    .select({ contactId: schema.ticket.requesterContactId })
    .from(schema.ticket)
    .where(eq(schema.ticket.id, ticketId));
  if (options.verified !== false) {
    await owner()
      .update(schema.contact)
      .set({ verifiedAt: new Date() })
      .where(eq(schema.contact.id, ticket?.contactId ?? ''));
  }
  await owner()
    .update(schema.message)
    .set({ emailMeta: { senderAuth: 'pass' } })
    .where(and(eq(schema.message.ticketId, ticketId), eq(schema.message.direction, 'inbound')));
  await owner()
    .update(schema.ticket)
    .set({
      intentId,
      priority: options.priority ?? 'P3',
      ...(options.channel === 'portal' ? { channel: 'portal', channelAccountId: portalId } : {}),
    })
    .where(eq(schema.ticket.id, ticketId));

  const body = 'You can reset your password with the link on the sign in page.';
  await owner()
    .insert(schema.aiTicketInsight)
    .values({
      ticketId,
      state: 'draft_ready',
      generatedAt: new Date(),
      evidence: [
        {
          id: 'kb1',
          kind: 'kb',
          customerSafe: true,
          title: 'Reset a password',
          snippet: 'Use the reset link.',
        },
      ],
    });
  const [draft] = await owner()
    .insert(schema.aiDraft)
    .values({
      ticketId,
      bodyText: body,
      language: 'en',
      customerLanguage: 'en',
      citations: [{ evidenceId: 'kb1', sentence: 0, kind: 'kb' }],
      uncitedClaims: 0,
    })
    .returning({ id: schema.aiDraft.id });
  const draftId = draft?.id ?? '';
  return {
    intentId,
    intentKey: key,
    ticketId,
    draftId,
    body,
    input: {
      ticket: { id: ticketId, channel: options.channel ?? 'gmail' },
      intent: {
        id: intentId,
        key,
        stage: options.stage ?? 2,
        autosendShadow: options.shadow ?? false,
      },
      draft: { id: draftId, body, aiRunId: null, language: 'en', citedEvidenceIds: ['kb1'] },
      evidence: [
        {
          id: 'kb1',
          kind: 'kb',
          tool: 'kb_search',
          title: 'Reset a password',
          snippet: 'Use the reset link.',
          customerSafe: true,
          mock: false,
        },
      ] as unknown as AutoSendStepInput['evidence'],
      customerTurns: ['How do I reset my password?'],
      agents: runtime.agentDeps([]),
      locale: 'en',
    },
  };
}

function step(s: Scenario, domain: Domain = gateOn, rt: AiRuntime = runtime, flagOn = true) {
  return runAutoSendStep(
    {
      database,
      domain,
      settings: rt.settings,
      realtime: sink,
      logger,
      flagOn,
    },
    { ...s.input, agents: rt.agentDeps([]) },
  );
}

const evaluations = (draftId: string) =>
  owner()
    .select()
    .from(schema.aiAutosendEvaluation)
    .where(eq(schema.aiAutosendEvaluation.aiDraftId, draftId));
const draftRow = async (id: string) =>
  (await owner().select().from(schema.aiDraft).where(eq(schema.aiDraft.id, id)))[0];
const deliveriesOf = (ticketId: string) =>
  owner()
    .select()
    .from(schema.outboundDelivery)
    .where(eq(schema.outboundDelivery.ticketId, ticketId));
const heldNotes = (ticketId: string) =>
  owner()
    .select()
    .from(schema.ticketEvent)
    .where(
      and(
        eq(schema.ticketEvent.ticketId, ticketId),
        eq(schema.ticketEvent.type, AUTONOMY_TICKET_EVENTS.autosendHeld),
      ),
    );

// --- tests ----------------------------------------------------------------------------------------

describe('shadow mode (ADR-025 section 3)', () => {
  it('evaluates the whole decision for an intent at stage 2, records it, and sends nothing', async () => {
    const s = await scenario({ shadow: true });
    expect(await step(s)).toBe('shadow');
    const rows = await evaluations(s.draftId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      mode: 'shadow',
      wouldAutoSend: true,
      failedConditions: [],
      effectiveStage: 2,
    });
    expect(rows[0]?.aiGradeId).not.toBeNull();
    // The draft still waits for a person; nothing was made for the customer.
    expect((await draftRow(s.draftId))?.status).toBe('draft');
    expect(await deliveriesOf(s.ticketId)).toHaveLength(0);
    // The grade is of the composed text: the draft and the notice that it is automatic.
    const [grade] = await owner()
      .select()
      .from(schema.aiGrade)
      .where(eq(schema.aiGrade.aiDraftId, s.draftId));
    expect(grade?.phase).toBe('pre_send');
    expect(grade?.gradedText).toBe(composeAutoSendText(s.body, undefined, 'en'));
    expect(grade?.gradedText).toContain('sent automatically');
    expect(grade).toMatchObject({ independent: true, mock: false, graderModel: 'grader-fixture' });
  });

  it('lists what would still stand in the way: here the procedure says never', async () => {
    const s = await scenario({ shadow: true, procedure: 'never' });
    await step(s);
    const [row] = await evaluations(s.draftId);
    expect(row?.wouldAutoSend).toBe(false);
    expect(row?.failedConditions).toEqual(['procedure_not_autosend']);
  });

  it('does nothing for an intent that is neither promoted nor in shadow, and makes no model call', async () => {
    const s = await scenario({ shadow: false });
    expect(await step(s)).toBe('off');
    expect(graderCalls).toBe(0);
    expect(await evaluations(s.draftId)).toHaveLength(0);
  });

  it('does not call the grader when it would be the drafter model, and records why', async () => {
    const s = await scenario({ shadow: true });
    expect(await step(s, gateOn, runtimeSameModel)).toBe('shadow');
    expect(graderCalls).toBe(0);
    const [row] = await evaluations(s.draftId);
    expect(row?.failedConditions).toContain('grader_not_independent');
    expect(row?.wouldAutoSend).toBe(false);
  });

  it('a grader that finds a violation keeps the draft for a person (score capped, not passed)', async () => {
    graderAnswer = {
      score: 0.99,
      violations: [{ code: 'promise', text: 'It promises a refund.' }],
    };
    const s = await scenario({ shadow: true });
    await step(s);
    const [row] = await evaluations(s.draftId);
    expect(row?.failedConditions).toEqual(
      expect.arrayContaining(['grade_failed', 'grade_violations', 'grade_score_low']),
    );
  });
});

describe('the live path (stage 3, flag on)', () => {
  it('schedules an ai_auto delivery held 120 s, and the dispatcher sends it after the hold', async () => {
    const s = await scenario({ stage: 3 });
    expect(await step(s)).toBe('scheduled');
    const [delivery] = await deliveriesOf(s.ticketId);
    expect(delivery).toMatchObject({
      origin: 'ai_auto',
      state: 'scheduled',
      holdSeconds: 120,
      approvedBy: null,
      createdBy: null,
      channel: 'gmail',
    });
    expect(delivery?.aiGradeId).not.toBeNull();
    const [message] = await owner()
      .select()
      .from(schema.message)
      .where(eq(schema.message.id, delivery?.messageId ?? ''));
    expect(message?.senderUserId).toBeNull();
    expect(message?.bodyText).toBe(composeAutoSendText(s.body, undefined, 'en'));
    expect((await draftRow(s.draftId))?.status).toBe('auto_approved');
    expect((await evaluations(s.draftId))[0]).toMatchObject({
      mode: 'live',
      wouldAutoSend: true,
      effectiveStage: 3,
    });

    const dispatcher = dispatcherFor(gateOn);
    // Too early: the hold has not ended.
    expect((await dispatcher.dispatch(delivery?.id ?? '')).status).not.toBe('sent');
    clock.now = new Date(T0.getTime() + 121_000);
    expect(await dispatcher.dispatch(delivery?.id ?? '')).toMatchObject({ status: 'sent' });
    const [sent] = await deliveriesOf(s.ticketId);
    expect(sent?.state).toBe('sent');
    expect((await draftRow(s.draftId))?.status).toBe('sent');
    const [ticket] = await owner()
      .select({ aiHandled: schema.ticket.aiHandled })
      .from(schema.ticket)
      .where(eq(schema.ticket.id, s.ticketId));
    expect(ticket?.aiHandled).toBe(true);
    const scheduled = await owner()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, AUDIT_ACTIONS.autonomyAutosendScheduled));
    expect(scheduled.some((row) => row.targetId === delivery?.id)).toBe(true);
  });

  it('sends on the portal too: no provider is called, the message is shown (route null)', async () => {
    const s = await scenario({ stage: 3, channel: 'portal' });
    expect(await step(s)).toBe('scheduled');
    const [delivery] = await deliveriesOf(s.ticketId);
    expect(delivery).toMatchObject({ origin: 'ai_auto', channel: 'portal' });
    clock.now = new Date(T0.getTime() + 121_000);
    expect(await dispatcherFor(gateOn).dispatch(delivery?.id ?? '')).toMatchObject({
      status: 'sent',
      route: null,
    });
    const [message] = await owner()
      .select()
      .from(schema.message)
      .where(eq(schema.message.id, delivery?.messageId ?? ''));
    expect(message?.deliveryStatus).toBe('delivered');
  });

  it('holds back, with a note and the draft left for a person, when a condition fails (policy has no channel)', async () => {
    const s = await scenario({ stage: 3, policyChannels: [] });
    expect(await step(s)).toBe('held');
    expect(await deliveriesOf(s.ticketId)).toHaveLength(0);
    expect((await draftRow(s.draftId))?.status).toBe('draft');
    const notes = await heldNotes(s.ticketId);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.visibility).toBe('internal');
    expect(notes[0]?.payload).toMatchObject({ reason: 'channel_not_allowed' });
    expect((await evaluations(s.draftId))[0]).toMatchObject({ mode: 'live', wouldAutoSend: false });
    // Once per draft: the same step again writes no second note.
    await step(s);
    expect(await heldNotes(s.ticketId)).toHaveLength(1);
  });

  it.each([
    ['an unverified contact', { verified: false }, 'contact_unverified'],
    ['a P2 ticket', { priority: 'P2' }, 'priority_blocked'],
    ['a procedure that says never', { procedure: 'never' as const }, 'procedure_not_autosend'],
    ['no procedure at all', { procedure: 'none' as const }, 'procedure_not_autosend'],
  ])('does not send for %s', async (_name, options, reason) => {
    const s = await scenario({ stage: 3, ...options });
    expect(await step(s)).toBe('held');
    expect(await deliveriesOf(s.ticketId)).toHaveLength(0);
    expect((await heldNotes(s.ticketId))[0]?.payload).toHaveProperty('reason');
    const [row] = await evaluations(s.draftId);
    expect(row?.failedConditions).toContain(reason);
  });

  it('with the flag off, a stage 3 intent in the database acts as stage 2: shadow only, never a delivery', async () => {
    const s = await scenario({ stage: 3, shadow: true });
    expect(await step(s, gateOff, runtime, false)).toBe('shadow');
    expect(await deliveriesOf(s.ticketId)).toHaveLength(0);
    expect((await evaluations(s.draftId))[0]).toMatchObject({ mode: 'shadow', effectiveStage: 2 });
    expect((await draftRow(s.draftId))?.status).toBe('draft');
    // And without shadow it does not even grade.
    const quiet = await scenario({ stage: 3, shadow: false });
    expect(await step(quiet, gateOff, runtime, false)).toBe('off');
    expect(await deliveriesOf(quiet.ticketId)).toHaveLength(0);
  });

  it('the stage cap switch turns a live intent into a shadow one', async () => {
    const s = await scenario({ stage: 3, shadow: true });
    await testDb.owner.pool.query(
      `UPDATE ai_switch SET is_on = true WHERE key = 'ai_stage_cap_pinned'`,
    );
    try {
      expect(await step(s)).toBe('shadow');
    } finally {
      await testDb.owner.pool.query(
        `UPDATE ai_switch SET is_on = false WHERE key = 'ai_stage_cap_pinned'`,
      );
    }
    expect(await deliveriesOf(s.ticketId)).toHaveLength(0);
  });

  it('the kill switch stops it before any model call', async () => {
    const s = await scenario({ stage: 3 });
    await testDb.owner.pool.query(`UPDATE ai_switch SET is_on = true WHERE key = 'ai_kill_switch'`);
    try {
      expect(await step(s)).toBe('off');
    } finally {
      await testDb.owner.pool.query(
        `UPDATE ai_switch SET is_on = false WHERE key = 'ai_kill_switch'`,
      );
    }
    expect(graderCalls).toBe(0);
  });
});

describe('the dispatcher at claim time', () => {
  async function scheduled(): Promise<{ s: Scenario; deliveryId: string }> {
    const s = await scenario({ stage: 3 });
    expect(await step(s)).toBe('scheduled');
    const [delivery] = await deliveriesOf(s.ticketId);
    clock.now = new Date(T0.getTime() + 121_000);
    return { s, deliveryId: delivery?.id ?? '' };
  }

  async function expectHeld(s: Scenario, deliveryId: string, reason: string): Promise<void> {
    const [delivery] = await deliveriesOf(s.ticketId);
    expect(delivery).toMatchObject({
      id: deliveryId,
      state: 'cancelled',
      errorCode: 'policy_denied',
    });
    // The draft is a draft again, the message says it never went out, and the ticket says why.
    expect((await draftRow(s.draftId))?.status).toBe('draft');
    expect((await draftRow(s.draftId))?.autoApprovedAt).toBeNull();
    const [message] = await owner()
      .select()
      .from(schema.message)
      .where(eq(schema.message.id, delivery?.messageId ?? ''));
    expect(message?.deliveryStatus).toBe('cancelled');
    expect(
      (await heldNotes(s.ticketId)).some(
        (note) => (note.payload as { reason?: string }).reason === reason,
      ),
    ).toBe(true);
  }

  it('the worker checks its own flag: an api with it on and a worker with it off sends nothing', async () => {
    const { s, deliveryId } = await scheduled();
    expect(await dispatcherFor(gateOff).dispatch(deliveryId)).toEqual({
      status: 'denied',
      reason: 'autosend_flag_off',
    });
    await expectHeld(s, deliveryId, 'autosend_flag_off');
  });

  it('a person who replied during the hold ends it: nothing is sent', async () => {
    const { s, deliveryId } = await scheduled();
    const [staff] = await owner()
      .insert(schema.users)
      .values({ email: `${randomUUID()}@example.test`, name: 'Staff', role: 'agent' })
      .returning({ id: schema.users.id });
    await owner()
      .insert(schema.message)
      .values({
        ticketId: s.ticketId,
        direction: 'outbound',
        senderUserId: staff?.id ?? null,
        bodyText: 'I will take this one.',
        visibility: 'public',
        deliveryStatus: 'delivered',
        // The test clock is the domain's clock (the delivery was made at T0), not the machine's.
        createdAt: new Date(T0.getTime() + 5_000),
      });
    expect(await dispatcherFor(gateOn).dispatch(deliveryId)).toEqual({
      status: 'denied',
      reason: 'human_stepped_in',
    });
    await expectHeld(s, deliveryId, 'human_stepped_in');
  });

  it('an assignment during the hold ends it too', async () => {
    const { s, deliveryId } = await scheduled();
    await owner()
      .insert(schema.ticketEvent)
      .values({
        ticketId: s.ticketId,
        type: 'ticket.assigned',
        actorType: 'user',
        actorId: headId,
        createdAt: new Date(T0.getTime() + 5_000),
      });
    expect(await dispatcherFor(gateOn).dispatch(deliveryId)).toEqual({
      status: 'denied',
      reason: 'human_stepped_in',
    });
    await expectHeld(s, deliveryId, 'human_stepped_in');
  });

  it('judges the gate again: a kill switch turned on during the hold stops the send', async () => {
    const { s, deliveryId } = await scheduled();
    await testDb.owner.pool.query(`UPDATE ai_switch SET is_on = true WHERE key = 'ai_kill_switch'`);
    try {
      expect(await dispatcherFor(gateOn).dispatch(deliveryId)).toEqual({
        status: 'denied',
        reason: 'kill_switch_on',
      });
    } finally {
      await testDb.owner.pool.query(
        `UPDATE ai_switch SET is_on = false WHERE key = 'ai_kill_switch'`,
      );
    }
    await expectHeld(s, deliveryId, 'kill_switch_on');
  });

  it('judges the gate again: a rollback to stage 2 during the hold stops the send', async () => {
    const { s, deliveryId } = await scheduled();
    await database.db.transaction((tx) =>
      gateOn.autonomy.rollbackIntent(tx, gateOn.context({ actor: { type: 'system', id: null } }), {
        intentId: s.intentId,
        reason: 'test rollback',
      }),
    );
    expect(await dispatcherFor(gateOn).dispatch(deliveryId)).toEqual({
      status: 'denied',
      reason: 'stage_below_3',
    });
    await expectHeld(s, deliveryId, 'stage_below_3');
  });

  it('a person can still undo it during the hold (the draft goes back to waiting)', async () => {
    const s = await scenario({ stage: 3 });
    expect(await step(s)).toBe('scheduled');
    const [delivery] = await deliveriesOf(s.ticketId);
    await database.db.transaction((tx) =>
      gateOn.outbound.cancel(tx, gateOn.context({ actor: { type: 'user', id: headId } }), {
        ref: s.ticketId,
        deliveryId: delivery?.id ?? '',
        canCancelAny: true,
      }),
    );
    expect((await draftRow(s.draftId))?.status).toBe('draft');
    expect((await deliveriesOf(s.ticketId))[0]?.state).toBe('cancelled');
  });
});

describe('the pre-send grade is bound to the exact text', () => {
  it('a changed text, an old grade or a grade of another draft clears nothing', async () => {
    const s = await scenario({ stage: 3 });
    const text = composeAutoSendText(s.body, undefined, 'en');
    const base = {
      aiDraftId: s.draftId,
      ticketId: s.ticketId,
      graderAiRunId: null,
      graderProvider: 'anthropic',
      graderModel: 'grader-fixture',
      drafterProvider: 'anthropic',
      drafterModel: 'drafter-fixture',
      score: 0.95,
      passed: true,
      violations: [],
      promptVersion: 1,
      mock: false,
    };
    const gradeId = await recordPreSendGrade(database.db, { ...base, text });
    const ctx = gateOn.context({ actor: { type: 'ai', id: null } });
    const ask = (aiGradeId: string, asked: string, aiDraftId = s.draftId) =>
      ctx.policyGate?.evaluateAutoSend?.(
        {
          ticketId: s.ticketId,
          channel: 'gmail',
          intentId: s.intentId,
          actor: { type: 'ai', id: null },
          origin: 'ai_auto',
          autoSend: { aiDraftId, aiGradeId, text: asked, attachmentCount: 0, hasHtml: false },
        },
        'live',
      );
    expect((await ask(gradeId, text))?.failed).toEqual([]);
    expect((await ask(gradeId, `${text} Also, a refund is on its way.`))?.failed).toEqual([
      'grade_hash_mismatch',
    ]);
    // A grade that belongs to another draft is no grade.
    const other = await scenario({ stage: 3 });
    expect((await ask(gradeId, text, other.draftId))?.failed).toContain('grade_missing');
    // A grader that is the drafter, or a mock grade, never clears.
    const same = await recordPreSendGrade(database.db, {
      ...base,
      text,
      graderModel: 'drafter-fixture',
    });
    expect((await ask(same, text))?.failed).toEqual(['grader_not_independent']);
    const mock = await recordPreSendGrade(database.db, { ...base, text, mock: true });
    expect((await ask(mock, text))?.failed).toEqual(['grade_mock']);
  });
});
