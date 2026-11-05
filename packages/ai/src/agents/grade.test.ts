import { describe, expect, it } from 'vitest';

import { createAuditedLlm } from '../audited.js';
import type { AiRunRecord, LlmProvider, LlmRequest } from '../contract.js';
import { mockSettings } from '../models.js';
import { loadPromptCatalog } from '../prompt-files.js';
import { DevMockLlmProvider } from '../providers/dev-mock.js';
import { createRedactor } from '../redaction/redactor.js';
import type { AgentDeps } from './common.js';
import {
  buildGradeFacts,
  capResolutionClass,
  gradeResolution,
  graderAnswerSchema,
  type GradeFact,
  type ResolutionGradeInput,
} from './grade.js';
import { ALLOW_ALL_GUARD } from '../test-guard.js';

const TICKET = '00000000-0000-4000-8000-0000000000aa';

function rig(provider: LlmProvider = new DevMockLlmProvider(), allowed = true) {
  const runs: AiRunRecord[] = [];
  const requests: LlmRequest[] = [];
  const deps: AgentDeps = {
    llm: createAuditedLlm({
      guard: ALLOW_ALL_GUARD,
      settings: { load: () => Promise.resolve(mockSettings()) },
      providers: {
        mock: {
          kind: 'mock',
          generate: (request) => {
            requests.push(request);
            return provider.generate(request);
          },
        },
      },
      sink: {
        record: (run) => {
          runs.push(run);
          return Promise.resolve({ id: '00000000-0000-4000-8000-000000000009' });
        },
      },
    }),
    redactor: createRedactor(),
    prompts: loadPromptCatalog(),
    guard: {
      check: () =>
        Promise.resolve(allowed ? { allowed: true } : { allowed: false, reason: 'budget_stop' }),
    },
  };
  return { deps, runs, requests };
}

const pinned = (answer: unknown) =>
  new DevMockLlmProvider({ rules: [{ promptId: 'grader', text: JSON.stringify(answer) }] });

function input(over: Partial<Parameters<typeof buildGradeFacts>[0]> = {}): ResolutionGradeInput {
  const built = buildGradeFacts({
    ticketKey: 'OPS-12',
    ticketHref: '/?ticket=OPS-12',
    turns: [
      { from: 'customer', text: 'I cannot sign in, my email is jane@customer.example' },
      { from: 'staff', text: 'Please reset your password with the link on the sign in page.' },
    ],
    csat: null,
    kbCited: false,
    ...over,
  });
  return {
    ticketId: TICKET,
    intentKey: 'access',
    locale: 'en',
    facts: built.facts,
    hasDraft: built.hasDraft,
    csat: over.csat ?? null,
    kbCited: over.kbCited ?? false,
  };
}

describe('buildGradeFacts', () => {
  it('leaves internal notes out and marks the customer message that follows the last reply', () => {
    const built = buildGradeFacts({
      ticketKey: 'OPS-1',
      turns: [
        { from: 'customer', text: 'help' },
        { from: 'note', text: 'secret internal thing' },
        { from: 'staff', text: 'try this' },
        { from: 'customer', text: 'works, thanks' },
      ],
      csat: null,
      kbCited: true,
    });
    expect(built.facts.map((fact) => fact.role)).toEqual([
      'customer',
      'customer',
      'staff_reply',
      'kb',
    ]);
    expect(built.facts.map((fact) => fact.afterReply)).toEqual([false, true, undefined, undefined]);
    expect(JSON.stringify(built.facts)).not.toContain('secret internal');
    expect(built.hasStaffReply).toBe(true);
    expect(built.hasDraft).toBe(false);
  });

  it('prefers the reply that was really sent and records the draft and the survey', () => {
    const built = buildGradeFacts({
      ticketKey: 'OPS-1',
      turns: [{ from: 'customer', text: 'help' }],
      sentReply: 'final words',
      draftText: 'draft words',
      csat: { score: 4, resolved: true, comment: 'fast' },
      kbCited: false,
    });
    expect(built.facts.find((fact) => fact.role === 'staff_reply')?.text).toBe('final words');
    expect(built.facts.find((fact) => fact.role === 'csat')?.text).toContain('Resolved: yes');
    expect(built.hasDraft).toBe(true);
  });

  it('reports no staff reply when only the customer spoke', () => {
    const built = buildGradeFacts({
      ticketKey: 'OPS-1',
      turns: [{ from: 'customer', text: 'help' }],
      csat: null,
      kbCited: false,
    });
    expect(built.hasStaffReply).toBe(false);
  });
});

