import { describe, expect, it } from 'vitest';

import { AuditWriteError, ProviderUnavailableError } from './audited.js';
import {
  createAuditedEmbedder,
  EmbeddingShapeError,
  type AuditedEmbedderDeps,
} from './audited-embedding.js';
import {
  aiRunRecordSchema,
  type AiRunRecord,
  type EmbeddingProvider,
  type EmbeddingRequest,
} from './contract.js';
import { mockSettings } from './models.js';
import { MockEmbeddingProvider } from './providers/mock.js';
import { createRedactor } from './redaction/redactor.js';

function setup(
  options: {
    provider?: EmbeddingProvider;
    allowed?: boolean;
    sinkFails?: boolean;
    withPrice?: boolean;
  } = {},
) {
  const records: AiRunRecord[] = [];
  const requests: EmbeddingRequest[] = [];
  const mock = new MockEmbeddingProvider();
  const provider: EmbeddingProvider = options.provider ?? {
    kind: 'mock',
    embed: (request) => {
      requests.push(request);
      return mock.embed(request);
    },
  };
  const settings = mockSettings();
  if (options.withPrice === true) {
    settings.prices['mock-embedding'] = { inputUsdPerMTok: 2, outputUsdPerMTok: 0 };
  }
  let clock = 1_000;
  const deps: AuditedEmbedderDeps = {
    settings: { load: () => Promise.resolve(settings) },
    providers: { mock: provider },
    sink: {
      record: (run) => {
        if (options.sinkFails === true) return Promise.reject(new Error('db down'));
        records.push(run);
        return Promise.resolve({ id: '00000000-0000-4000-8000-000000000001' });
      },
    },
    redactor: createRedactor(),
    guard: {
      check: () =>
        Promise.resolve(
          options.allowed === false
            ? ({ allowed: false, reason: 'kill_switch_on' } as const)
            : ({ allowed: true } as const),
        ),
    },
    now: () => (clock += 10),
  };
  return { embedder: createAuditedEmbedder(deps), records, requests };
}

const CALL = { scope: 'kb:test', action: 'kb_index' } as const;

