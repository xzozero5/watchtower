/**
 * Vertex AI adapters (Gemini, embeddings, and Claude hosted on Vertex).
 *
 * They import `@ai-sdk/google-vertex/edge`, never the default entry. The default entry pulls in
 * `google-auth-library` and builds a `GoogleAuth` at import time, and `GoogleAuth` finds
 * credentials by application-default-credentials probing (environment, well-known file, then the
 * GCE metadata server). The edge entry has no such code path, and we hand it an explicit token
 * source, so nothing here can probe for credentials. The edge entry's own token helper uses the
 * global `fetch`, so it is never used either (see `viaBearerToken`).
 */
import { createVertex } from '@ai-sdk/google-vertex/edge';
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic/edge';

import type {
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
  LlmProvider,
  LlmRequest,
  LlmResponse,
} from '../contract.js';
import {
  embedWithSdk,
  generateWithSdk,
  ProviderConfigError,
  requireNonEmpty,
  type FetchLike,
} from './sdk.js';

/**
 * How the adapter authenticates. There is deliberately no "use whatever the environment has"
 * option. Credentials come from the caller (the composition root reads them from the encrypted
 * credential store, ADR-004).
 */
export type VertexAuth =
  /** Vertex AI express mode: a Google API key bound to a project. Gemini and embeddings only. */
  | { kind: 'apiKey'; apiKey: string }
  /** An OAuth access token from the caller's own token source (service account, workload identity). */
  | {
      kind: 'accessToken';
      project: string;
      location: string;
      getAccessToken: () => Promise<string>;
    };

export interface VertexProviderConfig {
  auth: VertexAuth;
  /** Injected network access. Tests pass a fixture replayer. */
  fetch: FetchLike;
  /** Retries inside the SDK (429/5xx). Default 2. */
  maxRetries?: number;
}

const PROJECT_ID = /^[a-z0-9][a-z0-9:.-]{2,}$/;
const LOCATION = /^[a-z0-9-]+$/;

function validate(config: VertexProviderConfig): void {
  if (typeof config.fetch !== 'function') {
    throw new ProviderConfigError('vertex adapter requires an injected fetch');
  }
  // Config often arrives from settings JSON, so check the shape at runtime, not just by type.
  const auth = config.auth as Partial<Record<string, unknown>> | undefined;
  if (typeof auth !== 'object')
    throw new ProviderConfigError('vertex adapter requires explicit auth');
  const text = (field: string): string | undefined =>
    typeof auth[field] === 'string' ? auth[field] : undefined;

  switch (auth.kind) {
    case 'apiKey':
      requireNonEmpty('vertex', 'auth.apiKey', text('apiKey'));
      return;
    case 'accessToken': {
      const project = requireNonEmpty('vertex', 'auth.project', text('project'));
      const location = requireNonEmpty('vertex', 'auth.location', text('location'));
      if (!PROJECT_ID.test(project)) {
        throw new ProviderConfigError('vertex adapter: auth.project is not a valid project id');
      }
      if (!LOCATION.test(location)) {
        throw new ProviderConfigError('vertex adapter: auth.location is not a valid location');
      }
      if (typeof auth.getAccessToken !== 'function') {
        throw new ProviderConfigError('vertex adapter requires auth.getAccessToken');
      }
      return;
    }
    default:
      throw new ProviderConfigError('vertex adapter requires auth.kind "apiKey" or "accessToken"');
  }
}

function vertexHost(location: string): string {
  if (location === 'global') return 'aiplatform.googleapis.com';
  if (location === 'eu' || location === 'us') return `aiplatform.${location}.rep.googleapis.com`;
  return `${location}-aiplatform.googleapis.com`;
}

type Headers_ = Record<string, string>;

/**
 * Sends `getAccessToken()` as a Bearer token through our injected `fetch`.
 *
 * The SDK's edge provider has two auth paths: express mode (an API key, sent through the injected
 * fetch) and service-account JWTs (token exchange through the global `fetch`, which tests cannot
 * replay and which ignores our injection). For OAuth mode we use the express path with a
 * placeholder key and swap the header here, so the only network access is the injected `fetch`.
 * `vertex.test.ts` pins the exact request that reaches `fetch`, so an SDK change fails the test.
 */
function viaBearerToken(
  config: VertexProviderConfig & { auth: { kind: 'accessToken' } },
): FetchLike {
  return async (input, init) => {
    const original = init?.headers as Headers_ | undefined;
    if (original === undefined || typeof original !== 'object' || Array.isArray(original)) {
      throw new ProviderConfigError('vertex adapter: unexpected header shape from the SDK');
    }
    const headers: Headers_ = {};
    for (const [name, value] of Object.entries(original)) {
      if (name.toLowerCase() !== 'x-goog-api-key') headers[name] = value;
    }
    headers.authorization = `Bearer ${await config.auth.getAccessToken()}`;
    return config.fetch(input, { ...init, headers });
  };
}

function geminiProvider(config: VertexProviderConfig) {
  validate(config);
  if (config.auth.kind === 'apiKey') {
    return createVertex({ apiKey: config.auth.apiKey, fetch: config.fetch });
  }
  const { project, location } = config.auth;
  return createVertex({
    apiKey: 'replaced-by-bearer-token', // never sent: viaBearerToken drops this header
    baseURL: `https://${vertexHost(location)}/v1beta1/projects/${project}/locations/${location}/publishers/google`,
    fetch: viaBearerToken(config as VertexProviderConfig & { auth: { kind: 'accessToken' } }),
  });
}

/** Gemini on Vertex AI behind `LlmProvider`. */
export function createVertexProvider(config: VertexProviderConfig): LlmProvider {
  const sdk = geminiProvider(config);
  const maxRetries = config.maxRetries ?? 2;
  return {
    kind: 'vertex',
    generate(request: LlmRequest): Promise<LlmResponse> {
      return generateWithSdk('vertex', sdk.languageModel(request.model), request, maxRetries);
    },
  };
}

/** Vertex AI text embeddings behind `EmbeddingProvider`. */
export function createVertexEmbeddingProvider(config: VertexProviderConfig): EmbeddingProvider {
  const sdk = geminiProvider(config);
  const maxRetries = config.maxRetries ?? 2;
  return {
    kind: 'vertex',
    embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
      return embedWithSdk('vertex', sdk.embeddingModel(request.model), request, maxRetries);
    },
  };
}

export interface VertexClaudeConfig {
  project: string;
  location: string;
  getAccessToken: () => Promise<string>;
  fetch: FetchLike;
  maxRetries?: number;
}

/**
 * Claude hosted on Vertex AI. Reports `kind: 'anthropic'` because it is the Anthropic provider
 * setting with Vertex as the transport (PRD §6.7).
 */
export function createVertexClaudeProvider(config: VertexClaudeConfig): LlmProvider {
  validate({
    auth: {
      kind: 'accessToken',
      project: config.project,
      location: config.location,
      getAccessToken: config.getAccessToken,
    },
    fetch: config.fetch,
  });
  const sdk = createVertexAnthropic({
    project: config.project,
    location: config.location,
    fetch: config.fetch,
    generateAuthToken: config.getAccessToken,
  });
  const maxRetries = config.maxRetries ?? 2;
  return {
    kind: 'anthropic',
    generate(request: LlmRequest): Promise<LlmResponse> {
      return generateWithSdk(
        'vertex-anthropic',
        sdk.languageModel(request.model),
        request,
        maxRetries,
      );
    },
  };
}
