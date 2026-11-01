import { AI_TOOL_BUDGETS } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { createAuditedLlm } from '../audited.js';
import type { AiRunRecord, LlmProvider, LlmRequest } from '../contract.js';
import { mockSettings } from '../models.js';
import { loadPromptCatalog } from '../prompt-files.js';
import { DevMockLlmProvider } from '../providers/dev-mock.js';
import { createRedactor } from '../redaction/redactor.js';
import { createMemoryToolLedger, withToolBudget } from '../toolkit/budget.js';
import {
  stubFixturesSchema,
  type KbHit,
  type OrgContext,
  type SimilarTicket,
} from '../toolkit/ports.js';
import { buildAllowList, investigationTools, TOOL_NAMES } from '../toolkit/tools.js';
import { createToolRegistry } from '../tools.js';
import type { AgentDeps } from './common.js';
import { applyDisclosure, composeBody, draftReply, type DraftSentence } from './draft.js';
import type { InvestigationEvidence } from './evidence.js';
import { investigateTicket, planRunbook, type InvestigateInput } from './investigate.js';
import { authorKbDraft } from './kb-author.js';
import type { TicketTurn } from './summarize.js';

const TICKET = '11111111-1111-4111-8111-111111111111';
const HASH_KEY = 'unit-test-hash-key-0123456789abcdef';
const RAW_EMAIL = 'somchai.jaidee@customer.example';
const OTHER_EMAIL = 'other.customer@elsewhere.example';

const KB_HIT: KbHit = {
  articleId: 'a1',
  slug: 'webhook-not-received',
  title: 'Webhook not received',
  section: 'Check the endpoint',
  snippet: 'Make sure the endpoint answers with a success status within ten seconds.',
  score: 0.9,
  kind: 'runbook',
  lang: 'en',
  customerVisible: true,
  isRunbook: true,
  href: '/kb/webhook-not-received',
};
const SIMILAR: SimilarTicket = {
  id: '22222222-2222-4222-8222-222222222222',
  key: 'OPS-7',
  subject: 'Webhook retries',
  intentKey: 'webhook_not_received',
  status: 'resolved',
  snippet: `Contact ${OTHER_EMAIL} saw retries stop.`,
  similarity: 0.7,
  sameOrg: false,
  href: '/tickets/OPS-7',
};
const ORG: OrgContext = {
  orgName: 'Example Org',
  tier: 'standard',
  status: 'active',
  openTickets: 2,
  ticketsLast30Days: 5,
  href: '/orgs/1',
};
const FIXTURES = stubFixturesSchema.parse({
  gcpLogs: [
    {
      keywords: ['webhook'],
      entries: [
        { timestamp: '2026-01-01T00:00:00Z', severity: 'ERROR', service: 'api', message: 'delivery failed' },
      ],
    },
  ],
});

const TURNS: TicketTurn[] = [
  { from: 'customer', text: `Our webhook is not received. Reach me at ${RAW_EMAIL} please.` },
];

interface Rig {
  deps: AgentDeps;
  runs: AiRunRecord[];
  requests: LlmRequest[];
  input: (overrides?: Partial<InvestigateInput>) => InvestigateInput;
  guardCalls: string[];
}

