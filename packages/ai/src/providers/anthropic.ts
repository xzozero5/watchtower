import { createAnthropic } from '@ai-sdk/anthropic';

import type { LlmProvider, LlmRequest, LlmResponse } from '../contract.js';
import { generateWithSdk, ProviderConfigError, requireNonEmpty, type FetchLike } from './sdk.js';

export interface AnthropicProviderConfig {
  /** Must be passed in; the adapter never reads the environment. */
  apiKey: string;
  /** Injected network access. Tests pass a fixture replayer. */
  fetch: FetchLike;
  /** Defaults to the public API. Set only for a proxy or a test double. */
  baseURL?: string;
  /** Retries inside the SDK (429/5xx). Default 2. */
  maxRetries?: number;
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1';

/**
 * Anthropic Messages API behind `LlmProvider`. Construction fails without an explicit key and
 * `fetch`: nothing falls back to `ANTHROPIC_API_KEY` or `ANTHROPIC_BASE_URL` in the environment,
 * because the base URL is always passed explicitly.
 */
export function createAnthropicProvider(config: AnthropicProviderConfig): LlmProvider {
  const apiKey = requireNonEmpty('anthropic', 'apiKey', config.apiKey);
  if (typeof config.fetch !== 'function') {
    throw new ProviderConfigError('anthropic adapter requires an injected fetch');
  }
  const sdk = createAnthropic({
    apiKey,
    baseURL: config.baseURL ?? ANTHROPIC_API_URL,
    fetch: config.fetch,
  });
  const maxRetries = config.maxRetries ?? 2;

  return {
    kind: 'anthropic',
    generate(request: LlmRequest): Promise<LlmResponse> {
      return generateWithSdk('anthropic', sdk.languageModel(request.model), request, maxRetries);
    },
  };
}
