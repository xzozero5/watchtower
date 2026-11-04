import {
  PROCEDURE_SIMULATION,
  judgeSimulation,
  procedureStepsSchema,
  type ProcedureSteps,
  type ProcedureStepsInput,
} from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { createAuditedLlm } from '../audited.js';
import type { AiRunRecord, LlmProvider, LlmRequest } from '../contract.js';
import { mockSettings } from '../models.js';
import { loadPromptCatalog } from '../prompt-files.js';
import { createRedactor } from '../redaction/redactor.js';
import { ALLOW_ALL_GUARD } from '../test-guard.js';
import { createMemoryToolLedger, withToolBudget } from '../toolkit/budget.js';
import type { KbHit, OrgContext, SimilarTicket, SystemToolPorts } from '../toolkit/ports.js';
import { buildAllowList, investigationTools, TOOL_NAMES } from '../toolkit/tools.js';
import { createToolRegistry } from '../tools.js';
import type { AgentDeps } from './common.js';
import { draftReply, type DraftInput } from './draft.js';
import { investigateTicket, planRunbook, type InvestigateInput } from './investigate.js';
import {
  applyProcedureDisclosure,
  selectActions,
  selectChecks,
  selectDisclosureRules,
  selectGuidelines,
  selectToolSteps,
} from './procedure-plan.js';
import {
  normalizedEditDistance,
  runProcedureSimulation,
  type SimulationCaseInput,
  type SimulationEnv,
} from './procedure-simulation.js';
import type { TicketTurn } from './summarize.js';

const TICKET = '11111111-1111-4111-8111-111111111111';
const VERSION = '33333333-3333-4333-8333-333333333333';
const HASH_KEY = 'unit-test-hash-key-0123456789abcdef';

const GRANTED_ALL = [
  TOOL_NAMES.kbSearch,
  TOOL_NAMES.similarTickets,
  TOOL_NAMES.orgContext,
  TOOL_NAMES.gcpLogs,
  TOOL_NAMES.bigquery,
  TOOL_NAMES.repoChanges,
];

const steps = (list: ProcedureStepsInput['steps'], autosend: 'allowed' | 'never' = 'never') =>
  procedureStepsSchema.parse({ schemaVersion: 1, autosend, steps: list });

describe('planRunbook with a procedure (ADR-026 section 1)', () => {
  const context = { intentKey: 'webhook_not_received', queryText: 'webhook not received' };

  it('without a procedure keeps the default order of every tool', () => {
    expect(planRunbook(context, GRANTED_ALL).map((step) => step.tool)).toEqual([
      'kb_search',
      'similar_tickets',
      'org_context',
      'gcp_logs',
      'bigquery_query',
      'repo_changes',
    ]);
    // A procedure with no tool step is the same as none: it cannot switch the investigation off.
    expect(
      planRunbook(
        context,
        GRANTED_ALL,
        steps([{ kind: 'reply_guideline', id: 'tone', text: 'Be brief.' }]),
      ),
    ).toEqual(planRunbook(context, GRANTED_ALL));
  });

  it('runs the tool steps in the order written, only for granted tools, with the params it gave', () => {
    const procedure = steps([
      { kind: 'tool', id: 'logs', tool: 'gcp_logs', params: { windowMinutes: 120, limit: 5 } },
      { kind: 'tool', id: 'kb', tool: 'kb_search', params: { limit: 20 } },
      { kind: 'tool', id: 'repo', tool: 'repo_changes', params: { windowHours: 48 } },
    ]);
    const planned = planRunbook(context, [TOOL_NAMES.kbSearch, TOOL_NAMES.gcpLogs], procedure);
    expect(planned.map((step) => [step.tool, step.stepId])).toEqual([
      ['gcp_logs', 'logs'],
      ['kb_search', 'kb'],
    ]);
    expect(planned[0]?.input).toEqual({ windowMinutes: 120, limit: 5 });
    // 20 is allowed by the procedure schema, the kb tool takes at most 5.
    expect(planned[1]?.input).toMatchObject({ limit: 5, query: 'webhook not received' });
  });

  it('never adds a tool nobody granted and puts no text into a system tool input', () => {
    const procedure = steps([{ kind: 'tool', id: 'data', tool: 'bigquery_query' }]);
    expect(planRunbook(context, [TOOL_NAMES.kbSearch], procedure)).toEqual([]);
    const planned = planRunbook(context, [TOOL_NAMES.bigquery], procedure);
    expect(planned).toEqual([{ tool: 'bigquery_query', input: { limit: 20 }, stepId: 'data' }]);
  });

  it('leaves out a step whose stage or condition does not hold, and a second step for one tool', () => {
    const procedure = steps([
      { kind: 'tool', id: 'kb', tool: 'kb_search' },
      { kind: 'tool', id: 'kb2', tool: 'kb_search' },
      { kind: 'tool', id: 'late', tool: 'org_context', stages: [3] },
      {
        kind: 'tool',
        id: 'p1',
        tool: 'similar_tickets',
        when: { all: [{ field: 'ticket.priority', op: 'eq', value: 'P1' }] },
      },
      {
        kind: 'tool',
        id: 'count',
        tool: 'gcp_logs',
        when: { all: [{ field: 'evidence.count', op: 'gte', value: 1 }] },
      },
    ]);
    const run = (stage: number, facts: Record<string, string | number>) =>
      planRunbook({ ...context, stage, facts }, GRANTED_ALL, procedure).map((step) => step.stepId);
    expect(run(2, { 'ticket.priority': 'P3' })).toEqual(['kb']);
    expect(run(2, { 'ticket.priority': 'P1' })).toEqual(['kb', 'p1']);
    expect(run(3, { 'ticket.priority': 'P3' })).toEqual(['kb', 'late']);
    // `evidence.count` is not known before the tools ran: that step never runs, it does not guess.
    expect(selectToolSteps(procedure, { stage: 2, facts: {} }).map((step) => step.id)).toEqual([
      'kb',
    ]);
  });
});