function rig(options: { provider?: LlmProvider; allowed?: boolean; intent?: string | null } = {}): Rig {
  const runs: AiRunRecord[] = [];
  const requests: LlmRequest[] = [];
  const guardCalls: string[] = [];
  const inner = options.provider ?? new DevMockLlmProvider();
  const provider: LlmProvider = {
    kind: 'mock',
    generate(request) {
      requests.push(request);
      return inner.generate(request);
    },
  };
  const deps: AgentDeps = {
    llm: createAuditedLlm({
      settings: { load: () => Promise.resolve(mockSettings()) },
      providers: { mock: provider },
      sink: {
        record: (run) => {
          runs.push(run);
          return Promise.resolve({ id: '00000000-0000-4000-8000-000000000001' });
        },
      },
    }),
    redactor: createRedactor({ names: () => ['Somchai Jaidee'] }),
    prompts: loadPromptCatalog(),
    guard: {
      check: (request) => {
        guardCalls.push(`${request.agent}:${request.action}`);
        return Promise.resolve(
          options.allowed === false
            ? { allowed: false, reason: 'kill_switch_on' as const }
            : { allowed: true as const },
        );
      },
    },
  };
  const registry = createToolRegistry(
    buildAllowList([{ key: 'webhook_not_received', allowedTools: [TOOL_NAMES.gcpLogs] }]),
  );
  for (const tool of investigationTools({
    kb: { search: () => Promise.resolve([KB_HIT]) },
    tickets: { find: () => Promise.resolve([SIMILAR]) },
    org: { get: () => Promise.resolve(ORG) },
    fixtures: FIXTURES,
  })) {
    registry.register(tool);
  }
  const intent = options.intent === undefined ? 'webhook_not_received' : options.intent;
  const ledger = createMemoryToolLedger({
    perRun: AI_TOOL_BUDGETS.perRun,
    perTicketPerHour: AI_TOOL_BUDGETS.perTicketPerHour,
    perToolPerMinute: AI_TOOL_BUDGETS.perToolPerMinute,
  });
  const tools = withToolBudget({
    scoped: registry.scope({ agent: 'investigator', intent, stage: 2 }, { ticketId: TICKET }),
    ledger,
    runKey: 'run-1',
    ticketId: TICKET,
    agent: 'investigator',
    intent,
    stage: 2,
    hashKey: HASH_KEY,
  });
  return {
    deps,
    runs,
    requests,
    guardCalls,
    input: (overrides = {}) => ({
      ticketId: TICKET,
      channel: 'email',
      subject: 'Webhook not received',
      turns: TURNS,
      intentKey: intent,
      scopeBasis: 'confidence',
      stage: 2,
      tools,
      ...overrides,
    }),
  };
}

describe('planRunbook', () => {
  it('runs the generic steps first, then the system tools the intent was granted', () => {
    const steps = planRunbook(
      { intentKey: 'webhook_not_received', queryText: 'webhook   not received' },
      [TOOL_NAMES.gcpLogs, TOOL_NAMES.kbSearch, TOOL_NAMES.orgContext, TOOL_NAMES.repoChanges],
    );
    expect(steps.map((step) => step.tool)).toEqual([
      TOOL_NAMES.kbSearch,
      TOOL_NAMES.orgContext,
      TOOL_NAMES.gcpLogs,
      TOOL_NAMES.repoChanges,
    ]);
    expect(steps[0]?.input).toMatchObject({ query: 'webhook not received' });
  });

  it('skips a granted tool it has no input for and builds every input from the ticket, not from a model', () => {
    const steps = planRunbook({ intentKey: null, queryText: '' }, [
      TOOL_NAMES.bigquery,
      TOOL_NAMES.repoChanges,
      TOOL_NAMES.kbSearch,
    ]);
    expect(steps.map((step) => step.tool)).toEqual([TOOL_NAMES.kbSearch]);
    expect(typeof steps[0]?.input.query).toBe('string');
    expect(steps[0]?.input.query).not.toBe('');
  });
});