describe('capResolutionClass', () => {
  const afterReply: GradeFact = {
    role: 'customer',
    kind: 'ticket',
    label: 'x',
    text: 'works',
    afterReply: true,
    followUp: 'confirm',
  };
  const before: GradeFact = { ...afterReply, afterReply: false };

  it('does not count a thank-you or a question as confirmation, and a denial caps to assumed (T-301f)', () => {
    const base = { hasStaffReply: true, csat: null, claimed: 'verified' as const };
    const as = (followUp: GradeFact['followUp']): GradeFact => ({ ...afterReply, followUp });
    expect(capResolutionClass({ ...base, citedFacts: [as('ambiguous')] })).toBe('contained');
    expect(
      capResolutionClass({ ...base, citedFacts: [{ ...afterReply, followUp: undefined }] }),
    ).toBe('contained');
    expect(capResolutionClass({ ...base, citedFacts: [as('deny')] })).toBe('assumed');
    // A denial the model did not cite still counts, and CSAT "resolved" does not outvote it.
    expect(capResolutionClass({ ...base, citedFacts: [], allFacts: [as('deny')] })).toBe('assumed');
    expect(
      capResolutionClass({
        ...base,
        csat: { score: 5, resolved: true },
        citedFacts: [afterReply],
        allFacts: [as('deny')],
      }),
    ).toBe('assumed');
    // The latest message wins: denied first, then confirmed.
    expect(
      capResolutionClass({
        ...base,
        citedFacts: [afterReply],
        allFacts: [as('deny'), as('confirm')],
      }),
    ).toBe('verified');
  });

  it('never lets the model say verified without the customer confirming', () => {
    const base = { hasStaffReply: true, csat: null };
    expect(capResolutionClass({ ...base, claimed: 'verified', citedFacts: [] })).toBe('contained');
    expect(capResolutionClass({ ...base, claimed: 'verified', citedFacts: [before] })).toBe(
      'contained',
    );
    expect(capResolutionClass({ ...base, claimed: 'verified', citedFacts: [afterReply] })).toBe(
      'verified',
    );
  });

  it('takes a survey that says resolved as confirmation, and one that says not resolved as the end', () => {
    expect(
      capResolutionClass({
        claimed: 'verified',
        hasStaffReply: true,
        csat: { score: 5, resolved: true },
        citedFacts: [],
      }),
    ).toBe('verified');
    expect(
      capResolutionClass({
        claimed: 'verified',
        hasStaffReply: true,
        csat: { score: 1, resolved: false },
        citedFacts: [afterReply],
      }),
    ).toBe('assumed');
  });

  it('is assumed with no staff reply, and never raises a lower claim', () => {
    expect(
      capResolutionClass({
        claimed: 'verified',
        hasStaffReply: false,
        csat: { score: 5, resolved: true },
        citedFacts: [afterReply],
      }),
    ).toBe('assumed');
    expect(
      capResolutionClass({
        claimed: 'assumed',
        hasStaffReply: true,
        csat: { score: 5, resolved: true },
        citedFacts: [],
      }),
    ).toBe('assumed');
  });
});

