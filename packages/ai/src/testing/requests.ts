import type { EmbeddingRequest, LlmRequest, PromptRef } from '../contract.js';
import { createRedactor } from '../redaction/redactor.js';

export const TEST_PROMPT: PromptRef = {
  id: 'classifier',
  version: 1,
  hash: 'a'.repeat(64),
};

/** Builds requests the legitimate way: through the redactor. */
export function buildLlmRequest(
  rawUserText = 'Hello from Somchai, reach me at somchai@example.com',
  overrides: Partial<Omit<LlmRequest, 'system' | 'messages'>> = {},
): { request: LlmRequest; restore: (text: string) => string } {
  const session = createRedactor({ names: () => ['Somchai'] }).session({ scope: 'ticket:test' });
  const request: LlmRequest = {
    model: 'fixture-model-standard',
    tier: 'standard',
    prompt: TEST_PROMPT,
    system: session.redact('You classify support tickets.'),
    messages: [{ role: 'user', content: session.redact(rawUserText) }],
    ...overrides,
  };
  return { request, restore: (text) => session.restore(text).text };
}

export function buildEmbeddingRequest(
  values: readonly string[],
  model = 'fixture-embedding',
): EmbeddingRequest {
  const session = createRedactor().session({ scope: 'ticket:test' });
  return { model, values: values.map((value) => session.redact(value)) };
}
