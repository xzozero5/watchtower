import {
  DevMockLlmProvider,
  ProviderError,
  type LlmProvider,
  type LlmRequest,
} from '@watchtower/ai';
import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { hasResolutionGrade, intentGradeMetrics } from '@watchtower/domain';
import { disableNetConnect } from '@watchtower/shared/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../logger.js';
import { testConfig } from '../testing/support.js';
import { runGrader } from './grade-job.js';
import { createAiRuntime, type AiRuntime } from './runtime.js';

// T-301: the grader job on the offline mock, with Postgres (restricted application role). It measures
// only: the test also checks that no message and no delivery was made.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';
const net = disableNetConnect();

let testDb: TestDatabase;
let database: Database;
let runtime: AiRuntime;
let orgId = '';
let contactId = '';
let userId = '';
const requests: LlmRequest[] = [];
let offline = false;

const logger = createLogger(testConfig());
const owner = () => testDb.owner.db;

function provider(): LlmProvider {
  const inner = new DevMockLlmProvider();
  return {
    kind: 'mock',
    generate(request) {
      requests.push(request);
      if (offline) return Promise.reject(new ProviderError('claude-cli', 'offline', 503, true));
      return inner.generate(request);
    },
  };
}

const deps = () => ({ database, ai: runtime, logger, ticketKeyPrefix: 'OPS' });

interface Made {
  ticketId: string;
  finalMessageId: string;
}

async function resolvedTicket(
  options: {
    subject?: string;
    intentKey?: string;
    reply?: string;
    draft?: string;
    csat?: { score: number; resolved: boolean };
    status?: string;
    kbCitation?: boolean;
  } = {},
): Promise<Made> {
  const [intent] = await owner()
    .select({ id: schema.intent.id })
    .from(schema.intent)
    .where(eq(schema.intent.key, options.intentKey ?? 'reset_password'))
    .limit(1);
  const [ticket] = await owner()
    .insert(schema.ticket)
    .values({
      orgId,
      subject: options.subject ?? 'Cannot sign in',
      requesterContactId: contactId,
      intentId: intent?.id ?? null,
      status: options.status ?? 'resolved',
    })
    .returning();
  const ticketId = ticket?.id ?? '';
  await owner().insert(schema.message).values({
    ticketId,
    direction: 'inbound',
    senderContactId: contactId,
    bodyText: 'I cannot sign in. Mail me at somchai@customer.example.test',
    visibility: 'public',
  });
  const [reply] = await owner()
    .insert(schema.message)
    .values({
      ticketId,
      direction: 'outbound',
      senderUserId: userId,
      bodyText: options.reply ?? 'Please reset your password with the link on the sign in page.',
      visibility: 'public',
    })
    .returning();
  const finalMessageId = reply?.id ?? '';
  if (options.draft !== undefined) {
    await owner()
      .insert(schema.aiDraft)
      .values({
        ticketId,
        bodyText: options.draft,
        status: 'sent',
        approvedBy: userId,
        approvedAt: new Date(),
        disposition: 'edited',
        editDistance: 0.2,
        finalMessageId,
        resolvedAt: new Date(),
        citations:
          options.kbCitation === true ? [{ evidenceId: 'ev-1', sentence: 0, kind: 'kb' }] : [],
      });
  }
  if (options.csat !== undefined) {
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
        score: options.csat.score,
        resolved: options.csat.resolved,
      });
  }
  return { ticketId, finalMessageId };
}

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  database = createDatabase({ url: testDb.appUrl, max: 4, applicationName: 'wt-grade-test' });
  runtime = createAiRuntime(testConfig(), database, logger, { providers: { mock: provider() } });
  const [org] = await owner()
    .insert(schema.organization)
    .values({ name: 'Example Org' })
    .returning();
  orgId = org?.id ?? '';
  const [contact] = await owner()
    .insert(schema.contact)
    .values({ orgId, name: 'Somchai Jaidee', emails: ['somchai@customer.example.test'] })
    .returning();
  contactId = contact?.id ?? '';
  const [user] = await owner()
    .insert(schema.users)
    .values({ email: 'agent@example.test', name: 'Agent One', role: 'agent' })
    .returning();
  userId = user?.id ?? '';
  await owner()
    .insert(schema.intent)
    .values([
      { key: 'reset_password', name: 'Reset password', autonomyStage: 2 },
      { key: 'billing_question', name: 'Billing question', autonomyStage: 2 },
    ]);
});
afterAll(async () => {
  await testDb.cleanup();
  net.restore();
});
beforeEach(() => {
  requests.length = 0;
  offline = false;
});

