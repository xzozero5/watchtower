import { randomBytes, randomUUID } from 'node:crypto';

import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import {
  createDomain,
  createPolicyGate,
  generateGateReport,
  readGateReports,
  type Domain,
} from '@watchtower/domain';
import { AUDIT_ACTIONS } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import { runAutonomyWatch, runWeeklyReports } from './index.js';

// T-304e/f (ADR-025 sections 6 and 7): the rollback rules of the owner's decision 4 and the gate report, over
// a real Postgres. Rows that a send would normally make are inserted with the triggers off (a superuser
// session in replica mode): what is tested is the rules that read them, not how they got there.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const net = disableNetConnect();

let testDb: TestDatabase;
let database: Database;
let domain: Domain;
let headId = '';
let ownerPersonId = '';
let gmailId = '';
let orgId = '';
let seedOrgId = '';
let seedBatchId = '';
let contactId = '';
const published: unknown[] = [];
const logger = createLogger(testConfig());
const owner = () => testDb.owner.db;
const sink = { publish: (event: unknown) => (published.push(event), Promise.resolve()) };
const deps = () => ({ database, domain, realtime: sink as never, logger });

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  database = createDatabase({ url: testDb.appUrl, max: 6, applicationName: 'wt-watch-test' });
  domain = createDomain({
    ticketKeyPrefix: 'OPS',
    sealKey: randomBytes(32),
    autosendEnabled: true,
    policyGate: createPolicyGate({ db: database.db, autosendEnabled: true }),
  });
  await testDb.owner.pool.query(`UPDATE ai_switch SET is_on = false`);
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
  const [mailbox] = await owner()
    .insert(schema.channelAccount)
    .values({ type: 'gmail', name: 'Support mailbox' })
    .returning();
  gmailId = mailbox?.id ?? '';
  const [org] = await owner()
    .insert(schema.organization)
    .values({ name: 'Customer Co' })
    .returning();
  orgId = org?.id ?? '';
  const batch = await testDb.owner.pool.query<{ id: string }>(
    `INSERT INTO seed_batch (kind, note) VALUES ('demo', 'test') RETURNING id`,
  );
  seedBatchId = batch.rows[0]?.id ?? '';
  const [seedOrg] = await owner()
    .insert(schema.organization)
    .values({ name: 'Seed Co', seedBatchId })
    .returning();
  seedOrgId = seedOrg?.id ?? '';
  const [contact] = await owner()
    .insert(schema.contact)
    .values({
      orgId,
      name: 'Somchai',
      emails: [`${randomUUID()}@customer.example.test`],
      verifiedAt: new Date(),
    })
    .returning();
  contactId = contact?.id ?? '';
});