describe('what a procedure adds besides the tools', () => {
  const procedure = steps([
    { kind: 'tool', id: 'kb', tool: 'kb_search' },
    { kind: 'check', id: 'q1', question: 'Is the endpoint reachable?', evidenceFrom: ['kb'] },
    { kind: 'check', id: 'q2', question: 'Late question?', evidenceFrom: ['kb'], stages: [3] },
    { kind: 'reply_guideline', id: 'g1', text: 'Be brief.', lang: 'en' },
    { kind: 'disclosure', id: 'd1', rule: 'never_mention', topic: 'Refund Policy' },
    { kind: 'disclosure', id: 'd2', rule: 'verified_only', topic: 'invoice number' },
    {
      kind: 'escalate',
      id: 'e1',
      when: { all: [{ field: 'ticket.priority', op: 'in', value: ['P1', 'P2'] }] },
      to: { role: 'lead' },
      note: 'Look at it.',
    },
    {
      kind: 'require_human',
      id: 'h1',
      when: { all: [{ field: 'investigation.hasLikelyCause', op: 'eq', value: false }] },
      reason: 'No cause found',
    },
  ]);

  it('selects checks only when a tool step they read runs, at the stage', () => {
    const selection = { stage: 2, facts: {} };
    expect(selectChecks(procedure, selection, new Set(['kb'])).map((c) => c.stepId)).toEqual([
      'q1',
    ]);
    expect(selectChecks(procedure, selection, new Set())).toEqual([]);
  });

  it('sends no guideline at stage 0 and keeps the disclosure rules at every stage', () => {
    expect(selectGuidelines(procedure, { stage: 0, facts: {} })).toEqual([]);
    expect(selectGuidelines(procedure, { stage: 2, facts: {} })).toHaveLength(1);
    expect(selectDisclosureRules(procedure, { stage: 0, facts: {} })).toHaveLength(2);
  });

  it('proposes an escalation only when the fact is known and holds; require_human holds when the fact is unknown', () => {
    expect(selectActions(procedure, { stage: 2, facts: {} })).toEqual({
      escalations: [],
      requireHuman: [{ stepId: 'h1', reason: 'No cause found' }],
    });
    const known = selectActions(procedure, {
      stage: 2,
      facts: { 'ticket.priority': 'P1', 'investigation.hasLikelyCause': true },
    });
    expect(known.escalations).toEqual([
      { stepId: 'e1', to: { role: 'lead' }, note: 'Look at it.' },
    ]);
    expect(known.requireHuman).toEqual([]);
  });

  it('removes sentences that name a forbidden topic, verified_only only for an unverified reader', () => {
    const rules = selectDisclosureRules(procedure, { stage: 2, facts: {} });
    const sentences = [
      { text: 'Our  refund policy is generous.' },
      { text: 'Your invoice number is on the portal.' },
      { text: 'Thanks for writing.' },
    ];
    expect(applyProcedureDisclosure(sentences, rules, 'restricted')).toEqual({
      kept: [{ text: 'Thanks for writing.' }],
      removed: 2,
    });
    expect(applyProcedureDisclosure(sentences, rules, 'verified').removed).toBe(1);
  });
});

