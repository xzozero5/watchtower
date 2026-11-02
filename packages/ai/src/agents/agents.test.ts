import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createAuditedLlm, ProviderUnavailableError } from '../audited.js';
import type { AiRunRecord, LlmProvider, LlmRequest, LlmResponse } from '../contract.js';
import { mockSettings } from '../models.js';
import { DEFAULT_PROMPTS_DIR, loadPromptCatalog } from '../prompt-files.js';
import { parsePromptFile } from '../prompts.js';
import { DevMockLlmProvider } from '../providers/dev-mock.js';
import { ProviderError } from '../providers/sdk.js';
import { NameMatchLimitError } from '../redaction/detectors.js';
import { createRedactor, type Redactor } from '../redaction/redactor.js';
import { classifyRedacted, classifyTicket, renderIntentList } from './classify.js';
import type { AgentDeps, AiCallGuard } from './common.js';
import { summarizeTicket } from './summarize.js';

const INTENTS = [
  { key: 'access_issue', name: 'Cannot sign in or reset a password' },
  { key: 'billing_question', name: 'Invoices and payments' },
  { key: 'incident_report', name: 'Something is broken or down' },
];

const RAW_EMAIL = 'somchai.jaidee@customer.example';
const RAW_PHONE = '081-234-5678';

interface Rig {
  deps: AgentDeps;
  runs: AiRunRecord[];
  requests: LlmRequest[];
  guardCalls: number;
}

function rig(
  options: {
    guard?: AiCallGuard;
    provider?: LlmProvider;
    redactor?: Redactor;
    sinkFails?: boolean;
  } = {},
): Rig {
  const state: Rig = { deps: undefined as never, runs: [], requests: [], guardCalls: 0 };
  const inner = options.provider ?? new DevMockLlmProvider();
  const provider: LlmProvider = {
    kind: 'mock',
    generate(request) {
      state.requests.push(request);
      return inner.generate(request);
    },
  };
  state.deps = {
    llm: createAuditedLlm({
      settings: { load: () => Promise.resolve(mockSettings()) },
      providers: { mock: provider },
      sink: {
        record: (run) => {
          if (options.sinkFails === true) return Promise.reject(new Error('db down'));
          state.runs.push(run);
          return Promise.resolve({ id: '00000000-0000-4000-8000-000000000001' });
        },
      },
    }),
    redactor: options.redactor ?? createRedactor({ names: () => ['Somchai Jaidee'] }),
    prompts: loadPromptCatalog(),
    guard: options.guard ?? {
      check: () => {
        state.guardCalls += 1;
        return Promise.resolve({ allowed: true });
      },
    },
  };
  return state;
}

const TICKET = '11111111-1111-4111-8111-111111111111';

describe('prompt files', () => {
  it('loads classifier.v1 and summarizer.v1 with matching front matter and a stable hash', () => {
    const catalog = loadPromptCatalog();
    for (const id of ['classifier', 'summarizer']) {
      const prompt = catalog.latest(id);
      expect(prompt.ref).toMatchObject({ id, version: 1 });
      expect(prompt.ref.hash).toMatch(/^[0-9a-f]{64}$/);
      const text = readFileSync(join(DEFAULT_PROMPTS_DIR, `${id}.v1.md`), 'utf8');
      // The hash covers the whole file, so it matches a fresh parse and changes with any edit.
      expect(parsePromptFile(`${id}.v1.md`, text).ref.hash).toBe(prompt.ref.hash);
      expect(parsePromptFile(`${id}.v1.md`, `${text} `).ref.hash).not.toBe(prompt.ref.hash);
      expect(catalog.version(id, 1)).toBe(prompt);
    }
    expect(() => catalog.latest('nope')).toThrow();
    expect(() => catalog.version('classifier', 9)).toThrow();
  });

  it('is neutral: no organisation, address or credential in the prompt text', () => {
    for (const entry of loadPromptCatalog().list()) {
      const text = readFileSync(
        join(DEFAULT_PROMPTS_DIR, `${entry.id}.v${String(entry.version)}.md`),
        'utf8',
      );
      expect(text).not.toMatch(/https?:\/\//);
      expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);
    }
  });

  it('passes through the redactor unchanged, so the prompt the model sees is the file', () => {
    const catalog = loadPromptCatalog();
    const session = createRedactor().session({ scope: 'x' });
    const body = catalog.latest('summarizer').body;
    expect(session.redact(body)).toBe(body);
    expect(session.report().total).toBe(0);
  });
});

