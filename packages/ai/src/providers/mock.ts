import { hashLlmInput, sha256Hex } from '../hash.js';
import type {
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
  LlmProvider,
  LlmRequest,
  LlmResponse,
} from '../contract.js';

export interface MockRule {
  promptId: string;
  /** Matches one exact input; omit to answer every input for the prompt. */
  inputHash?: string;
  text: string;
}

export interface MockLlmOptions {
  rules?: readonly MockRule[];
  /** Throw when nothing matches, instead of the deterministic placeholder answer. */
  strict?: boolean;
}

export class MockNoRuleError extends Error {
  override readonly name = 'MockNoRuleError';
}

/** About 4 characters per token, as a stable stand-in for a tokenizer. */
function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Deterministic provider for `AI_PROVIDER=mock`, tests and e2e. The answer depends only on the
 * prompt id and the hash of the input: an exact (prompt, input) rule wins, then a prompt-wide
 * rule, then a placeholder that names the prompt and the first 8 hex digits of the hash. It never
 * opens a socket.
 */
export class MockLlmProvider implements LlmProvider {
  readonly kind = 'mock';
  private readonly exact = new Map<string, string>();
  private readonly byPrompt = new Map<string, string>();

  constructor(private readonly options: MockLlmOptions = {}) {
    for (const rule of options.rules ?? []) {
      if (rule.inputHash === undefined) this.byPrompt.set(rule.promptId, rule.text);
      else this.exact.set(`${rule.promptId}\u0000${rule.inputHash}`, rule.text);
    }
  }

  generate(request: LlmRequest): Promise<LlmResponse> {
    try {
      const inputHash = hashLlmInput(request);
      const text =
        this.exact.get(`${request.prompt.id}\u0000${inputHash}`) ??
        this.byPrompt.get(request.prompt.id) ??
        this.fallback(request, inputHash);

      const input = request.system + request.messages.map((message) => message.content).join('');
      return Promise.resolve({
        text,
        finishReason: 'stop',
        usage: { inputTokens: approxTokens(input), outputTokens: approxTokens(text) },
        model: request.model,
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fallback(request: LlmRequest, inputHash: string): string {
    if (this.options.strict === true) {
      throw new MockNoRuleError(
        `No mock rule for prompt ${request.prompt.id} with input hash ${inputHash.slice(0, 8)}`,
      );
    }
    return `[mock:${request.prompt.id}:${inputHash.slice(0, 8)}]`;
  }
}

/** Deterministic unit-length vectors derived from sha256 of each input. */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'mock';

  constructor(private readonly defaultDimensions = 16) {}

  embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const dimensions = request.dimensions ?? this.defaultDimensions;
    const embeddings = request.values.map((value) => this.vector(value, dimensions));
    const tokens = request.values.reduce((sum, value) => sum + approxTokens(value), 0);
    return Promise.resolve({ embeddings, usage: { tokens }, model: request.model });
  }

  private vector(value: string, dimensions: number): number[] {
    const raw: number[] = [];
    for (let block = 0; raw.length < dimensions; block += 1) {
      const digest = sha256Hex(`${String(block)}\u0000${value}`);
      for (let index = 0; index + 4 <= digest.length && raw.length < dimensions; index += 4) {
        raw.push(parseInt(digest.slice(index, index + 4), 16) / 0xffff - 0.5);
      }
    }
    const norm = Math.sqrt(raw.reduce((sum, item) => sum + item * item, 0)) || 1;
    return raw.map((item) => item / norm);
  }
}