// --- investigator and drafter with a procedure ---------------------------------------------------------------

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
  snippet: 'Retries stopped.',
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
const SYSTEMS: SystemToolPorts = {
  logs: {
    mock: true,
    run: () =>
      Promise.resolve({
        items: [
          {
            timestamp: '2026-01-01T00:00:00Z',
            severity: 'ERROR',
            service: 'api',
            message: 'delivery failed',
          },
        ],
      }),
  },
};
const TURNS: TicketTurn[] = [{ from: 'customer', text: 'Our webhook is not received.' }];

const INVESTIGATOR_ANSWER = {
  findings: [{ text: 'Delivery failed in the logs.', evidenceIds: ['ev-4'] }],
  likelyCause: 'The endpoint timed out.',
  confidence: 0.7,
  openQuestions: [],
  nextStep: { kind: 'reply', label: 'Reply to the customer' },
  checkAnswers: [
    { stepId: 'q1', answer: 'It timed out.', evidenceIds: ['ev-1', 'ev-99'] },
    { stepId: 'not_a_step', answer: 'ignored', evidenceIds: [] },
  ],
};

function pinned(answers: Record<string, unknown>, requests: LlmRequest[]): LlmProvider {
  return {
    kind: 'mock',
    generate(request) {
      requests.push(request);
      const answer = answers[request.prompt.id];
      return Promise.resolve({
        text: typeof answer === 'string' ? answer : JSON.stringify(answer ?? {}),
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1 },
        model: request.model,
      });
    },
  };
}

function agents(provider: LlmProvider, runs: AiRunRecord[]): AgentDeps {
  return {
    llm: createAuditedLlm({
      guard: ALLOW_ALL_GUARD,
      settings: { load: () => Promise.resolve(mockSettings()) },
      providers: { mock: provider },
      sink: {
        record: (run) => {
          runs.push(run);
          return Promise.resolve({ id: '00000000-0000-4000-8000-000000000001' });
        },
      },
    }),
    redactor: createRedactor({ names: () => [] }),
    prompts: loadPromptCatalog(),
    guard: ALLOW_ALL_GUARD,
  };
}

function toolsFor(ticketId: string, stage = 2) {
  const registry = createToolRegistry(
    buildAllowList([{ key: 'webhook_not_received', allowedTools: [TOOL_NAMES.gcpLogs] }]),
  );
  for (const tool of investigationTools({
    kb: { search: () => Promise.resolve([KB_HIT]) },
    tickets: { find: () => Promise.resolve([SIMILAR]) },
    org: { get: () => Promise.resolve(ORG) },
    systems: SYSTEMS,
  })) {
    registry.register(tool);
  }
  return withToolBudget({
    scoped: registry.scope(
      { agent: 'investigator', intent: 'webhook_not_received', stage: stage as 2 },
      { ticketId },
    ),
    ledger: createMemoryToolLedger(PROCEDURE_SIMULATION.toolBudgets),
    runKey: `run-${ticketId}`,
    ticketId,
    agent: 'investigator',
    intent: 'webhook_not_received',
    stage: stage as 2,
    hashKey: HASH_KEY,
  });
}

const input = (overrides: Partial<InvestigateInput>): InvestigateInput => ({
  ticketId: TICKET,
  channel: 'email',
  subject: 'Webhook not received',
  turns: TURNS,
  intentKey: 'webhook_not_received',
  scopeBasis: 'confidence',
  stage: 2,
  tools: toolsFor(TICKET),
  ...overrides,
});

const PROCEDURE: ProcedureSteps = steps([
  { kind: 'tool', id: 'kb', tool: 'kb_search' },
  { kind: 'tool', id: 'logs', tool: 'gcp_logs' },
  { kind: 'check', id: 'q1', question: 'Is the endpoint reachable?', evidenceFrom: ['kb', 'logs'] },
  {
    kind: 'escalate',
    id: 'e1',
    when: { all: [{ field: 'evidence.count', op: 'gte', value: 2 }] },
    to: { queueKey: 'engineering' },
    note: 'Needs an engineer.',
  },
  {
    kind: 'require_human',
    id: 'h1',
    when: { all: [{ field: 'investigation.hasLikelyCause', op: 'eq', value: false }] },
    reason: 'No cause found',
  },
]);

