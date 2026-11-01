import { assertChunkOptions, type ChunkOptions } from '@watchtower/domain';
import { KB_JOBS, embedArticleJobSchema } from '@watchtower/shared';
import { UnrecoverableError, type Job } from 'bullmq';

import type { WorkerConfig } from '../config.js';
import {
  embedArticle,
  reembedAll,
  type EmbedResult,
  type KbDeps,
  type ReembedResult,
} from './embed.js';

/** The chunk sizes from the worker environment. Throws at boot when they do not fit together. */
export function chunkOptionsFrom(
  config: Pick<
    WorkerConfig,
    'KB_CHUNK_TARGET_CHARS' | 'KB_CHUNK_MAX_CHARS' | 'KB_CHUNK_MIN_CHARS' | 'KB_CHUNK_OVERLAP_CHARS'
  >,
): ChunkOptions {
  const options: ChunkOptions = {
    targetChars: config.KB_CHUNK_TARGET_CHARS,
    maxChars: config.KB_CHUNK_MAX_CHARS,
    minChars: config.KB_CHUNK_MIN_CHARS,
    overlapChars: config.KB_CHUNK_OVERLAP_CHARS,
  };
  assertChunkOptions(options);
  return options;
}

/**
 * Processor for the `kb` queue (T-107b). `embed_article` chunks and embeds the live version of one
 * article (or removes the chunks of one that is no longer published); `reembed_all` brings every
 * published article up to the active embedding model. A malformed payload is not retried.
 */
export function createKbProcessor(deps: KbDeps) {
  return async (job: Job): Promise<EmbedResult | ReembedResult> => {
    switch (job.name) {
      case KB_JOBS.embedArticle: {
        const parsed = embedArticleJobSchema.safeParse(job.data);
        if (!parsed.success) throw new UnrecoverableError('invalid embed_article payload');
        const result = await embedArticle(deps, parsed.data.articleId, parsed.data.versionId);
        deps.logger.info(
          { articleId: parsed.data.articleId, status: result.status, chunks: result.chunks },
          'knowledge base article indexed',
        );
        return result;
      }
      case KB_JOBS.reembedAll: {
        const result = await reembedAll(deps);
        if (result.queued > 0) deps.logger.info({ ...result }, 'knowledge base re-embedded');
        if (result.failed > 0)
          throw new Error(`${String(result.failed)} articles failed; retrying`);
        return result;
      }
      default:
        throw new UnrecoverableError(`unknown kb job "${job.name}"`);
    }
  };
}
