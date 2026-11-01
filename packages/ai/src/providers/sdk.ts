/**
 * Glue between our ports and the Vercel AI SDK (ADR-001). Import-time and call-time facts checked
 * against `ai@7.0.159` (see ADR-008 §Network check):
 *  - importing `ai` registers no telemetry and opens no connection; telemetry integrations exist
 *    only if `registerTelemetry()` is called, and we pass `telemetry: { isEnabled: false }` anyway;
 *  - a model given as a string would resolve through the Vercel AI Gateway, so this file only ever
 *    passes model objects built by our own adapters;
 *  - every HTTP request goes through the `fetch` the adapter was constructed with.
 */
import { embedMany, generateText, type EmbeddingModel, type LanguageModel } from 'ai';

import type {
  EmbeddingRequest,
  EmbeddingResponse,
  LlmFinishReason,
  LlmRequest,
  LlmResponse,
} from '../contract.js';

/** Injected network access. `globalThis.fetch` is allowed to be passed in, never referenced here. */
export type FetchLike = typeof globalThis.fetch;

/** Used when a request sets no limit, so a missing value can never mean "as long as the model likes". */
export const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  constructor(
    readonly provider: string,
    readonly code: string,
    readonly statusCode: number | null,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    // No provider message here: it can echo the prompt. The cause keeps it for debugging.
    super(
      `Provider call failed (${provider}: ${code}${statusCode === null ? '' : ` ${String(statusCode)}`})`,
      options,
    );
  }
}

/** Thrown at construction when an adapter is not given everything it needs. */
export class ProviderConfigError extends Error {
  override readonly name = 'ProviderConfigError';
}

/**
 * A provider `baseURL` that is not the vendor default must be https and on an explicit allow-list
 * of hosts (SR106-R10): a request carries the API key and the redacted prompt, so a typo or a
 * hostile setting must not point it at an arbitrary server. Returns the URL without a trailing
 * slash. Credentials in the URL and non-default ports are refused.
 */
export function assertAllowedBaseUrl(
  provider: string,
  value: string,
  allowedHosts: readonly string[],
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderConfigError(`${provider} adapter: baseURL is not a valid URL`);
  }
  if (url.protocol !== 'https:') {
    throw new ProviderConfigError(`${provider} adapter: baseURL must use https`);
  }
  if (url.username !== '' || url.password !== '' || url.port !== '') {
    throw new ProviderConfigError(
      `${provider} adapter: baseURL must not hold credentials or a port`,
    );
  }
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.some((allowed) => allowed.toLowerCase() === host)) {
    throw new ProviderConfigError(`${provider} adapter: baseURL host is not on the allow-list`);
  }
  return url.toString().replace(/\/+$/, '');
}

export function requireNonEmpty(
  provider: string,
  field: string,
  value: string | undefined,
): string {
  if (value === undefined || value.trim() === '') {
    throw new ProviderConfigError(`${provider} adapter requires an explicit ${field}`);
  }
  return value;
}

function mapFinishReason(reason: string): LlmFinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content-filter':
      return 'content_filter';
    case 'error':
      return 'error';
    default:
      return 'other';
  }
}

function toProviderError(provider: string, error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const record = (typeof error === 'object' && error !== null ? error : {}) as {
    name?: unknown;
    statusCode?: unknown;
    isRetryable?: unknown;
  };
  const statusCode = typeof record.statusCode === 'number' ? record.statusCode : null;
  const code = typeof record.name === 'string' ? record.name : 'UnknownError';
  const retryable =
    typeof record.isRetryable === 'boolean'
      ? record.isRetryable
      : statusCode !== null && (statusCode === 429 || statusCode >= 500);
  return new ProviderError(provider, code, statusCode, retryable, { cause: error });
}

export async function generateWithSdk(
  provider: string,
  model: LanguageModel,
  request: LlmRequest,
  maxRetries: number,
): Promise<LlmResponse> {
  try {
    const result = await generateText({
      model,
      instructions: request.system,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      maxOutputTokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      temperature: request.temperature,
      abortSignal: request.abortSignal,
      maxRetries,
      telemetry: { isEnabled: false },
    });
    return {
      text: result.text,
      finishReason: mapFinishReason(result.finishReason),
      usage: {
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
      },
      model: result.finalStep.response.modelId || request.model,
    };
  } catch (error) {
    throw toProviderError(provider, error);
  }
}

export async function embedWithSdk(
  provider: string,
  model: EmbeddingModel,
  request: EmbeddingRequest,
  maxRetries: number,
): Promise<EmbeddingResponse> {
  try {
    const result = await embedMany({
      model,
      values: [...request.values],
      dimensions: request.dimensions,
      abortSignal: request.abortSignal,
      maxRetries,
      telemetry: { isEnabled: false },
    });
    return {
      embeddings: result.embeddings,
      usage: { tokens: result.usage.tokens },
      model: request.model,
    };
  } catch (error) {
    throw toProviderError(provider, error);
  }
}