describe('investigator with a procedure (T-303c)', () => {
  it('runs only the tools of the procedure, asks its questions, answers them from evidence and records the version', async () => {
    const requests: LlmRequest[] = [];
    const runs: AiRunRecord[] = [];
    const deps = agents(pinned({ investigator: INVESTIGATOR_ANSWER }, requests), runs);
    const outcome = await investigateTicket(
      deps,
      input({ procedure: { versionId: VERSION, steps: PROCEDURE, facts: {} } }),
    );
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.value.report.tools.map((tool) => tool.name)).toEqual(['kb_search', 'gcp_logs']);
    expect(outcome.value.report.promptVersion).toBe('v3');
    expect(requests[0]?.system).toContain('[q1] Is the endpoint reachable?');
    const procedure = outcome.value.report.procedure;
    expect(procedure?.versionId).toBe(VERSION);
    expect(procedure?.autosend).toBe('never');
    // The answer cites only ids that exist; a step id the model made up is dropped.
    expect(procedure?.checks).toEqual([
      {
        stepId: 'q1',
        question: 'Is the endpoint reachable?',
        answer: 'It timed out.',
        evidenceIds: ['ev-1'],
      },
    ]);
    // Two cards of evidence and a likely cause: the escalation is proposed, nobody is called in.
    expect(procedure?.escalations).toEqual([
      { stepId: 'e1', to: { queueKey: 'engineering' }, note: 'Needs an engineer.' },
    ]);
    expect(procedure?.requireHuman).toEqual([]);
    expect(runs[0]?.procedureVersionId).toBe(VERSION);
  });

  it('calls for a person when the investigation found no cause', async () => {
    const deps = agents(
      pinned({ investigator: { ...INVESTIGATOR_ANSWER, likelyCause: null, checkAnswers: [] } }, []),
      [],
    );
    const outcome = await investigateTicket(
      deps,
      input({ procedure: { versionId: VERSION, steps: PROCEDURE, facts: {} } }),
    );
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.value.report.procedure?.requireHuman).toEqual([
      { stepId: 'h1', reason: 'No cause found' },
    ]);
    expect(outcome.value.report.procedure?.checks[0]?.answer).toBe(
      'Not answered from the evidence.',
    );
  });

  it('without a procedure adds nothing: no section in the report, no version on the run, no slot text in the prompt', async () => {
    const requests: LlmRequest[] = [];
    const runs: AiRunRecord[] = [];
    const deps = agents(pinned({ investigator: INVESTIGATOR_ANSWER }, requests), runs);
    const outcome = await investigateTicket(deps, input({}));
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.value.report.procedure).toBeUndefined();
    expect(runs[0]?.procedureVersionId).toBeUndefined();
    expect(requests[0]?.system).not.toContain('checkAnswers');
  });
});

const DRAFT_ANSWER = {
  language: 'en',
  sentences: [
    { text: 'Thanks for writing.', kind: 'courtesy', evidenceIds: [], newParagraph: false },
    {
      text: 'The endpoint must answer within ten seconds.',
      kind: 'instruction',
      evidenceIds: ['ev-1'],
      newParagraph: false,
    },
    {
      text: 'Our refund policy covers this.',
      kind: 'fact',
      evidenceIds: ['ev-1'],
      newParagraph: false,
    },
  ],
};

