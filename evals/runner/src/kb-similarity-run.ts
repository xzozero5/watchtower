import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createRedactor, type EmbeddingProvider } from '@watchtower/ai';
import { chunkMarkdown, DEFAULT_CHUNK_OPTIONS } from '@watchtower/domain';

import {
  evaluateThresholds,
  readKbFile,
  scoreQueries,
  type KbQuerySet,
  type PassageVector,
  type SimilarityReport,
} from './kb-similarity.js';

/** What the worker embeds for a chunk (apps/worker/src/kb/embed.ts `embeddingInput`): where it sits, then the passage. */
const passageText = (title: string, section: string, text: string): string =>
  section === '' ? `${title}\n\n${text}` : `${title}\n${section}\n\n${text}`;

const BATCH = 16;

export interface KbSimilarityRun {
  readonly kbDir: string;
  readonly querySet: KbQuerySet;
  readonly provider: EmbeddingProvider;
  readonly model: string;
}

/**
 * Embeds the chunks of the KB folder and the queries with the same redaction the app uses, then
 * scores them. It calls `provider` only: by hand that is a real embedder, in tests a fake.
 */
export async function runKbSimilarity(run: KbSimilarityRun): Promise<{
  report: SimilarityReport;
  passages: number;
}> {
  const articles = readdirSync(run.kbDir)
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .sort()
    .map((name) => readKbFile(readFileSync(join(run.kbDir, name), 'utf8')))
    .filter((article) => article !== null);
  const texts: { slug: string; text: string }[] = [];
  for (const article of articles) {
    for (const chunk of chunkMarkdown(article.body, DEFAULT_CHUNK_OPTIONS)) {
      texts.push({ slug: article.slug, text: passageText(article.title, chunk.section, chunk.text) });
    }
  }
  const redactor = createRedactor();
  const embed = async (values: readonly string[], scope: string): Promise<number[][]> => {
    const session = redactor.session({ scope });
    const redacted = values.map((value) => session.redact(value));
    const out: number[][] = [];
    for (let at = 0; at < redacted.length; at += BATCH) {
      const response = await run.provider.embed({
        model: run.model,
        values: redacted.slice(at, at + BATCH),
      });
      out.push(...response.embeddings);
    }
    return out;
  };

  const passageVectors = await embed(
    texts.map((item) => item.text),
    'eval:kb-similarity:passages',
  );
  const passages: PassageVector[] = texts.map((item, at) => ({
    slug: item.slug,
    vector: passageVectors[at] ?? [],
  }));
  const queryVectors = await embed(
    run.querySet.queries.map((query) => query.text),
    'eval:kb-similarity:queries',
  );
  const byId = new Map(run.querySet.queries.map((query, at) => [query.id, queryVectors[at] ?? []]));
  const scores = scoreQueries(run.querySet, byId, passages);
  return { report: evaluateThresholds(scores), passages: passages.length };
}