describe('static prompt text is not redacted (live QA 2026-11-02)', () => {
  const smoke = (): Rig =>
    rig({ redactor: createRedactor({ names: () => ['Smoke Customer', 'Smoke Org'] }) });

  it('keeps new_customer_issue verbatim although "Customer" is a dictionary name part', async () => {
    const r = smoke();
    await classifyTicket(r.deps, {
      ticketId: TICKET,
      scope: TICKET,
      channel: 'email',
      subject: 'Cannot login',
      body: 'Smoke Customer here, I forgot my password.',
      intents: INTENTS,
    });
    const system = r.requests[0]?.system ?? '';
    expect(system).toContain('new_customer_issue');
    expect(system).not.toMatch(/new_\[NAME_\d+\]_issue/);
    // The ticket text itself is still redacted.
    expect(JSON.stringify(r.requests[0]?.messages)).not.toContain('Smoke');
  });

  it('still redacts an interpolated value that holds a dictionary name', async () => {
    const r = smoke();
    await classifyTicket(r.deps, {
      ticketId: TICKET,
      scope: TICKET,
      channel: 'email',
      subject: 's',
      body: 'b',
      intents: [{ key: 'org_question', name: 'Questions from Smoke Org' }],
    });
    const system = r.requests[0]?.system ?? '';
    expect(system).toContain('org_question');
    expect(system).not.toContain('Smoke Org');
    expect(system).toMatch(/Questions from \[NAME_\d+\]/);
  });
});