afterAll(async () => {
  await database.close();
  await testDb.cleanup();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

/** Runs statements with every trigger off, as a superuser session. Test data only. */
async function untriggered(
  work: (query: (sql: string, params?: unknown[]) => Promise<unknown>) => Promise<void>,
) {
  const client = await testDb.owner.pool.connect();
  try {
    await client.query('SET session_replication_role = replica');
    await work((sql, params) => client.query(sql, params));
  } finally {
    await client.query('SET session_replication_role = DEFAULT');
    client.release();
  }
}

async function stage3Intent(): Promise<{ id: string; key: string }> {
  const key = `intent_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
  const [intent] = await owner()
    .insert(schema.intent)
    // Old enough for a 30 day report window (a window cannot start before the intent, migration 0108).
    .values({
      key,
      name: 'Reset a password',
      autonomyStage: 2,
      createdAt: new Date(Date.now() - 90 * 86_400_000),
    })
    .returning();
  const id = intent?.id ?? '';
  const [report] = await owner()
    .insert(schema.autonomyGateReport)
    .values({
      intentId: id,
      status: 'green',
      triggerKind: 'on_demand',
      windowStart: new Date(Date.now() - 30 * 86_400_000),
      windowEnd: new Date(),
    })
    .returning({ id: schema.autonomyGateReport.id });
  const requested = await database.db.transaction((tx) =>
    domain.autonomy.requestPromotion(tx, domain.context({ actor: { type: 'user', id: headId } }), {
      intentId: id,
      gateReportId: report?.id ?? '',
      reason: 'the numbers are good',
    }),
  );
  const ctx = domain.context({ actor: { type: 'user', id: ownerPersonId } });
  await database.db.transaction((tx) =>
    domain.autonomy.decidePromotion(tx, ctx, {
      promotionId: requested.value.promotionId,
      approve: true,
      reason: 'approved',
      reauthAt: new Date(),
      confirmKey: key,
    }),
  );
  await database.db.transaction((tx) =>
    domain.autonomy.applyPromotion(tx, ctx, { promotionId: requested.value.promotionId }),
  );
  return { id, key };
}

async function ticketFor(intentId: string, options: { seed?: boolean; aiHandled?: boolean } = {}) {
  const [ticket] = await owner()
    .insert(schema.ticket)
    .values({
      orgId: options.seed === true ? seedOrgId : orgId,
      subject: 'Cannot sign in',
      requesterContactId: contactId,
      intentId,
      status: 'resolved',
      aiHandled: options.aiHandled ?? true,
      ...(options.seed === true ? { seedBatchId } : {}),
    })
    .returning();
  return ticket?.id ?? '';
}

const hash = () => randomBytes(32).toString('hex');

/** A draft, its pre-send grade and (optionally) an automatic reply that was sent, as a real send would leave them. */
async function autoReply(
  ticketId: string,
  options: { grade?: { passed: boolean; violations?: number }; sent?: boolean } = {},
) {
  const draftId = randomUUID();
  const gradeId = randomUUID();
  const messageId = randomUUID();
  const violations = options.grade?.violations ?? (options.grade?.passed === false ? 1 : 0);
  await untriggered(async (q) => {
    await q(
      `INSERT INTO ai_draft (id, ticket_id, body_text, content_hash, status, auto_approved_at)
       VALUES ($1, $2, 'Reset it on the sign in page.', $3, 'sent', now())`,
      [draftId, ticketId, hash()],
    );
    await q(
      `INSERT INTO ai_grade (id, ai_draft_id, ticket_id, phase, graded_text, content_hash, grader_provider, grader_model,
                             drafter_provider, drafter_model, score, passed, violations, violation_count, prompt_version)
       VALUES ($1, $2, $3, 'pre_send', 'text', $4, 'anthropic', 'opus', 'anthropic', 'sonnet', $5, $6, $7::jsonb, $8, 1)`,
      [
        gradeId,
        draftId,
        ticketId,
        hash(),
        options.grade?.passed === false ? 0.3 : 0.95,
        options.grade?.passed !== false,
        JSON.stringify(Array.from({ length: violations }, () => ({ code: 'other', text: 'x' }))),
        violations,
      ],
    );
    if (options.sent === true) {
      await q(
        `INSERT INTO message (id, ticket_id, channel_account_id, direction, body_text, visibility, delivery_status)
         VALUES ($1, $2, $3, 'outbound', 'Reset it on the sign in page.', 'public', 'delivered')`,
        [messageId, ticketId, gmailId],
      );
      await q(
        `INSERT INTO outbound_delivery (ticket_id, message_id, channel_account_id, channel, origin, ai_draft_id, ai_grade_id,
                                        content_hash, state, hold_seconds, next_attempt_at, sent_at)
         VALUES ($1, $2, $3, 'gmail', 'ai_auto', $4, $5, $6, 'sent', 120, now(), now())`,
        [ticketId, messageId, gmailId, draftId, gradeId, hash()],
      );
    }
  });
  return { draftId, gradeId };
}

async function stageOf(intentId: string): Promise<number> {
  const [row] = await owner()
    .select({ stage: schema.intent.autonomyStage })
    .from(schema.intent)
    .where(eq(schema.intent.id, intentId));
  return row?.stage ?? -1;
}
const rollbacks = (intentId: string) =>
  owner()
    .select()
    .from(schema.intentAutonomyHistory)
    .where(
      and(
        eq(schema.intentAutonomyHistory.intentId, intentId),
        eq(schema.intentAutonomyHistory.change, 'auto_rollback'),
      ),
    );
const notices = (intentKey: string) =>
  owner()
    .select()
    .from(schema.notification)
    .where(eq(schema.notification.kind, 'autonomy.rollback'))
    .then((rows) => rows.filter((row) => (row.data as { intent?: string }).intent === intentKey));

describe('the autonomy watch (ADR-025 section 7)', () => {
  it('leaves a healthy intent at stage 3', async () => {
    const intent = await stage3Intent();
    for (let i = 0; i < 5; i += 1)
      await autoReply(await ticketFor(intent.id), { grade: { passed: true }, sent: true });
    expect(await runAutonomyWatch(deps())).toMatchObject({ rolledBack: [] });
    expect(await stageOf(intent.id)).toBe(3);
    expect(await rollbacks(intent.id)).toHaveLength(0);
  });

  it('rolls back at once on a policy violation in an automatic reply, tells the heads, and is idempotent', async () => {
    const intent = await stage3Intent();
    const ticketId = await ticketFor(intent.id);
    await autoReply(ticketId, { grade: { passed: true }, sent: true });
    await owner()
      .insert(schema.aiResolutionGrade)
      .values({
        ticketId,
        cycle: 0,
        intentKey: intent.key,
        resolutionClass: 'verified',
        policyViolations: [{ code: 'disclosure', text: 'x' }],
        violationCount: 1,
        promptVersion: 1,
      });
    const first = await runAutonomyWatch(deps(), intent.id);
    expect(first.rolledBack).toEqual([{ intent: intent.key, rule: 'violation' }]);
    expect(await stageOf(intent.id)).toBe(2);
    const [row] = await rollbacks(intent.id);
    expect(row).toMatchObject({ fromStage: 3, toStage: 2, changedBy: null });
    expect(row?.evidence).toMatchObject({ rule: 'violation', violations: 1 });
    const audit = await owner()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, AUDIT_ACTIONS.autonomyAutoRollback));
    expect(audit.some((entry) => entry.targetId === intent.id)).toBe(true);
    const told = await notices(intent.key);
    expect(told.length).toBeGreaterThanOrEqual(1);
    expect(
      told.every((notice) => notice.userId === headId || notice.userId === ownerPersonId),
    ).toBe(true);
    expect(told[0]?.data).toEqual({ intent: intent.key, rule: 'violation' });
    // Again: nothing more is written.
    expect((await runAutonomyWatch(deps(), intent.id)).checked).toBe(0);
    expect(await rollbacks(intent.id)).toHaveLength(1);
    expect(await notices(intent.key)).toHaveLength(told.length);
  });

  it('does not count seed data: the same violation on a seed ticket changes nothing', async () => {
    const intent = await stage3Intent();
    const ticketId = await ticketFor(intent.id, { seed: true });
    await autoReply(ticketId, { grade: { passed: false }, sent: true });
    await owner()
      .insert(schema.aiResolutionGrade)
      .values({
        ticketId,
        cycle: 0,
        intentKey: intent.key,
        resolutionClass: 'assumed',
        policyViolations: [{ code: 'promise', text: 'x' }],
        violationCount: 1,
        promptVersion: 1,
      });
    expect(await runAutonomyWatch(deps(), intent.id)).toMatchObject({ rolledBack: [] });
    expect(await stageOf(intent.id)).toBe(3);
  });

  it('rolls back when 2 of the last 20 automatic replies were reopened or rated 2 or less', async () => {
    const intent = await stage3Intent();
    const one = await ticketFor(intent.id);
    const two = await ticketFor(intent.id);
    await autoReply(one, { sent: true });
    await autoReply(two, { sent: true });
    for (let i = 0; i < 3; i += 1) await autoReply(await ticketFor(intent.id), { sent: true });
    // One reopen alone is not enough.
    await owner()
      .insert(schema.ticketEvent)
      .values({
        ticketId: one,
        type: 'ticket.reopened',
        actorType: 'user',
        createdAt: new Date(Date.now() + 5000),
      });
    expect(await runAutonomyWatch(deps(), intent.id)).toMatchObject({ rolledBack: [] });
    expect(await stageOf(intent.id)).toBe(3);
    // A CSAT of 2 on another one makes two.
    await owner()
      .insert(schema.csatSurvey)
      .values({
        ticketId: two,
        contactId,
        orgId,
        status: 'answered',
        sendAfter: new Date(),
        sentAt: new Date(),
        tokenExpiresAt: new Date(Date.now() + 86_400_000),
        answeredAt: new Date(),
        score: 2,
      });
    const result = await runAutonomyWatch(deps(), intent.id);
    expect(result.rolledBack).toEqual([{ intent: intent.key, rule: 'reopen_or_csat' }]);
    expect(await stageOf(intent.id)).toBe(2);
  });

  it('a CSAT of 3 is not a reason', async () => {
    const intent = await stage3Intent();
    for (let i = 0; i < 3; i += 1) {
      const ticketId = await ticketFor(intent.id);
      await autoReply(ticketId, { sent: true });
      await owner()
        .insert(schema.csatSurvey)
        .values({
          ticketId,
          contactId,
          orgId,
          status: 'answered',
          sendAfter: new Date(),
          sentAt: new Date(),
          tokenExpiresAt: new Date(Date.now() + 86_400_000),
          answeredAt: new Date(),
          score: 3,
        });
    }
    expect(await runAutonomyWatch(deps(), intent.id)).toMatchObject({ rolledBack: [] });
  });

  it('rolls back when 3 of the last 20 pre-send grades did not pass', async () => {
    const intent = await stage3Intent();
    for (let i = 0; i < 2; i += 1)
      await autoReply(await ticketFor(intent.id), { grade: { passed: false } });
    for (let i = 0; i < 4; i += 1)
      await autoReply(await ticketFor(intent.id), { grade: { passed: true } });
    expect(await runAutonomyWatch(deps(), intent.id)).toMatchObject({ rolledBack: [] });
    await autoReply(await ticketFor(intent.id), { grade: { passed: false } });
    expect((await runAutonomyWatch(deps(), intent.id)).rolledBack).toEqual([
      { intent: intent.key, rule: 'pre_send_fail' },
    ]);
    expect(await stageOf(intent.id)).toBe(2);
  });

  it('rolls back when the latest gate report since the promotion is red', async () => {
    const intent = await stage3Intent();
    await owner()
      .insert(schema.autonomyGateReport)
      .values({
        intentId: intent.id,
        status: 'red',
        triggerKind: 'weekly',
        windowStart: new Date(Date.now() - 7 * 86_400_000),
        windowEnd: new Date(),
      });
    expect((await runAutonomyWatch(deps(), intent.id)).rolledBack).toEqual([
      { intent: intent.key, rule: 'gate_red' },
    ]);
  });

  it('only ever lowers a stage: an intent at stage 2 is not looked at', async () => {
    const [intent] = await owner()
      .insert(schema.intent)
      .values({ key: `i_${randomUUID().slice(0, 8)}`, name: 'x', autonomyStage: 2 })
      .returning();
    expect(await runAutonomyWatch(deps(), intent?.id)).toMatchObject({
      checked: 0,
      rolledBack: [],
    });
  });
});

describe('the gate report (ADR-025 section 6)', () => {
  it('is insufficient_data for an intent with too little history, and never green', async () => {
    const [intent] = await owner()
      .insert(schema.intent)
      .values({ key: `i_${randomUUID().slice(0, 8)}`, name: 'x', autonomyStage: 2 })
      .returning();
    const made = await generateGateReport(
      database.db,
      domain.context({ actor: { type: 'user', id: headId } }),
      {
        intentId: intent?.id ?? '',
        trigger: 'on_demand',
        generatedBy: headId,
      },
    );
    expect(made.status).toBe('insufficient_data');
    const [report] = await readGateReports(database.db, intent?.id ?? '');
    expect(report).toMatchObject({
      status: 'insufficient_data',
      seedExcluded: true,
      triggerKind: 'on_demand',
    });
    expect(
      report?.criteria.find((criterion) => criterion.key === 'days_at_stage_2')?.pass,
    ).toBeNull();
    expect(report?.criteria.map((criterion) => criterion.key)).toEqual(
      expect.arrayContaining([
        'verified_resolution',
        'reopen_rate',
        'csat_parity',
        'shadow_precision',
        'eval_replay_violations',
      ]),
    );
  });

  it('counts only real tickets: seed tickets are left out of every number', async () => {
    const [intent] = await owner()
      .insert(schema.intent)
      .values({ key: `i_${randomUUID().slice(0, 8)}`, name: 'x', autonomyStage: 2 })
      .returning();
    const intentId = intent?.id ?? '';
    for (const seed of [true, true, false]) {
      const ticketId = await ticketFor(intentId, { seed, aiHandled: false });
      await owner()
        .insert(schema.aiResolutionGrade)
        .values({ ticketId, cycle: 0, resolutionClass: 'verified', promptVersion: 1 });
    }
    await generateGateReport(database.db, domain.context({ actor: { type: 'user', id: headId } }), {
      intentId,
      trigger: 'on_demand',
      generatedBy: headId,
    });
    const [report] = await readGateReports(database.db, intentId);
    expect(report?.metrics).toMatchObject({ human: { graded: 1, verified: 1 }, ai: { graded: 0 } });
  });

  it('the weekly run writes a report for each intent at stage 2 or 3 and then watches', async () => {
    const before = await owner()
      .select()
      .from(schema.autonomyGateReport)
      .orderBy(desc(schema.autonomyGateReport.generatedAt));
    const result = await runWeeklyReports(deps());
    expect(result.reports).toBeGreaterThan(0);
    const after = await owner().select().from(schema.autonomyGateReport);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.some((report) => report.triggerKind === 'weekly')).toBe(true);
  });
});