describe('investigateTicket (T-108b)', () => {
  it('runs the runbook, makes evidence cards and a cited report, and records one ai_run with the tools', async () => {
    const r = rig();
    const outcome = await investigateTicket(r.deps, r.input());
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    const { report, evidence } = outcome.value;
    expect(evidence.map((card) => card.kind)).toEqual(['kb', 'ticket', 'data', 'log']);
    expect(evidence.map((card) => card.id)).toEqual(['ev-1', 'ev-2', 'ev-3', 'ev-4']);
    expect(report.tools.map((tool) => `${tool.name}:${tool.status}:${String(tool.mock)}`)).toEqual([
      'kb_search:ok:false',
      'similar_tickets:ok:false',
      'org_context:ok:false',
      'gcp_logs:ok:true',
    ]);
    expect(evidence.find((card) => card.tool === TOOL_NAMES.gcpLogs)?.mock).toBe(true);
    expect(report.scope).toEqual({ intent: 'webhook_not_received', basis: 'confidence' });
    expect(report.findings.length).toBeGreaterThan(0);
    for (const finding of report.findings) {
      for (const id of finding.evidenceIds) expect(evidence.map((card) => card.id)).toContain(id);
    }
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]).toMatchObject({ agent: 'investigator', status: 'ok', ticketId: TICKET });
    expect(r.runs[0]?.tools).toEqual(['kb_search', 'similar_tickets', 'org_context', 'gcp_logs']);
    expect(r.guardCalls).toEqual(['investigator:investigate']);
  });

  it('never lets a raw email reach the model, in the ticket or in a tool result (N4)', async () => {
    const r = rig();
    await investigateTicket(r.deps, r.input());
    const sent = JSON.stringify(r.requests);
    expect(sent).not.toContain(RAW_EMAIL);
    expect(sent).not.toContain(OTHER_EMAIL);
    expect(sent).not.toContain('Somchai');
    expect(sent).toContain('[EMAIL_');
    expect(r.runs[0]?.redaction.total).toBeGreaterThan(1);
  });

  it("shows the ticket's own details on a card and keeps another customer's as a placeholder", async () => {
    const r = rig({
      provider: new DevMockLlmProvider(),
    });
    const outcome = await investigateTicket(
      r.deps,
      r.input({
        turns: [{ from: 'customer', text: `Retries stopped. Reach ${OTHER_EMAIL} too.` }],
      }),
    );
    if (outcome.status !== 'ok') throw new Error('expected ok');
    const similar = outcome.value.evidence.find((card) => card.kind === 'ticket');
    // The email is in the ticket as well as in the other ticket's snippet, so it is the ticket's own.
    expect(similar?.snippet).toContain(OTHER_EMAIL);
    const solo = rig();
    const other = await investigateTicket(solo.deps, solo.input());
    if (other.status !== 'ok') throw new Error('expected ok');
    const card = other.value.evidence.find((item) => item.kind === 'ticket');
    expect(card?.snippet).not.toContain(OTHER_EMAIL);
    expect(card?.snippet).toMatch(/\[EMAIL_\d+\]/);
  });

  it('drops an evidence id the model made up, so the finding shows as uncited', async () => {
    const r = rig({
      provider: {
        kind: 'mock',
        generate: (request) =>
          Promise.resolve({
            text: JSON.stringify({
              findings: [
                { text: 'Real', evidenceIds: ['ev-1', 'ev-99'] },
                { text: 'Invented', evidenceIds: ['ev-42'] },
              ],
              likelyCause: null,
              confidence: 0.5,
              openQuestions: [],
              nextStep: { kind: 'reply', label: 'Reply' },
            }),
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1 },
            model: request.model,
          }),
      },
    });
    const outcome = await investigateTicket(r.deps, r.input());
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.value.report.findings.map((finding) => finding.evidenceIds)).toEqual([
      ['ev-1'],
      [],
    ]);
  });

  it('does not call a model when the guard says no, and returns the reason', async () => {
    const r = rig({ allowed: false });
    const outcome = await investigateTicket(r.deps, r.input());
    expect(outcome).toEqual({ status: 'skipped', reason: 'kill_switch_on' });
    expect(r.requests).toHaveLength(0);
    expect(r.runs).toHaveLength(0);
  });

  it('lists a tool that is over budget as denied and still reports on the rest', async () => {
    const r = rig();
    const registry = createToolRegistry(buildAllowList([]));
    for (const tool of investigationTools({
      kb: { search: () => Promise.resolve([KB_HIT]) },
      tickets: { find: () => Promise.resolve([]) },
      org: { get: () => Promise.reject(new Error('db down')) },
    })) {
      registry.register(tool);
    }
    const ledger = createMemoryToolLedger({ perRun: 1, perTicketPerHour: 10, perToolPerMinute: 10 });
    const tools = withToolBudget({
      scoped: registry.scope({ agent: 'investigator', intent: null, stage: 2 }, { ticketId: TICKET }),
      ledger,
      runKey: 'run-2',
      ticketId: TICKET,
      agent: 'investigator',
      intent: null,
      stage: 2,
      hashKey: HASH_KEY,
    });
    const outcome = await investigateTicket(r.deps, r.input({ tools, scopeBasis: 'none' }));
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.value.report.tools.map((tool) => tool.status)).toEqual(['ok', 'denied', 'denied']);
    expect(outcome.value.report.scope?.basis).toBe('none');
    expect(outcome.value.evidence).toHaveLength(1);
  });

  it('spends no model call and invents nothing when no tool found evidence', async () => {
    const r = rig();
    const registry = createToolRegistry(buildAllowList([]));
    for (const tool of investigationTools({
      kb: { search: () => Promise.resolve([]) },
      tickets: { find: () => Promise.resolve([]) },
      org: { get: () => Promise.resolve(null) },
    })) {
      registry.register(tool);
    }
    const tools = withToolBudget({
      scoped: registry.scope({ agent: 'investigator', intent: null, stage: 2 }, { ticketId: TICKET }),
      ledger: createMemoryToolLedger(AI_TOOL_BUDGETS),
      runKey: 'run-3',
      ticketId: TICKET,
      agent: 'investigator',
      intent: null,
      stage: 2,
      hashKey: HASH_KEY,
    });
    const outcome = await investigateTicket(r.deps, r.input({ tools }));
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.runId).toBeNull();
    expect(outcome.value.report).toMatchObject({ findings: [], likelyCause: null, confidence: 0 });
    expect(r.requests).toHaveLength(0);
  });

  it('reports progress before each step', async () => {
    const r = rig();
    const seen: string[] = [];
    await investigateTicket(
      r.deps,
      r.input({
        onProgress: (progress) => {
          seen.push(`${progress.phase}:${String(progress.step)}/${String(progress.steps)}`);
          return Promise.resolve();
        },
      }),
    );
    expect(seen).toEqual([
      'investigating:0/5',
      'investigating:1/5',
      'investigating:2/5',
      'investigating:3/5',
      'investigating:4/5',
    ]);
  });

  it('returns failed, not an exception, for an answer that is not the report', async () => {
    const r = rig({
      provider: {
        kind: 'mock',
        generate: (request) =>
          Promise.resolve({
            text: 'not json',
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1 },
            model: request.model,
          }),
      },
    });
    expect(await investigateTicket(r.deps, r.input())).toEqual({
      status: 'failed',
      reason: 'model_output_invalid',
    });
  });
});

