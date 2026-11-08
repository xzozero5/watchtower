import { Inject, Injectable } from '@nestjs/common';
import {
  MockEmbeddingProvider,
  assertLocalEmbeddingUrl,
  createAuditedEmbedder,
  createLocalEmbeddingProvider,
  parseLocalEmbeddingHosts,
  createRedactor,
  embeddingSettings,
  mockSettings,
  type AuditedEmbedder,
  type ProviderKind,
} from '@watchtower/ai';
import type { Database } from '@watchtower/db';
import {
  createAiGuard,
  createAiRunRecorder,
  createBudgetMonitor,
  createPolicyGate,
  readActiveEmbeddingIndex,
  resolveAiCaps,
} from '@watchtower/domain';
import { assertKbEmbeddingProvider } from '@watchtower/shared';
import { randomUUID } from 'node:crypto';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';
import { safeErrorLabel } from './kb-errors.js';

/**
 * How long a query waits for the local embedder (ADR-030): a search that cannot get its vector in
 * this time goes on by keyword only. One attempt, no retry.
 */
export const QUERY_EMBED_TIMEOUT_MS = 1500;

/** A search query as a vector, with the id of the embedding index it belongs to. */
export interface QueryEmbedding {
  readonly vector: readonly number[];
  readonly indexId: string;
}

interface ImmutableSpecKey {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly dimensions: number;
}

/**
 * Turns a search query into a vector for hybrid search (T-107c, ADR-033 §3).
 *
 * It routes embedding through the active embedding index recorded in the database, pinning the
 * spec per request and using an AuditedEmbedder configured immutably for that spec.
 *
 * Search never fails because of an embedding issue: when there is no vector (nothing is indexed yet,
 * the provider is not available, the guard refused, or the call timed out) it answers `undefined`
 * and the caller searches by keyword only (`mode: 'keyword'`).
 */
@Injectable()
export class KbEmbeddingService {
  private readonly embedderCache = new Map<string, AuditedEmbedder>();
  private readonly sink: ReturnType<typeof createAiRunRecorder>;
  private readonly guard: ReturnType<typeof createAiGuard>;
  private readonly prices: ReturnType<typeof embeddingSettings>['prices'];

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {
    assertKbEmbeddingProvider(config.EMBEDDING_PROVIDER);
    if (config.EMBEDDING_PROVIDER === 'local') {
      const allowedHosts = parseLocalEmbeddingHosts(config.EMBEDDING_LOCAL_HOSTS);
      assertLocalEmbeddingUrl(config.EMBEDDING_LOCAL_URL, allowedHosts);
    }
    const db = database.db;
    const caps = resolveAiCaps(config);
    this.prices = embeddingSettings(config).prices;
    this.sink = createAiRunRecorder({ db });
    this.guard = createAiGuard({
      policyGate: createPolicyGate({ db }),
      db,
      caps,
      budget: createBudgetMonitor({
        db,
        caps,
        onEvent: (notice) => {
          this.logger.warn(
            { dimension: notice.dimension, level: notice.level },
            'AI daily budget finding',
          );
        },
      }),
    });
  }

  private getOrCreateEmbedder(spec: ImmutableSpecKey): AuditedEmbedder | undefined {
    const cacheKey = `${spec.provider}:${spec.model}:${String(spec.dimensions)}`;
    const cached = this.embedderCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const providers: Parameters<typeof createAuditedEmbedder>[0]['providers'] = {
      mock: new MockEmbeddingProvider(),
    };

    if (spec.provider === 'local') {
      // Local model is only available if it matches the configured local model and dimensions
      if (
        spec.model !== this.config.EMBEDDING_MODEL ||
        spec.dimensions !== this.config.EMBEDDING_DIMENSIONS
      ) {
        return undefined;
      }
      try {
        const allowedHosts = parseLocalEmbeddingHosts(this.config.EMBEDDING_LOCAL_HOSTS);
        providers.local = createLocalEmbeddingProvider({
          url: this.config.EMBEDDING_LOCAL_URL,
          allowedHosts,
          fetch: (input, init) => globalThis.fetch(input, init),
          timeoutMs: QUERY_EMBED_TIMEOUT_MS,
          maxRetries: 0,
        });
      } catch {
        // If local configuration is incomplete/disallowed, fallback to keyword
        return undefined;
      }
    } else if (spec.provider !== 'mock') {
      // Other unconfigured providers fallback to keyword
      return undefined;
    }

    const embedder = createAuditedEmbedder({
      settings: {
        load: () =>
          Promise.resolve({
            ...mockSettings(),
            embedding: {
              provider: spec.provider,
              model: spec.model,
              dimensions: spec.dimensions,
            },
            prices: this.prices,
          }),
      },
      providers,
      sink: this.sink,
      redactor: createRedactor(),
      guard: this.guard,
    });

    this.embedderCache.set(cacheKey, embedder);
    return embedder;
  }

  async embedQuery(query: string): Promise<QueryEmbedding | undefined> {
    try {
      const index = await readActiveEmbeddingIndex(this.database.db);
      if (index === undefined) return undefined;

      // Pin active index spec and ID per request (ADR-033 §3)
      const pinned: ImmutableSpecKey & { readonly indexId: string } = {
        indexId: index.id,
        provider: index.provider as ProviderKind,
        model: index.model,
        dimensions: index.dimensions,
      };

      const embedder = this.getOrCreateEmbedder(pinned);
      if (embedder === undefined) {
        this.logger.warn(
          { provider: pinned.provider, model: pinned.model },
          'embedder unavailable for active index spec; searching by keyword only',
        );
        return undefined;
      }

      const outcome = await embedder.embed({
        texts: [query],
        scope: `kb-query:${randomUUID()}`,
        action: 'kb_query',
      });

      if (outcome.status !== 'ok') return undefined;

      // Strict outcome verification against pinned spec
      if (
        outcome.provider !== pinned.provider ||
        outcome.model !== pinned.model ||
        outcome.dimensions !== pinned.dimensions
      ) {
        this.logger.warn(
          {
            outcome: {
              provider: outcome.provider,
              model: outcome.model,
              dimensions: outcome.dimensions,
            },
            pinned,
          },
          'embedding outcome mismatched pinned spec',
        );
        return undefined;
      }

      const vector = outcome.embeddings[0];
      if (
        vector === undefined ||
        vector.length !== pinned.dimensions ||
        !vector.every(Number.isFinite)
      ) {
        return undefined;
      }

      return { vector, indexId: pinned.indexId };
    } catch (error) {
      this.logger.warn(
        { error: safeErrorLabel(error) },
        'query embedding failed; searching by keyword only',
      );
      return undefined;
    }
  }
}