describe('drafter with a procedure (T-303c)', () => {
  const evidence: DraftInput['evidence'] = [
    {
      id: 'ev-1',
      kind: 'kb',
      title: 'Webhook not received',
      snippet: 'Make sure the endpoint answers within ten seconds.',
      confidence: 0.9,
      customerSafe: true,
      mock: false,
      tool: 'kb_search',
      href: '/kb/x',
    },
  ];
  const base: DraftInput = {
    ticketId: TICKET,
    subject: 'Webhook not received',
    turns: TURNS,
    intentKey: 'webhook_not_received',
    customerLanguage: 'en',
    disclosure: 'verified',
    evidence,
  };

  it('puts the guidelines after the rules, says they rank lower, and removes a sentence on a never_mention topic', async () => {
    const requests: LlmRequest[] = [];
    const runs: AiRunRecord[] = [];
    const deps = agents(pinned({ drafter: DRAFT_ANSWER }, requests), runs);
    const outcome = await draftReply(deps, {
      ...base,
      procedure: {
        versionId: VERSION,
        guidelines: [
          { stepId: 'g1', text: 'Keep it to three sentences.', lang: 'en' },
          { stepId: 'g2', text: 'ข้อความภาษาไทย', lang: 'th' },
        ],
        disclosure: [{ stepId: 'd1', rule: 'never_mention', topic: 'refund policy' }],
      },
    });
    if (outcome.status !== 'ok') throw new Error('expected ok');
    const system = requests[0]?.system ?? '';
    expect(system.indexOf('Disclosure level')).toBeLessThan(
      system.indexOf('Keep it to three sentences.'),
    );
    expect(system).toContain('rank below every rule above');
    expect(system).not.toContain('ข้อความภาษาไทย');
    expect(system).toContain('Do not mention: refund policy');
    expect(outcome.value.body).not.toContain('refund');
    expect(outcome.value.disclosure.removedSentences).toBe(1);
    expect(runs[0]?.procedureVersionId).toBe(VERSION);
  });

  it('writes the draft as before without a procedure (no guideline text, no version on the run)', async () => {
    const requests: LlmRequest[] = [];
    const runs: AiRunRecord[] = [];
    const deps = agents(pinned({ drafter: DRAFT_ANSWER }, requests), runs);
    const outcome = await draftReply(deps, base);
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(requests[0]?.system).not.toContain("team's guidelines");
    expect(outcome.value.body).toContain('refund policy');
    expect(runs[0]?.procedureVersionId).toBeUndefined();
    expect(outcome.value.promptVersion).toBe(2);
  });
});

// --- simulation ---------------------------------------------------------------------------------------------

describe('normalizedEditDistance', () => {
  it('is 0 for the same text, 100 for nothing in common and ignores case and spacing', () => {
    expect(normalizedEditDistance('Hello  World', 'hello world')).toBe(0);
    expect(normalizedEditDistance('aaaa', 'bbbb')).toBe(100);
    expect(normalizedEditDistance('', '')).toBe(0);
    expect(normalizedEditDistance('abcd', 'abce')).toBe(25);
  });
});

describe('judgeSimulation (ADR-026 section 6)', () => {
  const ok = {
    mode: 'fixture' as const,
    caseCount: 10,
    failedCases: 0,
    seededCases: 0,
    candidate: {
      editDistance: 40,
      uncitedClaims: 1,
      drafted: 10,
      violations: 0,
      disclosureLeaks: 0,
    },
    baseline: { editDistance: 38, uncitedClaims: 1, drafted: 10 },
    baselineVersionId: null,
    deadSteps: [],
    toolCalls: 20,
    cases: [],
  };
  it('passes when nothing is worse by more than the limit', () => {
    expect(judgeSimulation(ok)).toEqual([]);
  });
  it('names every reason it fails', () => {
    expect(
      judgeSimulation({
        ...ok,
        failedCases: 5,
        deadSteps: ['kb'],
        candidate: {
          ...ok.candidate,
          violations: 1,
          disclosureLeaks: 1,
          uncitedClaims: 3,
          editDistance: 50,
        },
      }).sort(),
    ).toEqual(
      [
        'policy_violation',
        'disclosure_leak',
        'more_uncited',
        'edit_distance_worse',
        'step_never_worked',
        'too_many_failed',
      ].sort(),
    );
    expect(judgeSimulation({ ...ok, caseCount: 0 })).toEqual(['no_cases']);
  });
});

const GRADE_ANSWER = {
  resolutionClass: 'contained',
  draftVerdict: 'partial',
  draftQuality: 0.6,
  policyViolations: [],
  kbGap: false,
  reasons: [],
};

function simCase(n: number): SimulationCaseInput {
  const ticketId = `00000000-0000-4000-8000-00000000000${String(n)}`;
  return {
    ticketId,
    ticketKey: `OPS-${String(n)}`,
    seeded: false,
    channel: 'email',
    subject: 'Webhook not received',
    turns: TURNS,
    humanReply: 'Thanks for writing. The endpoint must answer within ten seconds.',
    intentKey: 'webhook_not_received',
    stage: 2,
    customerLanguage: 'en',
    disclosure: 'verified',
    facts: {},
  };
}

