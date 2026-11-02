import {
  ProviderConfigError,
  ProviderUnavailableError,
  createAnthropicProvider,
  createCliBridgeProvider,
  createVertexProvider,
  type AiSettings,
  type FetchLike,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from '@watchtower/ai';

import type { WorkerLogger } from '../logger.js';
import { UNCONFIGURED_MODEL } from './settings.js';

/** What the `ai` integration holds (environment first, then the credential store; ADR-012). */
export interface AiCredentials {
  readonly anthropicApiKey?: string;
  readonly vertexProjectId?: string;
  readonly vertexLocation?: string;
}

/** Read on every call, so a key saved after boot is used without a restart. */
export interface AiCredentialReader {
  read(): Promise<AiCredentials>;
}

export interface LiveProviderOptions {
  readonly kind: 'anthropic' | 'vertex' | 'claude-cli';
  readonly settings: AiSettings;
  readonly credentials: AiCredentialReader;
  /** The only network access. Production passes the process `fetch`; tests pass a fixture replayer. */
  readonly fetch: FetchLike;
  /** Vertex only: an OAuth access token for the project. Absent: Vertex calls are refused. */
  readonly vertexAccessToken?: () => Promise<string>;
  /** claude-cli only (ADR-017): the host-side bridge. Dev/POC; the config refuses it in production. */
  readonly claudeCli?: { readonly bridgeUrl?: string; readonly token?: string };
  readonly logger: WorkerLogger;
  readonly now?: () => number;
}

const LOG_EVERY_MS = 60_000;

/**
 * The provider for `AI_PROVIDER=anthropic|vertex|claude-cli` (T-132, ADR-017): the existing adapter of `@watchtower/ai`,
 * built from the credentials on each call. It sits behind `createAuditedLlm`, so redaction
 * (`RedactedText`), the `ai_run` row, the daily caps and the kill switch apply exactly as for mock.
 *
 * Whatever is missing makes the call fail with `ProviderUnavailableError` (the agents report
 * `provider_unavailable`, the audit row says so, the brief job retries, ingestion uses rules). It
 * never answers from a mock and never reads a credential from anywhere but the injected reader.
 */
export function createLiveProvider(options: LiveProviderOptions): LlmProvider {
  const now = options.now ?? Date.now;
  let lastLogged = Number.NEGATIVE_INFINITY;
  let cached: { id: string; provider: LlmProvider } | undefined;

  const refuse = (reason: string): never => {
    const at = now();
    if (at - lastLogged >= LOG_EVERY_MS) {
      lastLogged = at;
      options.logger.error(
        { provider: options.kind, reason },
        'AI provider is selected but cannot be called: the call is refused, nothing is sent',
      );
    }
    throw new ProviderUnavailableError(`${options.kind}: ${reason}`);
  };

  const adapterFor = async (): Promise<LlmProvider> => {
    let credentials: AiCredentials;
    try {
      credentials = await options.credentials.read();
    } catch {
      return refuse('the credential store could not be read');
    }
    let id: string;
    let build: () => LlmProvider;
    if (options.kind === 'anthropic') {
      const apiKey = credentials.anthropicApiKey;
      if (apiKey === undefined || apiKey.trim() === '') return refuse('no API key is configured');
      id = `anthropic\n${apiKey}`;
      build = () => createAnthropicProvider({ apiKey, fetch: options.fetch });
    } else if (options.kind === 'claude-cli') {
      const bridgeUrl = options.claudeCli?.bridgeUrl;
      const token = options.claudeCli?.token;
      if (bridgeUrl === undefined || bridgeUrl.trim() === '') {
        return refuse('CLAUDE_CLI_BRIDGE_URL is not set');
      }
      if (token === undefined || token.trim() === '') {
        return refuse('CLAUDE_CLI_BRIDGE_TOKEN is not set');
      }
      id = `claude-cli
${bridgeUrl}
${token}`;
      build = () => createCliBridgeProvider({ bridgeUrl, token, fetch: options.fetch });
    } else {
      const project = credentials.vertexProjectId;
      const location = credentials.vertexLocation;
      const getAccessToken = options.vertexAccessToken;
      if (project === undefined || location === undefined) {
        return refuse('the Vertex project or location is not configured');
      }
      if (getAccessToken === undefined) {
        return refuse('no Vertex access token source is wired in the worker');
      }
      id = `vertex\n${project}\n${location}`;
      build = () =>
        createVertexProvider({
          auth: { kind: 'accessToken', project, location, getAccessToken },
          fetch: options.fetch,
        });
    }
    if (cached?.id === id) return cached.provider;
    try {
      const provider = build();
      cached = { id, provider };
      return provider;
    } catch (error) {
      // The message of a config error never holds a value; anything else is not trusted to be safe.
      return refuse(
        error instanceof ProviderConfigError ? error.message : 'the adapter could not be built',
      );
    }
  };

  return {
    kind: options.kind,
    async generate(request: LlmRequest): Promise<LlmResponse> {
      if (request.model === UNCONFIGURED_MODEL) {
        return refuse(`no model id is configured for the ${request.tier} tier`);
      }
      // The daily cost cap sums the cost of each call: a call that cannot be priced is refused
      // instead of being counted as free.
      if (!Object.hasOwn(options.settings.prices, request.model)) {
        return refuse(`no price is configured for the ${request.tier} tier model`);
      }
      const adapter = await adapterFor();
      return adapter.generate(request);
    },
  };
}
