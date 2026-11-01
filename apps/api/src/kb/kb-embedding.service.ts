import { Inject, Injectable } from '@nestjs/common';
import {
  MockEmbeddingProvider,
  createAuditedEmbedder,
  createRedactor,
  mockSettings,
  type AuditedEmbedder,
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
import { randomUUID } from 'node:crypto';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';

/** A search query as a vector, with the id of the embedding index it belongs to. */
export interface QueryEmbedding {
  readonly vector: readonly number[];
  readonly indexId: string;
}

/**
 * Turns a search query into a vector for the hybrid search (T-107c). It goes through the same
 * audited embedder as the worker: the guard (kill switch, daily budget) first, PII redaction before
 * the provider sees the text (N4), and an `ai_run` row for the call.
 *
 * Search never fails because of it: when there is no vector (nothing is indexed yet, the provider
 * is not wired in the api, the model in settings is not the one the chunks were embedded with, the
 * guard said no, or the provider failed) it answers `undefined` and the caller searches by keyword
 * only, and says so (`mode: 'keyword'`). A vector from a different model than the stored ones
 * would rank nonsense, so it is never used.
 *
 * Only `AI_PROVIDER=mock` is wired here; `anthropic` and `vertex` need the provider settings from
 * the admin store (T-116, `[ASK-HUMAN]`) and give keyword-only search until then.
 */
@Injectable()
export class KbEmbeddingService {
  private readonly embedder: AuditedEmbedder | undefined;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APP_CONFIG) config: ApiConfig,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {
    if (config.AI_PROVIDER !== 'mock') {
      this.embedder = undefined;
      return;
    }
    const db = database.db;
    this.embedder = createAuditedEmbedder({
      settings: { load: () => Promise.resolve(mockSettings()) },
      providers: { mock: new MockEmbeddingProvider() },
      sink: createAiRunRecorder({ db }),
      redactor: createRedactor(),
      guard: createAiGuard({
        policyGate: createPolicyGate({ db }),
        db,
        budget: createBudgetMonitor({
          db,
          caps: resolveAiCaps(config),
          onEvent: (notice) => {
            this.logger.warn(
              { dimension: notice.dimension, level: notice.level },
              'AI daily budget finding',
            );
          },
        }),
      }),
    });
  }

  async embedQuery(query: string): Promise<QueryEmbedding | undefined> {
    if (this.embedder === undefined) return undefined;
    try {
      const index = await readActiveEmbeddingIndex(this.database.db);
      if (index === undefined) return undefined;
      const wanted = mockSettings().embedding;
      if (
        index.provider !== wanted.provider ||
        index.model !== wanted.model ||
        index.dimensions !== wanted.dimensions
      ) {
        return undefined;
      }
      const outcome = await this.embedder.embed({
        texts: [query],
        scope: `kb-query:${randomUUID()}`,
        action: 'kb_query',
      });
      if (outcome.status !== 'ok') return undefined;
      const vector = outcome.embeddings[0];
      return vector === undefined ? undefined : { vector, indexId: index.id };
    } catch (error) {
      this.logger.warn({ err: error }, 'query embedding failed; searching by keyword only');
      return undefined;
    }
  }
}