describe('classifyTicket with the mock provider', () => {
  it('classifies an English sign-in problem and records an ai_run row', async () => {
    const r = rig();
    const outcome = await classifyTicket(r.deps, {
      ticketId: TICKET,
      scope: TICKET,
      channel: 'email',
      subject: 'Cannot login',
      body: 'I forgot my password and I am locked out.',
      intents: INTENTS,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.value).toMatchObject({ type: 'new_customer_issue', intentKey: 'access_issue' });
    expect(outcome.value.confidence).toBeGreaterThan(0.5);
    expect(outcome.runId).toBe('00000000-0000-4000-8000-000000000001');
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]).toMatchObject({
      agent: 'classifier',
      provider: 'mock',
      model: 'mock-light',
      status: 'ok',
      ticketId: TICKET,
      prompt: { id: 'classifier', version: 1 },
    });
    expect(r.runs[0]?.confidence).toBe(outcome.value.confidence);
  });

  it('classifies Thai text and answers in Thai', async () => {
    const r = rig();
    const outcome = await classifyTicket(r.deps, {
      ticketId: null,
      scope: 'inbound:m1',
      channel: 'line',
      subject: '',
      body: 'ระบบล่ม ใช้งานไม่ได้ตั้งแต่เช้า',
      intents: INTENTS,
    });
    expect(outcome.status === 'ok' && outcome.value.intentKey).toBe('incident_report');
    expect(outcome.status === 'ok' && /[฀-๿]/.test(outcome.value.reason)).toBe(true);
    expect(r.runs[0]?.ticketId).toBeNull();
  });

  it('answers null with low confidence when nothing fits, and ignores an unknown key', async () => {
    const r = rig();
    const none = await classifyTicket(r.deps, {
      ticketId: TICKET,
      scope: TICKET,
      channel: 'email',
      subject: 'Hello',
      body: 'Just saying hi',
      intents: INTENTS,
    });
    expect(none.status === 'ok' && none.value.intentKey).toBeNull();
    expect(none.status === 'ok' && none.value.confidence).toBeLessThan(0.5);

    const rogue: LlmProvider = {
      kind: 'mock',
      generate: (request: LlmRequest): Promise<LlmResponse> =>
        Promise.resolve({
          text: '```json\n{"type":"triage","intentKey":"made_up","confidence":0.9,"reason":"x"}\n```',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: request.model,
        }),
    };
    const unknown = await classifyTicket(rig({ provider: rogue }).deps, {
      ticketId: TICKET,
      scope: TICKET,
      channel: 'email',
      subject: 's',
      body: 'b',
      intents: INTENTS,
    });
    expect(unknown.status === 'ok' && unknown.value.intentKey).toBeNull();
  });

  it('always redacts: the provider sees placeholders, the run holds counts and no original value', async () => {
    const r = rig();
    await classifyTicket(r.deps, {
      ticketId: TICKET,
      scope: TICKET,
      channel: 'email',
      subject: `Password problem from Somchai Jaidee`,
      body: `Please call ${RAW_PHONE} or write to ${RAW_EMAIL}. My password reset failed.`,
      intents: INTENTS,
    });
    const seen = JSON.stringify(r.requests);
    for (const secret of [RAW_EMAIL, RAW_PHONE, 'Somchai', 'Jaidee']) {
      expect(seen).not.toContain(secret);
    }
    expect(seen).toContain('[EMAIL_1]');
    expect(JSON.stringify(r.runs)).not.toContain('Somchai');
    // SR106-R9: the counts are the session's own, not the caller's.
    expect(r.runs[0]?.redaction.total).toBeGreaterThanOrEqual(3);
    expect(r.runs[0]?.redaction.byKind).toMatchObject({ EMAIL: 1 });
  });

  it('shares the ticket session when given one, so a value gets the same token in both agents', async () => {
    const r = rig();
    const session = r.deps.redactor.session({ scope: TICKET });
    await classifyTicket(r.deps, {
      ticketId: TICKET,
      scope: TICKET,
      session,
      channel: 'email',
      subject: 's',
      body: `write to ${RAW_EMAIL}`,
      intents: INTENTS,
    });
    await summarizeTicket(r.deps, {
      ticketId: TICKET,
      scope: TICKET,
      session,
      subject: 's',
      turns: [{ from: 'customer', text: `write to ${RAW_EMAIL}` }],
    });
    const messages = r.requests.map((request) => request.messages[0]?.content ?? '');
    expect(messages[0]).toContain('[EMAIL_1]');
    expect(messages[1]).toContain('[EMAIL_1]');
    expect(session.report().byKind.EMAIL).toBe(2);
    expect(r.runs[1]?.redaction.byKind).toMatchObject({ EMAIL: 2 });
  });

  it('kill switch or budget stop: the guard says no, no model call and no ai_run row', async () => {
    for (const reason of ['kill_switch_on', 'budget_stop'] as const) {
      const r = rig({ guard: { check: () => Promise.resolve({ allowed: false, reason }) } });
      const outcome = await classifyTicket(r.deps, {
        ticketId: TICKET,
        scope: TICKET,
        channel: 'email',
        subject: 's',
        body: 'b',
        intents: INTENTS,
      });
      expect(outcome).toEqual({ status: 'skipped', reason });
      expect(r.requests).toHaveLength(0);
      expect(r.runs).toHaveLength(0);
    }
  });

  it('a guard that throws is a refusal', async () => {
    const r = rig({ guard: { check: () => Promise.reject(new Error('db down')) } });
    const outcome = await classifyTicket(r.deps, {
      ticketId: TICKET,
      scope: TICKET,
      channel: 'email',
      subject: 's',
      body: 'b',
      intents: INTENTS,
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'policy_denied' });
    expect(r.requests).toHaveLength(0);
  });

  it('NameMatchLimitError: no model call, skipped with name_match_limit', async () => {
    const real = createRedactor();
    const redactor: Redactor = {
      session: (options) => ({
        ...real.session(options),
        redact: () => {
          throw new NameMatchLimitError('too many name matches');
        },
      }),
    };
    const r = rig({ redactor });
    const input = {
      ticketId: TICKET,
      scope: TICKET,
      channel: 'email',
      subject: 's',
      body: 'b',
      intents: INTENTS,
    };
    expect(await classifyTicket(r.deps, input)).toEqual({
      status: 'skipped',
      reason: 'name_match_limit',
    });
    expect(
      await summarizeTicket(r.deps, {
        ticketId: TICKET,
        scope: TICKET,
        subject: 's',
        turns: [],
      }),
    ).toEqual({ status: 'skipped', reason: 'name_match_limit' });
    expect(r.requests).toHaveLength(0);
    expect(r.runs).toHaveLength(0);
  });

  it('maps provider failures to a failed outcome and still writes an error row', async () => {
    const down: LlmProvider = {
      kind: 'mock',
      generate: () =>
        Promise.reject(new ProviderError('anthropic', 'APICallError', 503, true, { cause: 'x' })),
    };
    const r = rig({ provider: down });
    const outcome = await classifyTicket(r.deps, {
      ticketId: TICKET,
      scope: TICKET,
      channel: 'email',
      subject: 's',
      body: 'b',
      intents: INTENTS,
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'provider_error' });
    expect(r.runs[0]).toMatchObject({ status: 'error', errorCode: 'ProviderError', output: null });

    const unavailable: LlmProvider = {
      kind: 'mock',
      generate: () => Promise.reject(new ProviderUnavailableError('no provider')),
    };
    const second = await classifyTicket(rig({ provider: unavailable }).deps, {
      ticketId: TICKET,
      scope: TICKET,
      channel: 'email',
      subject: 's',
      body: 'b',
      intents: INTENTS,
    });
    expect(second).toEqual({ status: 'failed', reason: 'provider_unavailable' });
  });

  it('a model answer that is not the agreed JSON is model_output_invalid, never a guess', async () => {
    const babble: LlmProvider = {
      kind: 'mock',
      generate: (request) =>
        Promise.resolve({
          text: 'Sure! I think it is billing.',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: request.model,
        }),
    };
    const outcome = await classifyTicket(rig({ provider: babble }).deps, {
      ticketId: TICKET,
      scope: TICKET,
      channel: 'email',
      subject: 's',
      body: 'b',
      intents: INTENTS,
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'model_output_invalid' });
  });

  it('withholds the answer when the audit row cannot be written (fail closed)', async () => {
    const r = rig({ sinkFails: true });
    await expect(
      classifyTicket(r.deps, {
        ticketId: TICKET,
        scope: TICKET,
        channel: 'email',
        subject: 's',
        body: 'b',
        intents: INTENTS,
      }),
    ).rejects.toThrow(/ai_run/);
  });

  it('classifyRedacted takes text that is already redacted and does not escape its placeholders twice', async () => {
    const r = rig();
    const session = r.deps.redactor.session({ scope: 'inbound:x' });
    const outcome = await classifyRedacted(r.deps, {
      ticketId: null,
      session,
      channel: 'email',
      subject: session.redact('Password reset'),
      body: session.redact(`reset it, then write to ${RAW_EMAIL}`),
      intents: INTENTS,
    });
    expect(outcome.status === 'ok' && outcome.value.intentKey).toBe('access_issue');
    const sent = r.requests[0]?.messages[0]?.content ?? '';
    expect(sent).toContain('[EMAIL_1]');
    expect(sent).not.toContain('LITERAL');
    expect(sent).not.toContain(RAW_EMAIL);
    expect(r.runs[0]?.redaction.byKind).toMatchObject({ EMAIL: 1 });
  });

  it('renders the intent list in the shape the prompt promises', () => {
    expect(renderIntentList(INTENTS).split('\n')[0]).toBe(
      '* access_issue: Cannot sign in or reset a password',
    );
    expect(renderIntentList([])).toContain('null');
  });
});