describe('gradeResolution', () => {
  it('grades with the default mock, cites facts, redacts before the call and records ai_run', async () => {
    const { deps, runs, requests } = rig();
    const outcome = await gradeResolution(deps, input());
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.value.resolutionClass).toBe('contained');
    expect(outcome.value.draftVerdict).toBe('no_draft');
    expect(outcome.value.draftQuality).toBeNull();
    expect(outcome.value.mock).toBe(true);
    expect(outcome.value.kbGap).toBe(true);
    expect(outcome.value.reasons[0]?.evidence[0]?.href).toBe('/?ticket=OPS-12');
    expect(outcome.runId).toBe('00000000-0000-4000-8000-000000000009');
    expect(runs.map((run) => [run.agent, run.prompt.id, run.prompt.version])).toEqual([
      ['grader', 'grader', 1],
    ]);
    // N4: the address never reached the model.
    const sent = requests[0]?.messages.map((message) => message.content).join('') ?? '';
    expect(sent).not.toContain('jane@customer.example');
    expect(sent).toContain('[f1] customer:');
  });

  it('compares a draft with the reply and scores it', async () => {
    const { deps } = rig();
    const outcome = await gradeResolution(
      deps,
      input({ draftText: 'Please reset your password with the link on the sign in page.' }),
    );
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.value.draftVerdict).toBe('matches');
    expect(outcome.value.draftQuality).toBe(1);
  });

  it('caps a model that claims verified with nothing to show for it', async () => {
    const { deps } = rig(
      pinned({
        resolutionClass: 'verified',
        draftVerdict: 'no_draft',
        reasons: [{ text: 'Looks fixed.', factIds: ['f2'] }],
      }),
    );
    const outcome = await gradeResolution(deps, input());
    expect(outcome.status === 'ok' && outcome.value.resolutionClass).toBe('contained');
    expect(outcome.status === 'ok' && outcome.value.modelClass).toBe('verified');
  });

  describe('customer follow-up after the answer (T-301f)', () => {
    const turns = (follow: string) => [
      { from: 'customer' as const, text: 'I cannot sign in' },
      { from: 'staff' as const, text: 'Please reset your password.' },
      { from: 'customer' as const, text: follow },
    ];
    const claimsVerified = pinned({
      resolutionClass: 'verified',
      draftVerdict: 'no_draft',
      reasons: [{ text: 'Customer replied.', factIds: ['f2'] }],
    });
    const gradeWith = async (follow: string) => {
      const { deps } = rig(claimsVerified);
      const outcome = await gradeResolution(deps, input({ turns: turns(follow) }));
      return outcome.status === 'ok' ? outcome.value.resolutionClass : outcome.status;
    };

    it.each([
      ['It works now, thanks', 'verified'],
      ['Thanks', 'contained'],
      ['Is it working now?', 'contained'],
      ['Still not working', 'assumed'],
      ['ยังไม่หายครับ', 'assumed'],
      ['Not fixed yet', 'assumed'],
      ['Please reopen this', 'assumed'],
    ])('a model that claims verified after %j ends as %s', async (follow, expected) => {
      expect(await gradeWith(follow)).toBe(expected);
    });

    it('counts a denial the model did not cite', async () => {
      const { deps } = rig(
        pinned({
          resolutionClass: 'verified',
          draftVerdict: 'no_draft',
          reasons: [{ text: 'Staff answered.', factIds: ['f3'] }],
        }),
      );
      const outcome = await gradeResolution(
        deps,
        input({ turns: turns('still broken, same error') }),
      );
      expect(outcome.status === 'ok' && outcome.value.resolutionClass).toBe('assumed');
    });

    it('reads the follow-up from redacted text', async () => {
      // The address would be a different word to the rules; the verdict must not depend on it.
      expect(await gradeWith('still not working, call me on jane@customer.example')).toBe(
        'assumed',
      );
    });
  });

  it('keeps an uncited violation labelled uncited, drops an uncited reason, ignores unknown ids', async () => {
    const { deps } = rig(
      pinned({
        resolutionClass: 'contained',
        draftVerdict: 'no_draft',
        policyViolations: [
          { code: 'promise', text: 'Promised a refund by Friday.', factIds: ['f2'] },
          { code: 'invented', text: 'Something odd.', factIds: ['f99'] },
        ],
        reasons: [
          { text: 'No evidence at all.', factIds: [] },
          { text: 'Answered.', factIds: ['f2', 'f77'] },
        ],
      }),
    );
    const outcome = await gradeResolution(deps, input());
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.value.violations.map((item) => [item.code, item.claim.uncited])).toEqual([
      ['promise', false],
      ['other', true],
    ]);
    expect(outcome.value.reasons).toHaveLength(1);
    expect(outcome.value.reasons[0]?.evidence).toHaveLength(1);
  });

  it('fails an answer that says there was no draft when there was one, and one that is not JSON', async () => {
    const bad = rig(pinned({ resolutionClass: 'contained', draftVerdict: 'no_draft' }));
    expect(await gradeResolution(bad.deps, input({ draftText: 'a draft' }))).toEqual({
      status: 'failed',
      reason: 'model_output_invalid',
    });
    const text = rig(new DevMockLlmProvider({ rules: [{ promptId: 'grader', text: 'sorry' }] }));
    expect(await gradeResolution(text.deps, input())).toEqual({
      status: 'failed',
      reason: 'model_output_invalid',
    });
  });

  it('does not call a model when the guard says no, and does not flag a gap when an article was cited', async () => {
    const denied = rig(new DevMockLlmProvider(), false);
    expect(await gradeResolution(denied.deps, input())).toEqual({
      status: 'skipped',
      reason: 'budget_stop',
    });
    expect(denied.requests).toHaveLength(0);
    const cited = rig();
    const outcome = await gradeResolution(cited.deps, input({ kbCited: true }));
    expect(outcome.status === 'ok' && outcome.value.kbGap).toBe(false);
  });

  it('answer schema rejects an unknown class', () => {
    expect(
      graderAnswerSchema.safeParse({ resolutionClass: 'solved', draftVerdict: 'matches' }).success,
    ).toBe(false);
  });
});