function simEnv(provider: LlmProvider): SimulationEnv {
  return {
    mode: 'fixture',
    agentsFor: () => agents(provider, []),
    toolsFor: (item) => toolsFor(item.ticketId),
  };
}

describe('runProcedureSimulation (T-303d)', () => {
  const answers = {
    investigator: INVESTIGATOR_ANSWER,
    drafter: {
      language: 'en',
      sentences: [
        { text: 'Thanks for writing.', kind: 'courtesy', evidenceIds: [] },
        {
          text: 'The endpoint must answer within ten seconds.',
          kind: 'instruction',
          evidenceIds: ['ev-1'],
        },
      ],
    },
    grader: GRADE_ANSWER,
  };
  const candidate = { versionId: VERSION, steps: PROCEDURE };
  const baseline = { versionId: null, steps: undefined };

  it('runs both variants on each case, compares with the reply of the person and passes when nothing is worse', async () => {
    const outcome = await runProcedureSimulation(simEnv(pinned(answers, [])), {
      cases: [simCase(1), simCase(2)],
      candidate,
      baseline,
    });
    if (outcome.status !== 'ok') throw new Error(`stopped: ${outcome.reason}`);
    expect(outcome.passed).toBe(true);
    expect(outcome.metrics.failReasons).toEqual([]);
    expect(outcome.metrics.caseCount).toBe(2);
    expect(outcome.metrics.candidate.drafted).toBe(2);
    expect(outcome.metrics.candidate.violations).toBe(0);
    expect(outcome.metrics.candidate.editDistance).toBeLessThan(10);
    expect(outcome.metrics.baseline?.drafted).toBe(2);
    expect(outcome.metrics.deadSteps).toEqual([]);
    expect(outcome.metrics.toolCalls).toBeGreaterThan(0);
  });

  it('fails when the grader finds a policy violation or the draft leaks a forbidden topic', async () => {
    const violated = {
      ...answers,
      grader: {
        ...GRADE_ANSWER,
        policyViolations: [{ code: 'disclosure', text: 'Mentions internal data.', factIds: [] }],
      },
    };
    const outcome = await runProcedureSimulation(simEnv(pinned(violated, [])), {
      cases: [simCase(1)],
      candidate,
      baseline,
    });
    if (outcome.status !== 'ok') throw new Error('stopped');
    expect(outcome.passed).toBe(false);
    expect(outcome.metrics.failReasons).toEqual(
      expect.arrayContaining(['policy_violation', 'disclosure_leak']),
    );
  });

  it('fails with a dead step when a tool step ran and never worked', async () => {
    const outcome = await runProcedureSimulation(
      {
        ...simEnv(pinned(answers, [])),
        // The logs tool always fails.
        toolsFor: (item) => {
          const tools = toolsFor(item.ticketId);
          return {
            ...tools,
            call: (name, toolInput) =>
              name === 'gcp_logs' ? Promise.reject(new Error('boom')) : tools.call(name, toolInput),
          };
        },
      },
      { cases: [simCase(1)], candidate, baseline },
    );
    if (outcome.status !== 'ok') throw new Error('stopped');
    expect(outcome.metrics.deadSteps).toEqual(['logs']);
    expect(outcome.metrics.failReasons).toContain('step_never_worked');
  });

  it('stops the whole run (no verdict) when the guard refuses', async () => {
    const env = simEnv(pinned(answers, []));
    const outcome = await runProcedureSimulation(
      {
        ...env,
        agentsFor: () => ({
          ...agents(pinned(answers, []), []),
          guard: {
            check: () =>
              Promise.resolve({ allowed: false as const, reason: 'budget_stop' as const }),
          },
        }),
      },
      { cases: [simCase(1)], candidate, baseline },
    );
    expect(outcome).toEqual({ status: 'stopped', reason: 'budget_stop' });
  });

  it('stops at the tool ceiling', async () => {
    const outcome = await runProcedureSimulation(simEnv(pinned(answers, [])), {
      cases: [simCase(1), simCase(2), simCase(3)],
      candidate,
      baseline,
      maxToolCalls: 1,
    });
    expect(outcome).toEqual({ status: 'stopped', reason: 'tool_ceiling' });
  });
});