describe('runGrader', () => {
  it('grades a resolved ticket: verified by the survey, the draft compared, nothing sent', async () => {
    const made = await resolvedTicket({
      draft: 'Please reset your password with the link on the sign in page.',
      csat: { score: 5, resolved: true },
    });
    const result = await runGrader(deps(), { ticketId: made.ticketId, reopenCount: 0 });
    expect(result).toEqual({ status: 'graded' });

    const [row] = await owner()
      .select()
      .from(schema.aiResolutionGrade)
      .where(eq(schema.aiResolutionGrade.ticketId, made.ticketId));
    expect(row).toMatchObject({
      resolutionClass: 'verified',
      draftVerdict: 'matches',
      intentKey: 'reset_password',
      csatScore: 5,
      csatResolved: true,
      cycle: 0,
      mock: true,
      promptVersion: 1,
    });
    expect(row?.draftQuality).toBe(1);
    const reasoning = row?.reasoning as
      readonly { uncited: boolean; evidence: unknown }[] | undefined;
    expect(reasoning).toHaveLength(1);
    expect(reasoning?.[0]?.uncited).toBe(false);
    expect(Array.isArray(reasoning?.[0]?.evidence)).toBe(true);

    // N4: the address never reached the model; the audit row exists and points at the grade.
    const sent = requests.map((r) => r.messages.map((m) => m.content).join('')).join('');
    expect(sent).not.toContain('somchai@customer.example.test');
    const runs = await owner()
      .select({ id: schema.aiRun.id, agent: schema.aiRun.agent, promptId: schema.aiRun.promptId })
      .from(schema.aiRun)
      .where(eq(schema.aiRun.ticketId, made.ticketId));
    expect(runs).toEqual([expect.objectContaining({ agent: 'grader', promptId: 'grader' })]);
    expect(row?.aiRunId).toBe(runs[0]?.id);

    // A measurement only (N3): no new message, no delivery.
    const messages = await owner()
      .select({ id: schema.message.id })
      .from(schema.message)
      .where(eq(schema.message.ticketId, made.ticketId));
    expect(messages).toHaveLength(2);
    expect(await owner().select().from(schema.outboundDelivery)).toHaveLength(0);
  });

  it('is idempotent: a second job for the same resolution costs no model call', async () => {
    const made = await resolvedTicket({ subject: 'Again' });
    expect(await runGrader(deps(), { ticketId: made.ticketId, reopenCount: 0 })).toEqual({
      status: 'graded',
    });
    const calls = requests.length;
    expect(await runGrader(deps(), { ticketId: made.ticketId, reopenCount: 0 })).toEqual({
      status: 'skipped',
      reason: 'already_graded',
    });
    expect(requests).toHaveLength(calls);
    expect(await hasResolutionGrade(owner(), made.ticketId, 0)).toBe(true);
    const [row] = await owner()
      .select()
      .from(schema.aiResolutionGrade)
      .where(eq(schema.aiResolutionGrade.ticketId, made.ticketId));
    // Staff replied and nobody confirmed: contained, and the draft-less ticket has no quality.
    expect(row).toMatchObject({ resolutionClass: 'contained', draftVerdict: 'no_draft' });
    expect(row?.draftQuality).toBeNull();
  });

  it('does nothing for a ticket that is not resolved, was reopened, or is gone', async () => {
    const open = await resolvedTicket({ status: 'open' });
    expect(await runGrader(deps(), { ticketId: open.ticketId, reopenCount: 0 })).toEqual({
      status: 'skipped',
      reason: 'not_resolved',
    });
    const resolved = await resolvedTicket();
    expect(await runGrader(deps(), { ticketId: resolved.ticketId, reopenCount: 3 })).toEqual({
      status: 'skipped',
      reason: 'reopened',
    });
    expect(
      await runGrader(deps(), {
        ticketId: '00000000-0000-4000-8000-000000000001',
        reopenCount: 0,
      }),
    ).toEqual({ status: 'missing' });
    expect(requests).toHaveLength(0);
  });

  it('grades the next resolution of a reopened ticket separately', async () => {
    const made = await resolvedTicket({ subject: 'Reopened' });
    await runGrader(deps(), { ticketId: made.ticketId, reopenCount: 0 });
    await owner()
      .update(schema.ticket)
      .set({ reopenCount: 1 })
      .where(eq(schema.ticket.id, made.ticketId));
    expect(await runGrader(deps(), { ticketId: made.ticketId, reopenCount: 1 })).toEqual({
      status: 'graded',
    });
    const rows = await owner()
      .select({ cycle: schema.aiResolutionGrade.cycle })
      .from(schema.aiResolutionGrade)
      .where(eq(schema.aiResolutionGrade.ticketId, made.ticketId));
    expect(rows.map((r) => r.cycle).toSorted()).toEqual([0, 1]);
  });

  it('re-grades once when the CSAT answer arrives after the grade (T-301e)', async () => {
    const made = await resolvedTicket({ subject: 'Late answer' });
    expect(await runGrader(deps(), { ticketId: made.ticketId, reopenCount: 0 })).toEqual({
      status: 'graded',
    });
    const first = await owner()
      .select()
      .from(schema.aiResolutionGrade)
      .where(eq(schema.aiResolutionGrade.ticketId, made.ticketId));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ csatScore: null, version: 1, regradedAt: null });

    // The answer job before any answer exists does nothing and costs no model call.
    const calls = requests.length;
    expect(
      await runGrader(deps(), { ticketId: made.ticketId, reopenCount: 0, afterCsat: true }),
    ).toEqual({ status: 'skipped', reason: 'no_csat_answer' });
    expect(requests).toHaveLength(calls);
    // A plain job still stops at the grade it finds.
    expect(await runGrader(deps(), { ticketId: made.ticketId, reopenCount: 0 })).toEqual({
      status: 'skipped',
      reason: 'already_graded',
    });

    await owner()
      .insert(schema.csatSurvey)
      .values({
        ticketId: made.ticketId,
        contactId,
        orgId,
        status: 'answered',
        sendAfter: new Date(),
        sentAt: new Date(),
        tokenExpiresAt: new Date(Date.now() + 86_400_000),
        answeredAt: new Date(),
        score: 5,
        resolved: true,
      });
    expect(
      await runGrader(deps(), { ticketId: made.ticketId, reopenCount: 0, afterCsat: true }),
    ).toEqual({ status: 'graded' });
    const rows = await owner()
      .select()
      .from(schema.aiResolutionGrade)
      .where(eq(schema.aiResolutionGrade.ticketId, made.ticketId));
    // Still one row for the resolution (metrics count it once), now version 2 with the answer in it.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ csatScore: 5, csatResolved: true, version: 2 });
    expect(rows[0]?.regradedAt).toBeInstanceOf(Date);
    expect(rows[0]?.resolutionClass).toBe('verified');
    // The job sent twice (a retry, a double answer) changes nothing and costs nothing.
    const after = requests.length;
    expect(
      await runGrader(deps(), { ticketId: made.ticketId, reopenCount: 0, afterCsat: true }),
    ).toEqual({ status: 'skipped', reason: 'already_graded' });
    expect(requests).toHaveLength(after);
  });

  it('waits when the AI host is offline and writes nothing', async () => {
    const made = await resolvedTicket({ subject: 'Offline' });
    offline = true;
    expect(await runGrader(deps(), { ticketId: made.ticketId, reopenCount: 0 })).toEqual({
      status: 'failed',
      reason: 'provider_offline',
    });
    expect(await hasResolutionGrade(owner(), made.ticketId, 0)).toBe(false);
  });

  it('skips without a model call when no AI runtime is set up', async () => {
    const made = await resolvedTicket({ subject: 'No runtime' });
    expect(
      await runGrader({ ...deps(), ai: undefined }, { ticketId: made.ticketId, reopenCount: 0 }),
    ).toEqual({ status: 'skipped', reason: 'provider_unavailable' });
  });
});

