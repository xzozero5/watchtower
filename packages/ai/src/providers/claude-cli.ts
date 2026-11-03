import { z } from 'zod';

import type { LlmFinishReason, LlmProvider, LlmRequest, LlmResponse } from '../contract.js';
import { ProviderConfigError, ProviderError, requireNonEmpty, type FetchLike } from './sdk.js';

export interface CliBridgeProviderConfig {
  /** Must be passed in; the adapter never reads the environment. */
  bridgeUrl: string;
  /** Bearer token the bridge requires (`CLAUDE_CLI_BRIDGE_TOKEN`). */
  token: string;
  /** Injected network access. Tests pass a fake. */
  fetch: FetchLike;
  /** Per-call timeout, a little above the bridge's own. Default 190 s. */
  timeoutMs?: number;
}

/** Where the bridge may run: this machine, or the Docker Desktop alias of it. Nothing else. */
const BRIDGE_HOSTS = [
  'localhost',
  '127.0.0.1',
  '[::1]',
  'host.docker.internal',
  // The compose service of the long-running bridge container (ADR-019); resolves only inside the network.
  'claude-bridge',
] as const;
const DEFAULT_TIMEOUT_MS = 190_000;
const PROVIDER = 'claude-cli';

const bridgeResponseSchema = z.object({
  text: z.string(),
  model: z.string().min(1).optional(),
  finishReason: z.enum(['stop', 'length', 'content_filter', 'error', 'other']).optional(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
});

function bridgeEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderConfigError('claude-cli adapter: bridgeUrl is not a valid URL');
  }
  if (url.protocol !== 'http:') {
    throw new ProviderConfigError(
      'claude-cli adapter: bridgeUrl must use http (this machine or the compose network only)',
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new ProviderConfigError('claude-cli adapter: bridgeUrl must not hold credentials');
  }
  if (!(BRIDGE_HOSTS as readonly string[]).includes(url.hostname.toLowerCase())) {
    throw new ProviderConfigError(
      'claude-cli adapter: bridgeUrl host must be localhost, 127.0.0.1, [::1], host.docker.internal or claude-bridge',
    );
  }
  return `${url.origin}/v1/generate`;
}

/**
 * Dev/POC provider (ADR-017): sends the already redacted request to the host-side bridge, which runs
 * the owner's local `claude -p` with every tool disabled. The model is plain text in, text out, so
 * the agents' code-driven runbooks (ADR-013) work unchanged; native tool_use is not offered and
 * `LlmRequest` has no field that could ask for it.
 *
 * Usage comes from the CLI's own report. The owner pays by subscription, so the prices configured
 * for this kind are normally 0 and `costUsd` in `ai_run` is 0 (not a real bill).
 */
export function createCliBridgeProvider(config: CliBridgeProviderConfig): LlmProvider {
  const token = requireNonEmpty(PROVIDER, 'token', config.token);
  if (typeof config.fetch !== 'function') {
    throw new ProviderConfigError('claude-cli adapter requires an injected fetch');
  }
  const endpoint = bridgeEndpoint(requireNonEmpty(PROVIDER, 'bridgeUrl', config.bridgeUrl));
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    kind: 'claude-cli',
    async generate(request: LlmRequest): Promise<LlmResponse> {
      const signals = [AbortSignal.timeout(timeoutMs)];
      if (request.abortSignal !== undefined) signals.push(request.abortSignal);
      let response: Response;
      try {
        response = await config.fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({
            model: request.model,
            system: request.system,
            messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
            ...(request.maxOutputTokens === undefined
              ? {}
              : { maxOutputTokens: request.maxOutputTokens }),
          }),
          signal: AbortSignal.any(signals),
        });
      } catch (error) {
        // Not reachable, refused, aborted or timed out. The cause keeps the detail for debugging.
        throw new ProviderError(PROVIDER, 'BridgeUnreachable', null, true, { cause: error });
      }
      if (!response.ok) {
        let code = 'BridgeError';
        try {
          const body = (await response.json()) as { error?: unknown };
          if (typeof body.error === 'string' && /^[a-z_]{1,40}$/.test(body.error)) {
            code = body.error;
          }
        } catch {
          // keep the generic code
        }
        const status = response.status;
        throw new ProviderError(PROVIDER, code, status, status === 429 || status >= 500);
      }
      let parsed: z.infer<typeof bridgeResponseSchema>;
      try {
        parsed = bridgeResponseSchema.parse(await response.json());
      } catch (error) {
        throw new ProviderError(PROVIDER, 'BadBridgeResponse', response.status, false, {
          cause: error,
        });
      }
      const finishReason: LlmFinishReason = parsed.finishReason ?? 'stop';
      return {
        text: parsed.text,
        finishReason,
        usage: parsed.usage,
        model: parsed.model ?? request.model,
      };
    },
  };
}