function card(
  id: string,
  overrides: Partial<InvestigationEvidence> = {},
): InvestigationEvidence {
  return {
    id,
    kind: 'kb',
    title: 'Webhook not received',
    snippet: 'Make sure the endpoint answers within ten seconds.',
    confidence: 0.9,
    tool: TOOL_NAMES.kbSearch,
    customerSafe: true,
    mock: false,
    ...overrides,
  };
}

describe('applyDisclosure (PRD section 6.6)', () => {
  const evidence = [card('ev-1'), card('ev-2', { kind: 'log', customerSafe: false })];
  const sentences: DraftSentence[] = [
    { text: 'Hello.', kind: 'courtesy', evidenceIds: [], newParagraph: false },
    { text: 'Check the endpoint.', kind: 'instruction', evidenceIds: ['ev-1'], newParagraph: false },
    { text: 'We saw failures in your logs.', kind: 'fact', evidenceIds: ['ev-2'], newParagraph: false },
    { text: 'See https://internal.example/x.', kind: 'fact', evidenceIds: ['ev-1'], newParagraph: false },
    { text: 'Mixed.', kind: 'fact', evidenceIds: ['ev-1', 'ev-2'], newParagraph: false },
  ];

  it('keeps everything for a verified contact', () => {
    expect(applyDisclosure(sentences, 'verified', evidence)).toEqual({
      kept: sentences,
      removed: 0,
    });
  });

  it('for an unverified contact removes sentences that rest on internal evidence or hold a link', () => {
    const { kept, removed } = applyDisclosure(sentences, 'restricted', evidence);
    expect(kept.map((sentence) => sentence.text)).toEqual(['Hello.', 'Check the endpoint.']);
    expect(removed).toBe(sentences.length - kept.length);
  });

  it('treats a citation to an unknown card as internal', () => {
    const { kept } = applyDisclosure(
      [{ text: 'X', kind: 'fact', evidenceIds: ['ev-404'], newParagraph: false }],
      'restricted',
      evidence,
    );
    expect(kept).toEqual([]);
  });

  it('composes paragraphs', () => {
    expect(
      composeBody([
        { text: 'A.', kind: 'courtesy', evidenceIds: [], newParagraph: false },
        { text: 'B.', kind: 'fact', evidenceIds: [], newParagraph: false },
        { text: 'C.', kind: 'courtesy', evidenceIds: [], newParagraph: true },
      ]),
    ).toBe('A. B.\n\nC.');
  });
});

function draftRig(answer: unknown, extra: Partial<Parameters<typeof draftReply>[1]> = {}) {
  const r = rig({
    provider: {
      kind: 'mock',
      generate: (request) =>
        Promise.resolve({
          text: JSON.stringify(answer),
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: request.model,
        }),
    },
  });
  const run = () =>
    draftReply(r.deps, {
      ticketId: TICKET,
      subject: 'Webhook not received',
      turns: TURNS,
      intentKey: 'webhook_not_received',
      customerLanguage: 'en',
      disclosure: 'verified',
      evidence: [card('ev-1'), card('ev-2', { kind: 'log', customerSafe: false, tool: TOOL_NAMES.gcpLogs })],
      ...extra,
    });
  return { r, run };
}

