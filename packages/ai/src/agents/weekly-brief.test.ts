import { describe, expect, it } from 'vitest';

import { createAuditedLlm } from '../audited.js';
import type { AiRunRecord, LlmProvider, LlmRequest } from '../contract.js';
import { mockSettings } from '../models.js';
import { loadPromptCatalog } from '../prompt-files.js';
import { DevMockLlmProvider } from '../providers/dev-mock.js';
import { createRedactor } from '../redaction/redactor.js';
import { ALLOW_ALL_GUARD } from '../test-guard.js';
import type { AgentDeps } from './common.js';
import { writeWeeklyBrief, type WeeklyBriefFact } from './weekly-brief.js';

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

const FACTS: WeeklyBriefFact[] = [
  {
    kind: 'data',
    label: 'SLA compliance',
    href: '/dashboard/ceo',
    text: 'SLA compliance: 90% (period before 95%; from 40 samples).',
  },
  {
    kind: 'incident',
    label: 'INC-3',
    href: '/incidents?incident=abc',
    text: 'INC-3 "Login errors" (SEV2, investigating) no root cause recorded.',
  },
  {
    kind: 'data',
    label: 'intent: login_issue',
    text: 'Intent login_issue: 9 tickets in this period (4 in the period before).',
  },
  {
    kind: 'ticket',
    label: 'OPS-12',
    href: '/?ticket=OPS-12',
    text: 'OPS-12 "Cannot sign in, mail jane@customer.example" (intent login_issue, open).',
  },
  {
    kind: 'ticket',
    label: 'OPS-15',
    href: '/?ticket=OPS-15',
    text: 'OPS-15 "Sign-in loop" (intent login_issue, open).',
  },
];

const base = { scope: 'weekly-brief:2026-11-09', locale: 'en' as const };

const scripted = (answer: unknown) =>
  new DevMockLlmProvider({ rules: [{ promptId: 'weekly_brief', text: JSON.stringify(answer) }] });

describe('writeWeeklyBrief', () => {
  it('writes summary, root causes and decisions that cite the facts, and records the call', async () => {
    const { deps, runs } = rig();
    const outcome = await writeWeeklyBrief(deps, { ...base, facts: FACTS });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.content.summary[0]?.evidence).toEqual([
      { kind: 'data', label: 'SLA compliance', href: '/dashboard/ceo' },
    ]);
    // The intent group and the tickets after it become one root cause with all their chips.
    expect(outcome.content.rootCauses).toHaveLength(1);
    expect(outcome.content.rootCauses[0]?.claims[0]?.evidence.map((item) => item.label)).toEqual([
      'intent: login_issue',
      'OPS-12',
      'OPS-15',
    ]);
    // The open incident is a decision.
    expect(outcome.content.decisions[0]?.evidence[0]?.href).toBe('/incidents?incident=abc');
    expect(outcome.mock).toBe(true);
    expect(outcome.promptVersion).toBe(1);
    expect(outcome.runId).toBe('00000000-0000-4000-8000-000000000009');
    expect(runs.map((run) => [run.agent, run.prompt.id])).toEqual([['summarizer', 'weekly_brief']]);
  });

  it('keeps the address of a customer out of what the model reads (N4)', async () => {
    const { deps, requests } = rig();
    await writeWeeklyBrief(deps, { ...base, facts: FACTS });
    const sent = requests[0]?.messages.map((message) => message.content).join('') ?? '';
    expect(sent).toContain('OPS-12');
    expect(sent).not.toContain('jane@customer.example');
  });

  it('drops a sentence that cites nothing or cites an id that is not a fact, and counts it', async () => {
    const { deps } = rig(
      scripted({
        summary: [
          { text: 'Everything is fine.', factIds: [] },
          { text: 'Made up.', factIds: ['f99'] },
          { text: 'SLA fell to 90%.', factIds: ['f1'] },
        ],
        rootCauses: [
          { title: 'Unknown cause', text: 'Something broke.', factIds: [], ask: 'Fix it' },
        ],
        decisions: [],
      }),
    );
    const outcome = await writeWeeklyBrief(deps, { ...base, facts: FACTS });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.content.summary.map((claim) => claim.text)).toEqual(['SLA fell to 90%.']);
    expect(outcome.content.rootCauses).toEqual([]);
    expect(outcome.droppedUncited).toBe(3);
    expect(outcome.content.summary.every((claim) => !claim.uncited)).toBe(true);
  });

  it('never keeps a link the model wrote, and keeps the ask as a suggestion', async () => {
    const { deps } = rig(
      scripted({
        summary: [{ text: 'See https://evil.example/x for SLA.', factIds: ['f1'] }],
        rootCauses: [
          {
            title: 'Sign-in loop',
            text: 'Repeated sign-in tickets.',
            factIds: ['f3', 'f4'],
            ask: 'Review the session cookie.',
          },
        ],
        decisions: [],
      }),
    );
    const outcome = await writeWeeklyBrief(deps, { ...base, facts: FACTS });
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(JSON.stringify(outcome.content)).not.toContain('evil.example');
    expect(outcome.content.rootCauses[0]).toMatchObject({
      title: 'Sign-in loop',
      ask: 'Review the session cookie.',
    });
  });

  it('caps root causes at five and decisions at four', async () => {
    const { deps } = rig(
      scripted({
        summary: [],
        rootCauses: Array.from({ length: 8 }, (_, index) => ({
          title: `Cause ${String(index)}`,
          text: 'x',
          factIds: ['f3'],
        })),
        decisions: Array.from({ length: 8 }, () => ({ text: 'Decide', factIds: ['f2'] })),
      }),
    );
    const outcome = await writeWeeklyBrief(deps, { ...base, facts: FACTS });
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.content.rootCauses).toHaveLength(5);
    expect(outcome.content.decisions).toHaveLength(4);
  });

  it('makes no model call without facts', async () => {
    const { deps, requests } = rig();
    const outcome = await writeWeeklyBrief(deps, { ...base, facts: [] });
    expect(outcome).toMatchObject({ status: 'ok', runId: null });
    expect(requests).toHaveLength(0);
  });

  it('is skipped when the guard says no, and makes no call', async () => {
    const { deps, requests } = rig(new DevMockLlmProvider(), false);
    expect(await writeWeeklyBrief(deps, { ...base, facts: FACTS })).toEqual({
      status: 'skipped',
      reason: 'budget_stop',
    });
    expect(requests).toHaveLength(0);
  });

  it('fails on an answer that is not the agreed JSON', async () => {
    const { deps } = rig(
      new DevMockLlmProvider({ rules: [{ promptId: 'weekly_brief', text: 'no' }] }),
    );
    expect(await writeWeeklyBrief(deps, { ...base, facts: FACTS })).toEqual({
      status: 'failed',
      reason: 'model_output_invalid',
    });
  });

  it('asks for Thai when the brief is Thai', async () => {
    const { deps, requests } = rig();
    await writeWeeklyBrief(deps, { ...base, locale: 'th', facts: FACTS });
    expect(requests[0]?.system).toMatch(/Write in\s+Thai/);
  });
});
