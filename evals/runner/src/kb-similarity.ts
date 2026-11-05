import { z } from 'zod';

/**
 * Tuning `KB_MIN_VECTOR_SIMILARITY` (T-431, ADR-030 section 7). The floor is the cosine similarity a
 * passage needs to count as a vector match; the right value depends on the embedding model. This
 * module is the pure part: it takes vectors that were made elsewhere (a real embedder when run by
 * hand, fake vectors in CI) and reports, per candidate floor, how many on-topic queries still find a
 * relevant passage (recall) and how many queries pull in a passage that is not about them (noise).
 */

export const kbQuerySetSchema = z.object({
  queries: z
    .array(
      z.object({
        id: z.string().min(1),
        lang: z.enum(['th', 'en']),
        text: z.string().min(1),
        /** Slugs of the articles that answer the query. Empty: the query is about nothing in the corpus. */
        relevant: z.array(z.string().min(1)),
      }),
    )
    .min(1),
});
export type KbQuerySet = z.infer<typeof kbQuerySetSchema>;

export interface PassageVector {
  readonly slug: string;
  readonly vector: readonly number[];
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error('vectors of different sizes');
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let at = 0; at < a.length; at += 1) {
    const x = a[at] ?? 0;
    const y = b[at] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const norm = Math.sqrt(na) * Math.sqrt(nb);
  return norm === 0 ? 0 : dot / norm;
}

export interface QueryScore {
  readonly id: string;
  readonly lang: 'th' | 'en';
  readonly onTopic: boolean;
  /** Best similarity to a passage of a relevant article (null for an off-topic query). */
  readonly bestRelevant: number | null;
  /** Best similarity to a passage of any other article. */
  readonly bestOther: number;
}

export function scoreQueries(
  set: KbQuerySet,
  queryVectors: ReadonlyMap<string, readonly number[]>,
  passages: readonly PassageVector[],
): QueryScore[] {
  return set.queries.map((query) => {
    const vector = queryVectors.get(query.id);
    if (vector === undefined) throw new Error(`no vector for query ${query.id}`);
    let bestRelevant = -1;
    let bestOther = -1;
    for (const passage of passages) {
      const similarity = cosine(vector, passage.vector);
      if (query.relevant.includes(passage.slug)) bestRelevant = Math.max(bestRelevant, similarity);
      else bestOther = Math.max(bestOther, similarity);
    }
    const onTopic = query.relevant.length > 0;
    return {
      id: query.id,
      lang: query.lang,
      onTopic,
      bestRelevant: onTopic ? bestRelevant : null,
      bestOther,
    };
  });
}

export interface ThresholdRow {
  readonly threshold: number;
  /** Share of on-topic queries whose best relevant passage is at or above the floor. */
  readonly recall: number;
  /** Share of all queries for which some passage that is not relevant is also at or above the floor. */
  readonly noise: number;
}

export interface SimilarityReport {
  readonly queries: number;
  readonly onTopic: number;
  readonly rows: readonly ThresholdRow[];
  /** The highest floor that keeps recall at `minRecall` or better; null when none does. */
  readonly recommended: number | null;
}

export function evaluateThresholds(
  scores: readonly QueryScore[],
  options: { readonly minRecall?: number; readonly step?: number } = {},
): SimilarityReport {
  const minRecall = options.minRecall ?? 0.9;
  const step = options.step ?? 0.05;
  const onTopic = scores.filter((score) => score.onTopic);
  const rows: ThresholdRow[] = [];
  for (let n = 0; n * step <= 0.95 + 1e-9; n += 1) {
    const threshold = Math.round(n * step * 100) / 100;
    const found = onTopic.filter((score) => (score.bestRelevant ?? -1) >= threshold).length;
    const noisy = scores.filter((score) => score.bestOther >= threshold).length;
    rows.push({
      threshold,
      recall: onTopic.length === 0 ? 0 : found / onTopic.length,
      noise: scores.length === 0 ? 0 : noisy / scores.length,
    });
  }
  const ok = rows.filter((row) => row.recall >= minRecall);
  return {
    queries: scores.length,
    onTopic: onTopic.length,
    rows,
    recommended: ok.length === 0 ? null : (ok[ok.length - 1]?.threshold ?? null),
  };
}

export function formatSimilarityReport(model: string, report: SimilarityReport): string {
  const pct = (value: number): string => `${(value * 100).toFixed(0).padStart(3)}%`;
  const lines = [
    `KB similarity floor for ${model}: ${String(report.queries)} queries (${String(report.onTopic)} on topic)`,
    'floor   recall   noise',
    ...report.rows.map(
      (row) => `${row.threshold.toFixed(2)}    ${pct(row.recall)}    ${pct(row.noise)}`,
    ),
    report.recommended === null
      ? 'no floor keeps the recall: check the model or the query set'
      : `highest floor that keeps the recall: KB_MIN_VECTOR_SIMILARITY=${report.recommended.toFixed(2)}`,
  ];
  return lines.join('\n');
}

/** The `slug:` and `title:` of a KB markdown file, and the body after the header. */
export function readKbFile(text: string): { slug: string; title: string; body: string } | null {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (match === null) return null;
  const header = match[1] ?? '';
  const field = (name: string): string | undefined => {
    const line = new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(header)?.[1]?.trim();
    return line === undefined ? undefined : line.replace(/^(["'])(.*)\1$/, '$2');
  };
  const slug = field('slug');
  const title = field('title');
  if (slug === undefined || title === undefined) return null;
  return { slug, title, body: match[2] ?? '' };
}
