import { describe, expect, it } from 'vitest';

import { hashLlmInput } from '../hash.js';
import { buildEmbeddingRequest, buildLlmRequest, TEST_PROMPT } from '../testing/requests.js';
import { MockEmbeddingProvider, MockLlmProvider, MockNoRuleError } from './mock.js';

describe('MockLlmProvider', () => {
  it('is deterministic: same prompt id and input give the same answer', async () => {
    const provider = new MockLlmProvider();
    const { request } = buildLlmRequest('same input');
    const first = await provider.generate(request);
    const second = await provider.generate(request);
    expect(second).toEqual(first);
    expect(first.text).toMatch(/^\[mock:classifier:[0-9a-f]{8}\]$/);
    expect(first.finishReason).toBe('stop');
    expect(first.usage.inputTokens).toBeGreaterThan(0);
  });

  it('answers differently for different input and different prompt ids', async () => {
    const provider = new MockLlmProvider();
    const a = await provider.generate(buildLlmRequest('input A').request);
    const b = await provider.generate(buildLlmRequest('input B').request);
    const other = await provider.generate(
      buildLlmRequest('input A', { prompt: { ...TEST_PROMPT, id: 'summarizer' } }).request,
    );
    expect(a.text).not.toBe(b.text);
    expect(a.text).not.toBe(other.text);
  });

  it('does not depend on the model id or tier', async () => {
    const provider = new MockLlmProvider();
    const a = await provider.generate(buildLlmRequest('x', { model: 'one', tier: 'deep' }).request);
    const b = await provider.generate(
      buildLlmRequest('x', { model: 'two', tier: 'light' }).request,
    );
    expect(a.text).toBe(b.text);
  });

  it('prefers an exact (prompt, input hash) rule over a prompt-wide rule', async () => {
    const { request } = buildLlmRequest('special case');
    const provider = new MockLlmProvider({
      rules: [
        { promptId: 'classifier', text: 'generic' },
        { promptId: 'classifier', inputHash: hashLlmInput(request), text: 'exact' },
      ],
    });
    expect((await provider.generate(request)).text).toBe('exact');
    expect((await provider.generate(buildLlmRequest('other').request)).text).toBe('generic');
  });

  it('throws on an unmatched input in strict mode', async () => {
    const provider = new MockLlmProvider({ strict: true });
    await expect(provider.generate(buildLlmRequest().request)).rejects.toBeInstanceOf(
      MockNoRuleError,
    );
  });
});

describe('MockEmbeddingProvider', () => {
  it('returns deterministic unit vectors of the requested size', async () => {
    const provider = new MockEmbeddingProvider(16);
    const request = buildEmbeddingRequest(['alpha', 'beta']);
    const first = await provider.embed({ ...request, dimensions: 40 });
    const second = await provider.embed({ ...request, dimensions: 40 });
    expect(second).toEqual(first);
    expect(first.embeddings).toHaveLength(2);
    for (const vector of first.embeddings) {
      expect(vector).toHaveLength(40);
      expect(Math.hypot(...vector)).toBeCloseTo(1, 10);
    }
    expect(first.embeddings[0]).not.toEqual(first.embeddings[1]);
  });

  it('uses the default dimension', async () => {
    const response = await new MockEmbeddingProvider(8).embed(buildEmbeddingRequest(['x']));
    expect(response.embeddings[0]).toHaveLength(8);
  });
});