describe('createAuditedEmbedder', () => {
  it('embeds with the configured model and dimensions and writes one valid ai_run record', async () => {
    const { embedder, records } = setup({ withPrice: true });
    const outcome = await embedder.embed({ ...CALL, texts: ['reset a password', 'rotate a key'] });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.embeddings).toHaveLength(2);
    expect(outcome.embeddings.every((vector) => vector.length === 16)).toBe(true);
    expect(outcome).toMatchObject({
      provider: 'mock',
      model: 'mock-embedding',
      dimensions: 16,
      runId: '00000000-0000-4000-8000-000000000001',
    });
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(aiRunRecordSchema.safeParse(record).success).toBe(true);
    expect(record).toMatchObject({
      agent: 'embedder',
      provider: 'mock',
      model: 'mock-embedding',
      status: 'ok',
      output: null,
      outputTokens: 0,
      tools: [],
    });
    expect(record?.inputTokens).toBeGreaterThan(0);
    expect(record?.costUsd).toBeGreaterThan(0);
    expect(record?.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports an unknown cost as null, not zero', async () => {
    const { embedder, records } = setup();
    await embedder.embed({ ...CALL, texts: ['hello'] });
    expect(records[0]?.costUsd).toBeNull();
  });

  it('redacts PII before the provider sees the text, and counts it in the record (N4)', async () => {
    const { embedder, records, requests } = setup();
    await embedder.embed({
      ...CALL,
      texts: ['Contact somchai@example.com or 0812345678 for the reset'],
    });
    const sent = requests[0]?.values.join('\n') ?? '';
    expect(sent).not.toContain('somchai@example.com');
    expect(sent).not.toContain('0812345678');
    expect(sent).toContain('[EMAIL_1]');
    expect(records[0]?.redaction.total).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(records[0])).not.toContain('somchai@example.com');
  });

  it('is deterministic: the same text gives the same vector', async () => {
    const { embedder } = setup();
    const first = await embedder.embed({ ...CALL, texts: ['รีเซ็ตรหัสผ่าน'] });
    const second = await embedder.embed({ ...CALL, texts: ['รีเซ็ตรหัสผ่าน'] });
    expect(first.status).toBe('ok');
    expect(first).toEqual({ ...second, runId: expect.anything() as unknown });
  });

  it('calls nothing and writes nothing when the guard refuses (kill switch, budget)', async () => {
    const { embedder, records, requests } = setup({ allowed: false });
    const outcome = await embedder.embed({ ...CALL, texts: ['x'] });
    expect(outcome).toEqual({ status: 'skipped', reason: 'kill_switch_on' });
    expect(requests).toHaveLength(0);
    expect(records).toHaveLength(0);
  });

  it('treats a guard that throws as a refusal', async () => {
    const records: AiRunRecord[] = [];
    const embedder = createAuditedEmbedder({
      settings: { load: () => Promise.resolve(mockSettings()) },
      providers: { mock: new MockEmbeddingProvider() },
      sink: { record: (run) => (records.push(run), Promise.resolve()) },
      redactor: createRedactor(),
      guard: { check: () => Promise.reject(new Error('gate down')) },
    });
    const outcome = await embedder.embed({ ...CALL, texts: ['x'] });
    expect(outcome.status).toBe('skipped');
    expect(records).toHaveLength(0);
  });

  it('writes an error row and rethrows when the provider fails', async () => {
    const failing: EmbeddingProvider = {
      kind: 'mock',
      embed: () => Promise.reject(new TypeError('boom with private detail')),
    };
    const { embedder, records } = setup({ provider: failing });
    await expect(embedder.embed({ ...CALL, texts: ['x'] })).rejects.toThrow('boom');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'error', errorCode: 'TypeError', costUsd: null });
    expect(JSON.stringify(records[0])).not.toContain('private detail');
  });

  it('writes an error row when the provider is not configured', async () => {
    const records: AiRunRecord[] = [];
    const embedder = createAuditedEmbedder({
      settings: { load: () => Promise.resolve(mockSettings()) },
      providers: {},
      sink: { record: (run) => (records.push(run), Promise.resolve()) },
      redactor: createRedactor(),
      guard: { check: () => Promise.resolve({ allowed: true }) },
    });
    await expect(embedder.embed({ ...CALL, texts: ['x'] })).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    expect(records[0]).toMatchObject({ status: 'error', errorCode: 'ProviderUnavailableError' });
  });

  it('refuses vectors of the wrong size or count, with an error row', async () => {
    const bad: number[][][] = [[[1, 2, 3]], [], [Array.from({ length: 16 }, () => Number.NaN)]];
    for (const embeddings of bad) {
      const provider: EmbeddingProvider = {
        kind: 'mock',
        embed: () => Promise.resolve({ embeddings, usage: { tokens: 3 }, model: 'mock-embedding' }),
      };
      const { embedder, records } = setup({ provider });
      await expect(embedder.embed({ ...CALL, texts: ['x'] })).rejects.toBeInstanceOf(
        EmbeddingShapeError,
      );
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ status: 'error', errorCode: 'EmbeddingShapeError' });
    }
  });

  it('fails closed when the audit row cannot be written: no vectors are returned', async () => {
    const { embedder } = setup({ sinkFails: true });
    await expect(embedder.embed({ ...CALL, texts: ['x'] })).rejects.toBeInstanceOf(AuditWriteError);
  });

  it('refuses an empty batch', async () => {
    const { embedder } = setup();
    await expect(embedder.embed({ ...CALL, texts: [] })).rejects.toThrow();
  });

  it('does not compile a call that hands plain text to the provider port', () => {
    const provider = new MockEmbeddingProvider();
    // @ts-expect-error a plain string is not RedactedText
    void provider.embed({ model: 'm', values: ['plain'] });
    expect(true).toBe(true);
  });
});
