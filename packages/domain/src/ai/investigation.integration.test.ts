import { randomBytes, randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import { AI_TOOL_BUDGETS, AUDIT_ACTIONS, type RejectAiDraft } from '@watchtower/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DomainError } from '../errors.js';
import {
  addOrg,
  addStaff,
  auditRows,
  startDomainTest,
  type DomainTestEnv,
} from '../testing/support.js';
import { rejectAiDraft, saveAiDraft } from './drafts.js';
import { upsertAiInsight, writeAiInvestigation } from './insight.js';
import { createAiKbDraft, ticketKbGap } from './kb-draft.js';
import { createDbToolLedger, type ToolLedgerEntry } from './tool-ledger.js';

let env: DomainTestEnv;
let agent: Awaited<ReturnType<typeof addStaff>>;
let other: Awaited<ReturnType<typeof addStaff>>;
let approver: Awaited<ReturnType<typeof addStaff>>;
let orgId: string;

beforeAll(async () => {
  env = await startDomainTest();
  agent = await addStaff(env, 'agent');
  other = await addStaff(env, 'agent');
  approver = await addStaff(env, 'lead');
  orgId = (await addOrg(env)).id;
});
afterAll(async () => {
  await env.close();
});

const owner = () => env.db.owner.db;

async function newTicket(subject = 'Webhook not received'): Promise<string> {
  const created = await env.tx((tx) =>
    env.domain.tickets.create(tx, env.ctx(agent.actor), {
      orgId,
      subject,
      body: 'body',
      requester: { email: `${randomUUID()}@example.test`, name: 'Pat' },
    }),
  );
  return created.value.ticket.id;
}

function entry(ticketId: string | null, overrides: Partial<ToolLedgerEntry> = {}): ToolLedgerEntry {
  return {
    runKey: randomUUID(),
    ticketId,
    agent: 'investigator',
    tool: 'kb_search',
    intent: null,
    stage: 2,
    inputHash: randomBytes(32).toString('hex'),
    mock: false,
    ...overrides,
  };
}

describe('the tool ledger in the database (T-108a, N2)', () => {
  const ledger = () => createDbToolLedger({ db: env.database.db, limits: AI_TOOL_BUDGETS });

  it('counts a run, a ticket and a tool from the rows, outside any handle', async () => {
    const ticketId = await newTicket();
    const runKey = randomUUID();
    for (let index = 0; index < AI_TOOL_BUDGETS.perRun; index += 1) {
      const decision = await ledger().begin(entry(ticketId, { runKey, tool: `tool_${String(index)}` }));
      expect(decision.allowed).toBe(true);
    }
    // A new ledger object (a new "handle") for the same run gets no new budget.
    const refused = await ledger().begin(entry(ticketId, { runKey }));
    expect(refused).toEqual({ allowed: false, reason: 'run_budget' });
    const rows = await owner().select().from(schema.toolExecution).where(eq(schema.toolExecution.runKey, runKey));
    expect(rows.filter((row) => row.status === 'denied')).toHaveLength(1);
    expect(rows.find((row) => row.status === 'denied')?.errorCode).toBe('run_budget');
  });

  it('caps a ticket over several runs, and a tool over several tickets', async () => {
    const ticketId = await newTicket();
    let used = 0;
    let decision;
    do {
      decision = await ledger().begin(entry(ticketId, { tool: `t_${String(used)}` }));
      used += 1;
    } while (decision.allowed);
    expect(decision).toEqual({ allowed: false, reason: 'ticket_budget' });
    expect(used - 1).toBe(AI_TOOL_BUDGETS.perTicketPerHour);

    // One tool, many tickets: the shared bucket.
    let calls = 0;
    let last;
    do {
      last = await ledger().begin(entry(await newTicket(), { tool: 'gcp_logs' }));
      calls += 1;
    } while (last.allowed);
    expect(last).toEqual({ allowed: false, reason: 'tool_rate' });
    expect(calls - 1).toBe(AI_TOOL_BUDGETS.perToolPerMinute);
  });

  it('does not let two parallel jobs both take the last slot of a ticket', async () => {
    const ticketId = await newTicket();
    const tight = createDbToolLedger({
      db: env.database.db,
      limits: { perRun: 100, perTicketPerHour: 3, perToolPerMinute: 100 },
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => tight.begin(entry(ticketId, { tool: `p_${String(index)}` }))),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(3);
  });

  it('finishes a call once, keeps only a class name for the error and never the content', async () => {
    const ticketId = await newTicket();
    const decision = await ledger().begin(entry(ticketId));
    if (!decision.allowed) throw new Error('expected allowed');
    await ledger().finish(decision.id, {
      status: 'error',
      errorCode: 'TypeError: secret detail for jane@example.com',
      latencyMs: 12.7,
      resultCount: null,
    });
    // A second finish does not rewrite the row.
    await ledger().finish(decision.id, { status: 'ok', errorCode: null, latencyMs: 1, resultCount: 9 });
    const [row] = await owner().select().from(schema.toolExecution).where(eq(schema.toolExecution.id, decision.id));
    expect(row).toMatchObject({ status: 'error', latencyMs: 12, resultCount: null });
    expect(row?.errorCode).not.toMatch(/[ @.:]/);
    expect(row?.finishedAt).not.toBeNull();
    await ledger().deny(entry(ticketId, { tool: 'gcp_logs' }), 'not_allowed');
    const denied = (await owner().select().from(schema.toolExecution).where(eq(schema.toolExecution.ticketId, ticketId))).find((r) => r.tool === 'gcp_logs');
    expect(denied).toMatchObject({ status: 'denied', errorCode: 'not_allowed' });
  });
});

describe('rejecting a draft (T-108c)', () => {
  async function draftFor(ticketId: string): Promise<string> {
    const saved = await saveAiDraft(env.database.db, {
      ticketId,
      body: 'Hello. Please check the endpoint.',
      aiRunId: null,
      language: 'en',
      customerLanguage: 'en',
      citations: [{ evidenceId: 'ev-1', sentence: 1, kind: 'kb' }],
      uncitedClaims: 1,
      promptId: 'drafter',
      promptVersion: 1,
      disclosureLevel: 'restricted',
      disclosureRemoved: 2,
      needsReview: false,
      requestedBy: null,
    });
    await writeAiInvestigation(env.database.db, {
      ticketId,
      state: 'draft_ready',
      stage: 2,
      generatedAt: new Date(),
      draftId: saved.id,
      nextStep: { kind: 'approve_draft', label: 'Review the draft reply' },
    });
    return saved.id;
  }

  const reject = (ticketId: string, draftId: string, rejection: RejectAiDraft, by = agent) =>
    env.tx((tx) => rejectAiDraft(tx, env.ctx(by.actor), { ref: ticketId, draftId, rejection }));

  it('stores the reason and the comment, retires the draft and sends the brief back to the person', async () => {
    const ticketId = await newTicket();
    const draftId = await draftFor(ticketId);
    const result = await reject(ticketId, draftId, { reason: 'tone_style', comment: 'too formal' });
    expect(result.value.draftId).toBe(draftId);
    expect(result.events.map((event) => event.type)).toEqual(['ticket.updated']);
    expect(result.audited).toBe(true);
    const [draft] = await owner().select().from(schema.aiDraft).where(eq(schema.aiDraft.id, draftId));
    expect(draft).toMatchObject({
      status: 'rejected',
      disposition: 'rejected',
      rejectReason: 'tone_style',
      rejectComment: 'too formal',
      resolvedBy: agent.id,
    });
    const [insight] = await owner().select().from(schema.aiTicketInsight).where(eq(schema.aiTicketInsight.ticketId, ticketId));
    expect(insight).toMatchObject({ draftId: null, state: 'needs_human', nextStepKind: 'reply' });
    const audit = (await auditRows(env, AUDIT_ACTIONS.aiDraftReject)).filter((row) => row.targetId === ticketId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.metadata).toMatchObject({ aiDraftId: draftId, reason: 'tone_style', hasComment: true });
  });

  it('refuses a second verdict, a draft of another ticket, a missing one and a non-person', async () => {
    const ticketId = await newTicket();
    const draftId = await draftFor(ticketId);
    await reject(ticketId, draftId, { reason: 'other', comment: 'because' });
    await expect(reject(ticketId, draftId, { reason: 'wrong_intent' })).rejects.toMatchObject({ code: 'conflict' });

    const elsewhere = await newTicket();
    const foreign = await draftFor(elsewhere);
    await expect(reject(ticketId, foreign, { reason: 'wrong_intent' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(reject(ticketId, randomUUID(), { reason: 'wrong_intent' })).rejects.toMatchObject({ code: 'not_found' });

    const waiting = await draftFor(await newTicket());
    const tickets = await owner().select({ id: schema.aiDraft.ticketId }).from(schema.aiDraft).where(eq(schema.aiDraft.id, waiting));
    await expect(
      env.tx((tx) =>
        rejectAiDraft(tx, env.ctx({ type: 'ai', id: null }), {
          ref: tickets[0]?.id ?? '',
          draftId: waiting,
          rejection: { reason: 'wrong_intent' },
        }),
      ),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it('keeps one waiting draft per ticket: a new one replaces the old one', async () => {
    const ticketId = await newTicket();
    const first = await draftFor(ticketId);
    const second = await draftFor(ticketId);
    const drafts = await owner().select().from(schema.aiDraft).where(eq(schema.aiDraft.ticketId, ticketId));
    expect(Object.fromEntries(drafts.map((draft) => [draft.id, draft.status]))).toEqual({
      [first]: 'superseded',
      [second]: 'draft',
    });
  });
});

describe('the KB author and who may approve it (T-108e, po decision 27)', () => {
  async function aiArticle(requestedBy: string | null): Promise<{ articleId: string; version: number }> {
    const ticketId = await newTicket('Export empty');
    const ctx = env.ctx({ type: 'ai', id: null }, { onBehalfOf: requestedBy });
    const created = await env.tx((tx) =>
      createAiKbDraft(tx, ctx, {
        ticketId,
        title: 'Export is empty',
        bodyMd: '## Resolution\n\n1. Clear the date filter.',
        intentTags: [],
        kind: 'article',
      }),
    );
    return { articleId: created.value.articleId, version: created.value.version };
  }
  const audience = { visibility: 'internal' as const, orgIds: [] as string[] };
  const publish = (articleId: string, version: number, by: { actor: typeof agent.actor }) =>
    env.tx((tx) => env.domain.kb.publish(tx, env.ctx(by.actor), { articleId, version, audience }));

  it('puts the draft in review, internal, marked as machine text and naming who asked', async () => {
    const { articleId } = await aiArticle(agent.id);
    const [article] = await owner().select().from(schema.kbArticle).where(eq(schema.kbArticle.id, articleId));
    expect(article).toMatchObject({ status: 'in_review', visibility: 'internal', authorId: null, publishedVersionId: null });
    const [version] = await owner().select().from(schema.kbArticleVersion).where(eq(schema.kbArticleVersion.articleId, articleId));
    expect(version).toMatchObject({ authoredByMachine: true, requestedBy: agent.id, createdBy: null });
    const audit = (await auditRows(env, AUDIT_ACTIONS.aiKbDraft)).filter((row) => row.targetId === articleId);
    expect(audit[0]).toMatchObject({ actorType: 'ai', actorId: null });
    expect(audit[0]?.metadata).toMatchObject({ requestedBy: agent.id });
  });

  it('the person who asked for it cannot publish it; somebody else can; nobody can by break-glass', async () => {
    const { articleId, version } = await aiArticle(agent.id);
    await expect(publish(articleId, version, agent)).rejects.toMatchObject({
      code: 'policy_denied',
      details: { reason: 'kb_publisher_requested_ai_text' },
    });
    await expect(
      env.tx((tx) =>
        env.domain.kb.publishBreakGlass(tx, env.ctx(approver.actor), {
          articleId,
          version,
          audience,
          reason: 'urgent',
        }),
      ),
    ).rejects.toMatchObject({ details: { reason: 'kb_break_glass_machine_text' } });
    // The AI itself never publishes.
    await expect(
      env.tx((tx) => env.domain.kb.publish(tx, env.ctx({ type: 'ai', id: null }), { articleId, version, audience })),
    ).rejects.toMatchObject({ details: { reason: 'kb_publisher_not_human' } });
    await publish(articleId, version, approver);
    const [article] = await owner().select().from(schema.kbArticle).where(eq(schema.kbArticle.id, articleId));
    expect(article).toMatchObject({ status: 'published', reviewerId: approver.id });
  });

  it('still applies after a person edits the AI text: the requester is not the second pair of eyes', async () => {
    const { articleId, version } = await aiArticle(agent.id);
    const edited = await env.tx((tx) =>
      env.domain.kb.update(tx, env.ctx(other.actor), {
        articleId,
        patch: { bodyMd: '## Resolution\n\n1. Clear the date filter, then export.', expectedVersion: version },
        canApprove: false,
      }),
    );
    await expect(publish(articleId, edited.value.version, agent)).rejects.toMatchObject({
      details: { reason: 'kb_publisher_requested_ai_text' },
    });
    // The editor wrote part of it, so the editor cannot either (the rule that already existed).
    await expect(publish(articleId, edited.value.version, other)).rejects.toMatchObject({
      details: { reason: 'kb_publisher_is_author' },
    });
    await publish(articleId, edited.value.version, approver);
  });

  it('with nobody named (the system resolved it) there is no one to exclude, but a person still publishes', async () => {
    const { articleId, version } = await aiArticle(null);
    await publish(articleId, version, agent);
  });

  it('finds a gap only for a resolved ticket with an answer, no cited article and no earlier draft', async () => {
    const ticketId = await newTicket('Gap');
    expect(await ticketKbGap(env.database.db, ticketId)).toEqual({ needed: false, reason: 'not_resolved' });
    await env.tx(async (tx) => {
      const ctx = env.ctx(agent.actor);
      await env.domain.tickets.changeStatus(tx, ctx, { ref: ticketId, status: 'resolved' });
    });
    expect(await ticketKbGap(env.database.db, ticketId)).toEqual({ needed: false, reason: 'no_answer' });
    await owner().insert(schema.message).values({
      ticketId,
      direction: 'outbound',
      bodyText: 'Done.',
      visibility: 'public',
      senderUserId: agent.id,
    });
    expect(await ticketKbGap(env.database.db, ticketId)).toEqual({ needed: true });

    await owner().insert(schema.aiDraft).values({
      ticketId,
      bodyText: 'Hello',
      status: 'sent',
      approvedBy: agent.id,
      approvedAt: new Date(),
      disposition: 'approved',
      citations: [{ evidenceId: 'ev-1', sentence: 0, kind: 'ticket' }],
    });
    // A citation to something that is not an article is still a gap.
    expect(await ticketKbGap(env.database.db, ticketId)).toEqual({ needed: true });
    await owner().insert(schema.aiDraft).values({
      ticketId,
      bodyText: 'Hello again',
      status: 'sent',
      approvedBy: agent.id,
      approvedAt: new Date(),
      disposition: 'edited',
      citations: [{ evidenceId: 'ev-2', sentence: 0, kind: 'kb' }],
    });
    expect(await ticketKbGap(env.database.db, ticketId)).toEqual({ needed: false, reason: 'cited_kb' });
  });
});

describe('the brief survives a re-summary (T-106e writer)', () => {
  it('upsertAiInsight leaves the evidence, report and draft alone', async () => {
    const ticketId = await newTicket();
    await writeAiInvestigation(env.database.db, {
      ticketId,
      state: 'classified',
      stage: 2,
      generatedAt: new Date(),
      evidence: [{ id: 'ev-1', kind: 'kb', title: 'T', snippet: 'S', confidence: 0.5 }],
      report: {
        findings: [],
        likelyCause: null,
        confidence: 0.4,
        openQuestions: [],
        tools: [],
        promptVersion: 'v1',
      },
    });
    await upsertAiInsight(env.database.db, {
      ticketId,
      state: 'classified',
      stage: 2,
      generatedAt: new Date(),
      summary: 'New summary',
    });
    const [row] = await owner().select().from(schema.aiTicketInsight).where(eq(schema.aiTicketInsight.ticketId, ticketId));
    expect(row?.summary).toBe('New summary');
    expect(row?.evidence).toHaveLength(1);
    expect(row?.report).not.toBeNull();
  });
});