describe('summarizeTicket with the mock provider', () => {
  it('summarizes an English ticket and suggests replying', async () => {
    const r = rig();
    const outcome = await summarizeTicket(r.deps, {
      ticketId: TICKET,
      scope: TICKET,
      subject: 'Invoice is wrong',
      turns: [{ from: 'customer', text: 'The invoice for last month shows the wrong amount.' }],
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.value.summary).toBe('The invoice for last month shows the wrong amount.');
    expect(outcome.value.nextStep.kind).toBe('reply');
    expect(r.runs[0]).toMatchObject({ agent: 'summarizer', tier: 'light', model: 'mock-light' });
  });

  it('answers in Thai for a Thai ticket and waits when staff spoke last', async () => {
    const r = rig();
    const outcome = await summarizeTicket(r.deps, {
      ticketId: TICKET,
      scope: TICKET,
      subject: 'ขอรายงาน',
      turns: [
        { from: 'customer', text: 'ขอรายงานยอดขายประจำเดือน' },
        { from: 'staff', text: 'รบกวนแจ้งช่วงเวลาที่ต้องการครับ' },
      ],
    });
    expect(outcome.status === 'ok' && outcome.value.nextStep.kind).toBe('wait_customer');
    expect(outcome.status === 'ok' && /[฀-๿]/.test(outcome.value.nextStep.label)).toBe(true);
  });

  it('is deterministic: the same input gives the same answer', async () => {
    const input = {
      ticketId: TICKET,
      scope: TICKET,
      subject: 'Error 500',
      turns: [{ from: 'customer' as const, text: 'The page shows an error since this morning.' }],
    };
    const a = await summarizeTicket(rig().deps, input);
    const b = await summarizeTicket(rig().deps, input);
    expect(a).toEqual(b);
  });

  it('restores placeholders for staff in the stored summary, but the run keeps the redacted form', async () => {
    const r = rig();
    const outcome = await summarizeTicket(r.deps, {
      ticketId: TICKET,
      scope: TICKET,
      subject: 'Contact',
      turns: [{ from: 'customer', text: `Please write to ${RAW_EMAIL} about the invoice.` }],
    });
    expect(outcome.status === 'ok' && outcome.value.summary).toContain(RAW_EMAIL);
    expect(JSON.stringify(r.runs)).not.toContain(RAW_EMAIL);
    expect(r.runs[0]?.output).toContain('[EMAIL_1]');
  });

  it('keeps the start and the latest turns of a long thread, and never sends raw PII', async () => {
    const r = rig();
    const turns = Array.from({ length: 40 }, (_, index) => ({
      from: 'customer' as const,
      text: `turn ${String(index)} ${RAW_PHONE}`,
    }));
    await summarizeTicket(r.deps, { ticketId: TICKET, scope: TICKET, subject: 's', turns });
    const sent = r.requests[0]?.messages[0]?.content ?? '';
    expect(sent).toContain('turn 0 ');
    expect(sent).toContain('turn 39 ');
    expect(sent).not.toContain('turn 20 ');
    expect(sent).not.toContain(RAW_PHONE);
  });

  it('guard refusal: no call', async () => {
    const r = rig({
      guard: { check: () => Promise.resolve({ allowed: false, reason: 'kill_switch_on' }) },
    });
    const outcome = await summarizeTicket(r.deps, {
      ticketId: TICKET,
      scope: TICKET,
      subject: 's',
      turns: [],
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'kill_switch_on' });
    expect(r.requests).toHaveLength(0);
  });
});