describe('intentGradeMetrics', () => {
  it('counts classes, draft quality, reopens, survey scores and acted-on drafts per intent', async () => {
    const billing = await resolvedTicket({
      intentKey: 'billing_question',
      subject: 'Invoice',
      reply: 'Your invoice is attached to the billing page.',
      draft: 'Something else entirely about unrelated matters here.',
      csat: { score: 2, resolved: false },
    });
    await runGrader(deps(), { ticketId: billing.ticketId, reopenCount: 0 });
    await owner()
      .update(schema.ticket)
      .set({ reopenCount: 1 })
      .where(eq(schema.ticket.id, billing.ticketId));

    const metrics = await intentGradeMetrics(owner(), {
      from: new Date(Date.now() - 3_600_000),
      to: new Date(Date.now() + 3_600_000),
    });
    const bill = metrics.find((m) => m.intentKey === 'billing_question');
    expect(bill).toMatchObject({
      graded: 1,
      assumed: 1,
      verified: 0,
      assumedRate: 1,
      draftsCompared: 1,
      reopened: 1,
      reopenRate: 1,
      csatAnswered: 1,
      csatAvg: 2,
      draftsEdited: 1,
      mock: true,
    });
    expect(bill?.avgDraftQuality).toBeLessThan(0.25);
    const reset = metrics.find((m) => m.intentKey === 'reset_password');
    expect(reset?.graded).toBeGreaterThanOrEqual(3);
    expect(reset?.verified).toBeGreaterThanOrEqual(1);
    expect(reset?.verifiedRate).toBeGreaterThan(0);

    const none = await intentGradeMetrics(owner(), {
      from: new Date(Date.now() + 3_600_000),
      to: new Date(Date.now() + 7_200_000),
    });
    expect(none).toEqual([]);
  });
});
