import { describe, expect, it } from 'vitest';

import {
  aiRunRecordSchema,
  aiSettingsSchema,
  type AiRunRecord,
  type AiSettings,
  type LlmProvider,
  type LlmResponse,
} from './contract.js';
import { createHmac } from 'node:crypto';
import { canonicalJson, sha256Hex } from './hash.js';
import {
  AuditInputError,
  AuditRecordError,
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
import { ALLOW_ALL_GUARD } from './test-guard.js';

function setup(options: { settings?: AiSettings; sinkFails?: boolean } = {}) {
  const records: AiRunRecord[] = [];
  let clock = 1_000;
  const llm = createAuditedLlm({
    guard: ALLOW_ALL_GUARD,
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
  const session = createRedactor().session({ scope: 'ticket:test' });
  const call: AgentCall = {
    agent: 'classifier',
    prompt: TEST_PROMPT,
    system: session.redact('You classify.'),
    messages: [{ role: 'user', content: session.redact('mail me at a@b.com or 0812345678') }],
    redaction: session,
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

  it('records the model id the provider answered with next to the alias of the settings (T-306e C-11)', async () => {
    const { call } = setup();
    const records: AiRunRecord[] = [];
    const answering = (model: unknown): LlmProvider => ({
      kind: 'mock',
      generate: () =>
        Promise.resolve({
          text: 'ok',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
          model,
        } as LlmResponse),
    });
    const run = async (model: unknown) => {
      const llm = createAuditedLlm({
        guard: ALLOW_ALL_GUARD,
        settings: { load: () => Promise.resolve(mockSettings()) },
        providers: { mock: answering(model) },
        sink: {
          record: (record) => {
            records.push(record);
            return Promise.resolve();
          },
        },
      });
      return (await llm.generate(call)).run;
    };
    expect(await run('dated-model-id-20260101')).toMatchObject({
      model: 'mock-light',
      responseModel: 'dated-model-id-20260101',
    });
    // Nothing reported (or something that is not a model id): null, never the alias passed off as an answer.
    expect((await run(undefined)).responseModel).toBeNull();
    expect((await run('')).responseModel).toBeNull();
    expect((await run(42)).responseModel).toBeNull();
    expect((await run('x'.repeat(201))).responseModel).toBeNull();
    expect(records).toHaveLength(5);
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
      guard: ALLOW_ALL_GUARD,
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

// R-1: the provider call count and the audit row count must agree on every path.
describe('createAuditedLlm: one audit row per provider call, on every path', () => {
  const okResponse: LlmResponse = {
    text: 'fine',
    finishReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 5 },
    model: 'mock-light',
  };

  function counted(options: { respond?: () => Promise<LlmResponse>; sinkFails?: boolean } = {}) {
    const rows: AiRunRecord[] = [];
    const sinkAttempts: AiRunRecord[] = [];
    let providerCalls = 0;
    const provider: LlmProvider = {
      kind: 'mock',
      generate: () => {
        providerCalls += 1;
        return options.respond?.() ?? Promise.resolve(okResponse);
      },
    };
    const llm = createAuditedLlm({
      guard: ALLOW_ALL_GUARD,
      settings: { load: () => Promise.resolve(mockSettings()) },
      providers: { mock: provider },
      sink: {
        record: (run) => {
          sinkAttempts.push(run);
          if (options.sinkFails === true) return Promise.reject(new Error('db down'));
          rows.push(run);
          return Promise.resolve();
        },
      },
    });
    const { call } = setup();
    return {
      llm,
      call,
      rows,
      sinkAttempts,
      providerCalls: () => providerCalls,
    };
  }

  it('malformed prompt hash: fails before the provider is called, nothing to audit', async () => {
    const t = counted();
    const bad = { ...t.call, prompt: { ...t.call.prompt, hash: 'not-a-hash' } };
    await expect(t.llm.generate(bad)).rejects.toBeInstanceOf(AuditInputError);
    expect(t.providerCalls()).toBe(0);
    expect(t.sinkAttempts).toHaveLength(0);
  });

  it.each([
    ['prompt version 0', { prompt: { id: 'classifier', version: 0, hash: 'a'.repeat(64) } }],
    ['prompt id with spaces', { prompt: { id: 'Bad Id', version: 1, hash: 'a'.repeat(64) } }],
    ['negative redaction total', { redaction: { report: () => ({ total: -1, byKind: {} }) } }],
  ])('%s: fails before the provider is called', async (_name, patch) => {
    const t = counted();
    await expect(t.llm.generate({ ...t.call, ...patch })).rejects.toBeInstanceOf(AuditInputError);
    expect(t.providerCalls()).toBe(0);
    expect(t.sinkAttempts).toHaveLength(0);
  });

  it.each([
    ['above 1', () => 7, 1],
    ['below 0', () => -3, 0],
    ['NaN', () => Number.NaN, null],
    ['Infinity', () => Number.POSITIVE_INFINITY, null],
    ['not a number', () => 'high' as unknown as number, null],
    [
      'throws',
      () => {
        throw new Error('parse failed');
      },
      null,
    ],
  ])(
    'confidence %s: one call, one ok row, value sanitised',
    async (_name, confidence, expected) => {
      const t = counted();
      const { run } = await t.llm.generate({ ...t.call, confidence });
      expect(t.providerCalls()).toBe(1);
      expect(t.rows).toHaveLength(1);
      expect(run).toMatchObject({ status: 'ok', confidence: expected });
    },
  );

  it('toolCalls that throws: one call, one row, no tools', async () => {
    const t = counted();
    const { run } = await t.llm.generate({
      ...t.call,
      toolCalls: () => {
        throw new Error('registry gone');
      },
    });
    expect(t.providerCalls()).toBe(1);
    expect(t.rows).toHaveLength(1);
    expect(run.tools).toEqual([]);
  });

  it('odd usage numbers from a provider are sanitised, not fatal', async () => {
    const t = counted({
      respond: () =>
        Promise.resolve({ ...okResponse, usage: { inputTokens: Number.NaN, outputTokens: -4.5 } }),
    });
    const { run } = await t.llm.generate(t.call);
    expect(t.providerCalls()).toBe(1);
    expect(t.rows).toHaveLength(1);
    expect(run).toMatchObject({ inputTokens: 0, outputTokens: 0, status: 'ok' });
  });

  it('a record that is still invalid after sanitising: a minimal error row, then fail closed', async () => {
    const t = counted();
    const broken = { ...t.call, toolCalls: () => [{ name: 42 }] as never };
    await expect(t.llm.generate(broken)).rejects.toBeInstanceOf(AuditRecordError);
    expect(t.providerCalls()).toBe(1);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({
      status: 'error',
      errorCode: 'AuditRecordInvalid',
      output: null,
      tools: [],
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  // SR106-N3: the provider is third-party code; none of these may skip the audit row.
  it('a response without usage: one call, one row, cost unknown', async () => {
    const t = counted({
      respond: () => Promise.resolve({ text: 'fine', finishReason: 'stop' } as never),
    });
    const { run } = await t.llm.generate(t.call);
    expect(t.providerCalls()).toBe(1);
    expect(t.rows).toHaveLength(1);
    expect(run).toMatchObject({ inputTokens: 0, outputTokens: 0, costUsd: null, status: 'ok' });
  });

  it('a response with usage = null or non-numeric counts: one call, one row', async () => {
    for (const usage of [null, 'lots', { inputTokens: '5', outputTokens: {} }]) {
      const t = counted({
        respond: () => Promise.resolve({ ...okResponse, usage } as never),
      });
      await t.llm.generate(t.call);
      expect(t.providerCalls()).toBe(1);
      expect(t.rows).toHaveLength(1);
      expect(t.rows[0]).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    }
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'text'],
    ['a response whose text is not a string', { usage: okResponse.usage, text: 7 }],
  ])('a provider that returns %s: a minimal error row, then fail closed', async (_label, value) => {
    const t = counted({ respond: () => Promise.resolve(value as never) });
    await expect(t.llm.generate(t.call)).rejects.toBeInstanceOf(AuditRecordError);
    expect(t.providerCalls()).toBe(1);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({ status: 'error', output: null, tools: [] });
  });

  it.each([
    ['a string', 'boom'],
    ['null', null],
    ['an object without a name', { message: 'x' }],
    ['an Error whose name is a number', Object.assign(new Error('x'), { name: 42 })],
    [
      'an Error whose name getter throws',
      (() => {
        const error = new Error('x');
        Object.defineProperty(error, 'name', {
          get() {
            throw new TypeError('no name');
          },
        });
        return error;
      })(),
    ],
  ])(
    'a provider that rejects with %s: one row, original value rethrown',
    async (_label, thrown) => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point: non-Error reasons
      const t = counted({ respond: () => Promise.reject(thrown) });
      const caught = await t.llm.generate(t.call).then(
        () => 'resolved',
        (error: unknown) => error,
      );
      expect(caught).toBe(thrown);
      expect(t.providerCalls()).toBe(1);
      expect(t.rows).toHaveLength(1);
      expect(t.rows[0]).toMatchObject({ status: 'error', output: null });
      expect(typeof t.rows[0]?.errorCode).toBe('string');
    },
  );

  it('a provider that throws synchronously: one row', async () => {
    const rows: AiRunRecord[] = [];
    let providerCalls = 0;
    const llm = createAuditedLlm({
      guard: ALLOW_ALL_GUARD,
      settings: { load: () => Promise.resolve(mockSettings()) },
      providers: {
        mock: {
          kind: 'mock',
          generate: () => {
            providerCalls += 1;
            throw new RangeError('sync');
          },
        },
      },
      sink: {
        record: (run) => {
          rows.push(run);
          return Promise.resolve();
        },
      },
    });
    await expect(llm.generate(setup().call)).rejects.toBeInstanceOf(RangeError);
    expect(providerCalls).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ errorCode: 'RangeError' });
  });

  it('provider failure: one call, one error row, original error rethrown', async () => {
    const failure = new ProviderError('anthropic', 'APICallError', 500, true);
    const t = counted({ respond: () => Promise.reject(failure) });
    await expect(t.llm.generate(t.call)).rejects.toBe(failure);
    expect(t.providerCalls()).toBe(1);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({ status: 'error', errorCode: 'ProviderError' });
  });

  it('sink failure after a call: one call, one write attempt, no answer returned', async () => {
    const t = counted({ sinkFails: true });
    await expect(t.llm.generate(t.call)).rejects.toBeInstanceOf(AuditWriteError);
    expect(t.providerCalls()).toBe(1);
    expect(t.sinkAttempts).toHaveLength(1);
  });

  it('sink failure after a provider failure: both causes survive', async () => {
    const failure = new Error('upstream');
    const t = counted({ respond: () => Promise.reject(failure), sinkFails: true });
    const error = await t.llm.generate(t.call).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AuditWriteError);
    expect(((error as Error).cause as AggregateError).errors).toHaveLength(2);
    expect(t.providerCalls()).toBe(1);
  });

  it('every call is counted: N successful and failing calls leave exactly N rows', async () => {
    let n = 0;
    const t = counted({
      respond: () =>
        ++n % 3 === 0 ? Promise.reject(new Error('flaky')) : Promise.resolve(okResponse),
    });
    for (let i = 0; i < 9; i += 1) {
      await t.llm
        .generate({ ...t.call, confidence: i % 2 === 0 ? () => 99 : undefined })
        .catch(() => undefined);
    }
    expect(t.providerCalls()).toBe(9);
    expect(t.rows).toHaveLength(9);
  });
});

// R-7: the audit hash is keyed.
describe('createAuditedLlm: input hash is an HMAC with the server key', () => {
  it('equals HMAC-SHA-256 of the canonical redacted input and is not a plain sha256', async () => {
    const { llm, call } = setup();
    const { run } = await llm.generate(call);
    const canonical = canonicalJson({
      system: call.system,
      messages: call.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const key = mockSettings().inputHashKey;
    expect(run.inputHash).toBe(createHmac('sha256', key).update(canonical, 'utf8').digest('hex'));
    expect(run.inputHash).not.toBe(sha256Hex(canonical));
  });

  it('changes with the key and is stable for the same key', async () => {
    const hashWith = async (key: string): Promise<string> => {
      const { call } = setup();
      const llm = createAuditedLlm({
        guard: ALLOW_ALL_GUARD,
        settings: { load: () => Promise.resolve({ ...mockSettings(), inputHashKey: key }) },
        providers: { mock: new MockLlmProvider() },
        sink: { record: () => Promise.resolve() },
      });
      return (await llm.generate(call)).run.inputHash;
    };
    const a = await hashWith('a'.repeat(32));
    expect(await hashWith('a'.repeat(32))).toBe(a);
    expect(await hashWith('b'.repeat(32))).not.toBe(a);
  });

  it('settings without a long enough key are rejected', () => {
    expect(() => aiSettingsSchema.parse({ ...mockSettings(), inputHashKey: 'short' })).toThrow();
    expect(() => aiSettingsSchema.parse({ ...mockSettings(), inputHashKey: undefined })).toThrow();
  });
});

describe('what the record takes from the caller (SR106-R9)', () => {
  it('reads the redaction counts from the session when the call is made', async () => {
    const { llm, call } = setup();
    const session = createRedactor().session({ scope: 'ticket:r9' });
    const system = session.redact('You classify.');
    const content = session.redact('a@b.com and c@d.com');
    const { run } = await llm.generate({
      ...call,
      system,
      messages: [{ role: 'user', content }],
      redaction: session,
    });
    expect(run.redaction).toEqual({ total: 2, byKind: { EMAIL: 2 } });
  });

  it('records dictionary_incomplete when the session was told its name list is cut short (QA-30)', async () => {
    const { llm, call } = setup();
    const session = createRedactor({ dictionaryIncomplete: true }).session({ scope: 'ticket:inc' });
    const system = session.redact('You classify.');
    const content = session.redact('a@b.com');
    const { run } = await llm.generate({
      ...call,
      system,
      messages: [{ role: 'user', content }],
      redaction: session,
    });
    expect(run.redaction).toEqual({ total: 1, byKind: { EMAIL: 1, dictionary_incomplete: 1 } });
  });

  it('refuses a source that throws, before the provider is called', async () => {
    const { llm, call } = setup();
    await expect(
      llm.generate({
        ...call,
        redaction: {
          report: () => {
            throw new Error('boom');
          },
        },
      }),
    ).rejects.toBeInstanceOf(AuditInputError);
  });

  it('returns the id the sink gave the row, or null when it gives none', async () => {
    const make = (receipt: { id: string } | undefined) =>
      createAuditedLlm({
        guard: ALLOW_ALL_GUARD,
        settings: { load: () => Promise.resolve(mockSettings()) },
        providers: { mock: new MockLlmProvider() },
        sink: { record: () => Promise.resolve(receipt) },
      });
    const { call } = setup();
    expect((await make({ id: 'row-1' }).generate(call)).runId).toBe('row-1');
    expect((await make(undefined).generate(call)).runId).toBeNull();
  });
});