describe('draftReply (T-108c)', () => {
  it('counts a fact or instruction without evidence as uncited, and keeps a courtesy line free', async () => {
    const { run } = draftRig({
      language: 'en',
      sentences: [
        { text: 'Hello.', kind: 'courtesy', evidenceIds: [] },
        { text: 'Check the endpoint.', kind: 'instruction', evidenceIds: ['ev-1'] },
        { text: 'It will be fixed today.', kind: 'fact', evidenceIds: [] },
        { text: 'It was a deploy.', kind: 'fact', evidenceIds: ['ev-77'] },
        { text: 'Does that help?', kind: 'question', evidenceIds: [] },
      ],
    });
    const outcome = await run();
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.value.uncitedClaims).toBe(2);
    expect(outcome.value.citations).toEqual([{ evidenceId: 'ev-1', sentence: 1 }]);
    expect(outcome.value.citedEvidenceIds).toEqual(['ev-1']);
    expect(outcome.value.body).toContain('Check the endpoint.');
    expect(outcome.value.promptVersion).toBeGreaterThan(0);
  });

  it('removes internal evidence for an unverified contact and says how many sentences went', async () => {
    const { run } = draftRig(
      {
        sentences: [
          { text: 'Hello.', kind: 'courtesy', evidenceIds: [] },
          { text: 'Check the endpoint.', kind: 'instruction', evidenceIds: ['ev-1'] },
          { text: 'Your logs show failures.', kind: 'fact', evidenceIds: ['ev-2'] },
        ],
      },
      { disclosure: 'restricted' },
    );
    const outcome = await run();
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.value.body).not.toContain('logs');
    expect(outcome.value.disclosure).toEqual({ level: 'restricted', removedSentences: 1 });
    expect(outcome.value.citedEvidenceIds).toEqual(['ev-1']);
  });

  it('writes in the customer language and flags a draft in the other one for review', async () => {
    const thai = await draftRig(
      { sentences: [{ text: 'สวัสดีครับ ขอบคุณที่แจ้งเรื่อง', kind: 'courtesy', evidenceIds: [] }] },
      { customerLanguage: 'th' },
    ).run();
    if (thai.status !== 'ok') throw new Error('expected ok');
    expect(thai.value).toMatchObject({ language: 'th', customerLanguage: 'th', needsReview: false });

    const wrong = await draftRig({
      sentences: [{ text: 'สวัสดีครับ ขอบคุณที่แจ้งเรื่อง', kind: 'courtesy', evidenceIds: [] }],
    }).run();
    if (wrong.status !== 'ok') throw new Error('expected ok');
    expect(wrong.value).toMatchObject({ language: 'th', customerLanguage: 'en', needsReview: true });
  });

  it('asks for the language and the disclosure level in the prompt, and redacts the evidence it sends (N4)', async () => {
    const { r, run } = draftRig(
      { sentences: [{ text: 'Hello.', kind: 'courtesy', evidenceIds: [] }] },
      {
        customerLanguage: 'th',
        disclosure: 'restricted',
        note: `Mention ${RAW_EMAIL}`,
        evidence: [card('ev-1', { snippet: `Written by ${OTHER_EMAIL}` })],
      },
    );
    await run();
    const request = r.requests[0];
    expect(request?.system).toContain('Thai');
    expect(request?.system).toContain('restricted');
    const sent = JSON.stringify(request);
    expect(sent).not.toContain(RAW_EMAIL);
    expect(sent).not.toContain(OTHER_EMAIL);
    expect(r.runs[0]?.agent).toBe('drafter');
  });

  it('removes a placeholder that is not the customer’s own instead of filling it in or leaving it', async () => {
    const { run } = draftRig({
      sentences: [
        { text: 'Hello.', kind: 'courtesy', evidenceIds: [] },
        { text: 'We also spoke to [EMAIL_9].', kind: 'fact', evidenceIds: ['ev-1'] },
      ],
    });
    const outcome = await run();
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.value.body).toBe('Hello.');
    expect(outcome.value.disclosure.removedSentences).toBe(1);
  });

  it('fails, not throws, when nothing is left after the disclosure filter or the answer is malformed', async () => {
    const emptied = await draftRig(
      { sentences: [{ text: 'Logs say so.', kind: 'fact', evidenceIds: ['ev-2'] }] },
      { disclosure: 'restricted' },
    ).run();
    expect(emptied).toEqual({ status: 'failed', reason: 'model_output_invalid' });
    const bad = await draftRig({ sentences: [] }).run();
    expect(bad).toEqual({ status: 'failed', reason: 'model_output_invalid' });
  });

  it('is skipped by the guard before any model call', async () => {
    const r = rig({ allowed: false });
    const outcome = await draftReply(r.deps, {
      ticketId: TICKET,
      subject: 's',
      turns: TURNS,
      intentKey: null,
      customerLanguage: 'en',
      disclosure: 'verified',
      evidence: [],
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'kill_switch_on' });
    expect(r.requests).toHaveLength(0);
  });

  it('the dev mock drafts from the evidence and respects the restricted level', async () => {
    const r = rig();
    const ok = await draftReply(r.deps, {
      ticketId: TICKET,
      subject: 'Webhook',
      turns: TURNS,
      intentKey: null,
      customerLanguage: 'en',
      disclosure: 'restricted',
      evidence: [card('ev-1'), card('ev-2', { kind: 'log', customerSafe: false, tool: TOOL_NAMES.gcpLogs })],
    });
    if (ok.status !== 'ok') throw new Error('expected ok');
    expect(ok.value.citedEvidenceIds).toEqual(['ev-1']);
    expect(ok.value.disclosure.removedSentences).toBe(0);
  });
});

