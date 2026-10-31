import { describe, expect, it } from 'vitest';

import { aiRunRecordSchema, type AiRunRecord, type AiSettings } from './contract.js';
import {
  AuditWriteError,
  createAuditedLlm,
  ProviderUnavailableError,
  type AgentCall,
} from './audited.js';
import { mockSettings } from './models.js';
import { MockLlmProvider } from './providers/mock.js';
import { ProviderError } from './providers/sdk.js';
import { createRedactor } from './redaction/redactor.js';
import { TEST_PROMPT } from './testing/requests.js';

function setup(options: { settings?: AiSettings; sinkFails?: boolean } = {}) {
  const records: AiRunRecord[] = [];
  let clock = 1_000;
  const llm = createAuditedLlm({
    settings: { load: () => Promise.resolve(options.settings ?? mockSettings()) },
    providers: {
      mock: new MockLlmProvider({ rules: [{ promptId: 'classifier', text: 'ok [EMAIL_1]' }] }),
    },
    sink: {
      record: (run) => {
        if (options.sinkFails === true) return Promise.reject(new Error('db down'));
        records.push(run);
        return Promise.resolve();
      },
    },
    now: () => (clock += 25),
  });
  const session = createRedactor().session();
  const call: AgentCall = {
    agent: 'classifier',
    prompt: TEST_PROMPT,
    system: session.redact('You classify.'),
    messages: [{ role: 'user', content: session.redact('mail me at a@b.com or 0812345678') }],
    redaction: session.report(),
    intent: 'password_reset',
    ticketId: 'T-1',
  };
  return { llm, records, call };
}

describe('createAuditedLlm', () => {
  it('writes one complete record per call', async () => {
    const { llm, records, call } = setup();
    const { response, run } = await llm.generate({ ...call, confidence: () => 0.9 });

    expect(response.text).toBe('ok [EMAIL_1]');
    expect(records).toEqual([run]);
    expect(aiRunRecordSchema.parse(run)).toEqual(run);
    expect(run).toMatchObject({
      agent: 'classifier',
      provider: 'mock',
      model: 'mock-light',
      tier: 'light',
      prompt: TEST_PROMPT,
      tools: [],
      output: 'ok [EMAIL_1]',
      confidence: 0.9,
      status: 'ok',
      errorCode: null,
      costUsd: 0,
      intent: 'password_reset',
      ticketId: 'T-1',
      redaction: { total: 2, byKind: { EMAIL: 1, PHONE: 1 } },
    });
    expect(run.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.inputTokens).toBeGreaterThan(0);
    expect(run.latencyMs).toBe(25);
    expect(new Date(run.startedAt).toISOString()).toBe(run.startedAt);
  });

  it('keeps the input and every original PII value out of the record', async () => {
    const { llm, records, call } = setup();
    await llm.generate(call);
    const stored = JSON.stringify(records);
    expect(stored).not.toContain('a@b.com');
    expect(stored).not.toContain('0812345678');
    expect(stored).not.toContain('mail me');
  });

  it('uses the tier model from settings and records cost from the price table', async () => {
    const priced = mockSettings();
    priced.prices['mock-light'] = { inputUsdPerMTok: 1000, outputUsdPerMTok: 2000 };
    const { llm, call } = setup({ settings: priced });
    const { run } = await llm.generate(call);
    const expected = (run.inputTokens * 1000 + run.outputTokens * 2000) / 1_000_000;
    expect(run.costUsd).toBeCloseTo(expected, 12);
    expect(run.costUsd).toBeGreaterThan(0);
  });

  it('records null cost (unknown) when settings have no price for the model', async () => {
    const unpriced = { ...mockSettings(), prices: {} };
    const { llm, call } = setup({ settings: unpriced });
    expect((await llm.generate(call)).run.costUsd).toBeNull();
  });

  it('lists the tools that were called', async () => {
    const { llm, call } = setup();
    const { run } = await llm.generate({
      ...call,
      toolCalls: () => [
        { name: 'kb_search', inputHash: 'x', ok: true, latencyMs: 1, errorCode: null },
        { name: 'similar_tickets', inputHash: 'y', ok: true, latencyMs: 1, errorCode: null },
      ],
    });
    expect(run.tools).toEqual(['kb_search', 'similar_tickets']);
  });

  it('records a failed provider call as an error row, then rethrows the original error', async () => {
    const records: AiRunRecord[] = [];
    const failure = new ProviderError('anthropic', 'APICallError', 529, true);
    const llm = createAuditedLlm({
      settings: {
        load: () =>
          Promise.resolve({
            ...mockSettings(),
            tiers: {
              ...mockSettings().tiers,
              light: { provider: 'anthropic' as const, model: 'fixture-light' },
            },
          }),
      },
      providers: { anthropic: { kind: 'anthropic', generate: () => Promise.reject(failure) } },
      sink: { record: (run) => (records.push(run), Promise.resolve()) },
    });
    const { call } = setup();

    await expect(llm.generate(call)).rejects.toBe(failure);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      status: 'error',
      errorCode: 'ProviderError',
      output: null,
      costUsd: null,
      provider: 'anthropic',
      model: 'fixture-light',
    });
  });

  it('records and throws when the settings name a provider that is not configured', async () => {
    const { llm, records, call } = setup({
      settings: {
        ...mockSettings(),
        tiers: { ...mockSettings().tiers, light: { provider: 'vertex', model: 'fixture-light' } },
      },
    });
    await expect(llm.generate(call)).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(records[0]).toMatchObject({ status: 'error', errorCode: 'ProviderUnavailableError' });
  });

  it('fails closed: no answer is returned when the audit row cannot be written', async () => {
    const { llm, call } = setup({ sinkFails: true });
    await expect(llm.generate(call)).rejects.toBeInstanceOf(AuditWriteError);
  });
});