describe('authorKbDraft (T-108e)', () => {
  const turns: TicketTurn[] = [
    { from: 'customer', text: `Our export is empty. Mail ${RAW_EMAIL}.` },
    { from: 'staff', text: 'Re-run the export after clearing the date filter. That fixed it.' },
  ];

  it('drafts an article with no placeholder and no customer detail from the dev mock', async () => {
    const r = rig();
    const outcome = await authorKbDraft(r.deps, {
      ticketId: TICKET,
      subject: `Export empty for ${RAW_EMAIL}`,
      turns,
      intentKey: 'webhook_not_received',
      knownIntents: ['webhook_not_received'],
    });
    if (outcome.status !== 'ok' || outcome.value === null) throw new Error('expected a draft');
    expect(outcome.value.bodyMd).toContain('Resolution');
    expect(outcome.value.title).not.toContain('@');
    expect(outcome.value.bodyMd).not.toMatch(/\[[A-Z_]+_\d+\]/);
    expect(outcome.value.bodyMd).not.toContain(RAW_EMAIL);
    expect(outcome.value.intentTags).toEqual(['webhook_not_received']);
    expect(JSON.stringify(r.requests)).not.toContain(RAW_EMAIL);
    expect(r.runs[0]?.agent).toBe('kb_author');
  });

  it('fails an answer that carries a placeholder, and says "nothing to write" for an empty one', async () => {
    const make = (answer: unknown) =>
      rig({
        provider: {
          kind: 'mock',
          generate: (request) =>
            Promise.resolve({
              text: JSON.stringify(answer),
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1 },
              model: request.model,
            }),
        },
      });
    const input = { ticketId: TICKET, subject: 's', turns, intentKey: null, knownIntents: [] };
    const leaked = await authorKbDraft(make({ title: 'T', bodyMd: 'Mail [EMAIL_1]', intentTags: [] }).deps, input);
    expect(leaked).toEqual({ status: 'failed', reason: 'model_output_invalid' });
    const empty = await authorKbDraft(make({ title: '', bodyMd: '', intentTags: [] }).deps, input);
    expect(empty).toMatchObject({ status: 'ok', value: null });
  });

  it('drops an intent tag that does not exist', async () => {
    const r = rig({
      provider: {
        kind: 'mock',
        generate: (request) =>
          Promise.resolve({
            text: JSON.stringify({ title: 'T', bodyMd: 'B', intentTags: ['made_up', 'real_one'] }),
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1 },
            model: request.model,
          }),
      },
    });
    const outcome = await authorKbDraft(r.deps, {
      ticketId: TICKET,
      subject: 's',
      turns,
      intentKey: null,
      knownIntents: ['real_one'],
    });
    if (outcome.status !== 'ok' || outcome.value === null) throw new Error('expected a draft');
    expect(outcome.value.intentTags).toEqual(['real_one']);
  });
});
