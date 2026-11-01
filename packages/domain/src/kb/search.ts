import { PG, pgCode, type Database } from '@watchtower/db';
import type { KbKind, KbLang, KbSearchHit, KbSearchMode, KbVisibility } from '@watchtower/shared';
import { sql, type SQL } from 'drizzle-orm';

import { reciprocalRankFusion } from './rrf.js';

/**
 * Who is asking, which decides what may come back:
 * - `staff`: every published article (internal, customer and per-organization ones).
 * - `customer`: only what a customer may read: `customer` articles, plus `orgs` articles whose
 *   list contains `orgId`. Never an internal article, a draft, a deprecated article, or an
 *   `orgs` article when no organization is given.
 * The audience is a required argument with no default, so a caller has to choose.
 */
export type KbAudience =
  { readonly kind: 'staff' } | { readonly kind: 'customer'; readonly orgId: string | null };

export interface KbSearchInput {
  readonly query: string;
  readonly audience: KbAudience;
  readonly limit: number;
  readonly lang?: KbLang | undefined;
  /**
   * The query embedded with the active embedding index, and that index's id. Both or neither;
   * without them the search is keyword only.
   */
  readonly embedding?: { readonly vector: readonly number[]; readonly indexId: string } | undefined;
  /** Most chunks of one article in the answer. Default 2. */
  readonly perArticle?: number | undefined;
  /**
   * How many candidates each list contributes to the fusion. Default 40, never more than
   * `MAX_CANDIDATES` (a larger number only makes the database sort more).
   */
  readonly candidates?: number | undefined;
  /**
   * Longest a statement of the search may run before the database stops it (`statement_timeout`,
   * local to the search's transaction). Default `DEFAULT_SEARCH_TIMEOUT_MS`. A search that is stopped
   * throws `KbSearchTimeoutError`.
   */
  readonly timeoutMs?: number | undefined;
  /**
   * Cosine similarity a chunk needs to enter the vector list. Without a floor the nearest chunks
   * are returned whatever they are about. Default `DEFAULT_MIN_VECTOR_SIMILARITY`.
   */
  readonly minVectorSimilarity?: number | undefined;
}

/**
 * `[ASSUMED]` 0.25: unrelated passages score well below it and related ones well above it for the
 * common sentence-embedding models, but the scale is the model's own. Tune it per model with the
 * golden queries once a real embedding model is chosen (`KB_MIN_VECTOR_SIMILARITY` in the api).
 */
export const DEFAULT_MIN_VECTOR_SIMILARITY = 0.25;

/**
 * [ASSUMED] 2 s: a search over thousands of chunks takes tens of milliseconds, so 2 s only stops a
 * pathological query (several very common words over a large corpus, seen at ~3.6 s for 3,000
 * chunks) before it holds a pool connection for long.
 */
export const DEFAULT_SEARCH_TIMEOUT_MS = 2000;

/** [ASSUMED] Most candidates one list sends to the fusion, and most keyword matches ranked. */
export const MAX_CANDIDATES = 100;
export const MAX_KEYWORD_MATCHES = 600;

/** The search ran longer than its time limit and the database stopped it. */
export class KbSearchTimeoutError extends Error {
  override readonly name = 'KbSearchTimeoutError';

  constructor() {
    super('Knowledge base search took too long');
  }
}

/** Candidates per list: at least `limit`, at most `MAX_CANDIDATES`. */
export function candidateCount(limit: number, candidates: number | undefined): number {
  return Math.min(MAX_CANDIDATES, Math.max(limit, candidates ?? 40));
}

export interface KbSearchOutcome {
  readonly mode: KbSearchMode;
  readonly hits: KbSearchHit[];
}

type SearchDb = Pick<Database['db'], 'execute' | 'transaction'>;
type SearchTx = Pick<Database['db'], 'execute'>;

const MAX_TERMS = 8;
const MAX_TERM_CHARS = 64;
const SNIPPET_CHARS = 300;

/**
 * The words of a query for trigram matching. Thai is written without spaces, so a Thai phrase is
 * one term and matches as a substring (word similarity needs no word boundaries). Terms shorter
 * than two characters match everything and are dropped.
 */
export function queryTerms(query: string): string[] {
  const terms = query
    // Postgres refuses a NUL character in text; the api rejects it earlier, this keeps a direct caller safe.
    .replaceAll('\u0000', '')
    .normalize('NFC')
    .split(/[\s,.;:!?()[\]{}"'`<>/\\|]+/u)
    .map((term) => term.trim().slice(0, MAX_TERM_CHARS))
    .filter((term) => Array.from(term).length >= 2);
  return [...new Set(terms)].slice(0, MAX_TERMS);
}

/** The audience as a SQL condition on `a` (kb_article). Everything listed is published and live. */
export function audienceCondition(audience: KbAudience): SQL {
  const live = sql`a.status = 'published' AND a.published_version_id IS NOT NULL`;
  if (audience.kind === 'staff') return live;
  const orgs =
    audience.orgId === null
      ? sql`false`
      : sql`(a.visibility = 'orgs' AND EXISTS (
            SELECT 1 FROM kb_article_org o WHERE o.article_id = a.id AND o.org_id = ${audience.orgId}::uuid))`;
  return sql`${live} AND (a.visibility = 'customer' OR ${orgs})`;
}

/** A Postgres array literal (`{"a","b"}`), sent as one parameter and cast on the SQL side. */
export function pgTextArray(values: readonly string[]): string {
  return `{${values.map((value) => `"${value.replace(/["\\]/gu, '\\$&')}"`).join(',')}}`;
}

const toVector = (values: readonly number[]): string => `[${values.join(',')}]`;

interface IdRow extends Record<string, unknown> {
  id: string;
}

interface HitRow extends Record<string, unknown> {
  chunk_id: string;
  article_id: string;
  version_id: string;
  version: number;
  slug: string;
  title: string;
  lang: KbLang;
  kind: KbKind;
  visibility: KbVisibility;
  intent_tags: string[];
  last_verified_at: Date | null;
  section: string;
  text: string;
}

function snippetOf(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  if (flat.length <= SNIPPET_CHARS) return flat;
  // Cut on a grapheme boundary: Thai has no spaces to fall back on.
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(flat)];
  let end = 0;
  for (const part of graphemes) {
    if (part.index > SNIPPET_CHARS) break;
    end = part.index;
  }
  return `${flat.slice(0, end).trimEnd()}...`;
}

/**
 * Hybrid search over the chunks of published articles (R-4.2): pg_trgm keyword matching and
 * pgvector cosine distance, fused with Reciprocal Rank Fusion. The audience condition is part of
 * both queries and of the final read, so a chunk the audience may not see is never ranked, never
 * fused and never returned. Only the chunks of the live version of an article are searched.
 *
 * Keyword match: any query term whose trigrams are `word_similarity`-close (pg_trgm default
 * threshold 0.6 `[ASSUMED]`) to a stretch of the chunk; the score is the mean over terms.
 */
export async function searchKb(db: SearchDb, input: KbSearchInput): Promise<KbSearchOutcome> {
  const timeoutMs = Math.max(1, Math.floor(input.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS));
  try {
    // One read-only transaction so the time limit (SET LOCAL, written as set_config(.., true), which
    // takes a parameter) applies to every statement of the search and never outlives it.
    return await db.transaction(
      async (tx) => {
        await tx.execute(sql`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`);
        return await searchWith(tx, input);
      },
      { accessMode: 'read only' },
    );
  } catch (error) {
    if (pgCode(error) === PG.queryCanceled) throw new KbSearchTimeoutError();
    throw error;
  }
}

async function searchWith(db: SearchTx, input: KbSearchInput): Promise<KbSearchOutcome> {
  const candidates = candidateCount(input.limit, input.candidates);
  const perArticle = Math.max(1, input.perArticle ?? 2);
  const visible = audienceCondition(input.audience);
  const lang = input.lang === undefined ? sql`true` : sql`a.lang = ${input.lang}`;

  const terms = queryTerms(input.query);
  const keyword =
    terms.length === 0
      ? []
      : (
          await db.execute<IdRow>(sql`
            WITH matched AS (
              SELECT c.id, c.text
                FROM kb_chunk c
                JOIN kb_article a ON a.id = c.article_id AND a.published_version_id = c.version_id
               WHERE ${visible} AND ${lang} AND c.text %> ANY(${pgTextArray(terms)}::text[])
               LIMIT ${MAX_KEYWORD_MATCHES}
            )
            SELECT m.id::text AS id
              FROM matched m
             ORDER BY (SELECT avg(word_similarity(t, m.text)) FROM unnest(${pgTextArray(terms)}::text[]) AS t) DESC,
                      m.id
             LIMIT ${candidates}`)
        ).rows;

  const embedding = input.embedding;
  const minSimilarity = input.minVectorSimilarity ?? DEFAULT_MIN_VECTOR_SIMILARITY;
  const vector =
    embedding === undefined
      ? []
      : (
          await db.execute<IdRow>(sql`
            SELECT c.id::text AS id
              FROM kb_chunk c
              JOIN kb_article a ON a.id = c.article_id AND a.published_version_id = c.version_id
             WHERE ${visible} AND ${lang}
               AND c.embedding_index_id = ${embedding.indexId}::uuid
               AND c.embedding <=> ${toVector(embedding.vector)}::vector <= ${1 - minSimilarity}
             ORDER BY c.embedding <=> ${toVector(embedding.vector)}::vector, c.id
             LIMIT ${candidates}`)
        ).rows;

  const fused = reciprocalRankFusion([
    { name: 'keyword', ids: keyword.map((row) => row.id) },
    { name: 'vector', ids: vector.map((row) => row.id) },
  ]);
  const mode: KbSearchMode = embedding === undefined ? 'keyword' : 'hybrid';
  if (fused.length === 0) return { mode, hits: [] };

  // Read the details of the fused chunks, again through the audience condition (defence in depth).
  const ids = fused.map((item) => item.id);
  const rows = (
    await db.execute<HitRow>(sql`
      SELECT c.id::text AS chunk_id, a.id::text AS article_id, c.version_id::text AS version_id,
             v.version, a.slug, v.title, a.lang, a.kind, a.visibility, a.intent_tags,
             a.last_verified_at, c.section, c.text
        FROM kb_chunk c
        JOIN kb_article a ON a.id = c.article_id AND a.published_version_id = c.version_id
        JOIN kb_article_version v ON v.id = c.version_id
       WHERE ${visible} AND c.id = ANY(${pgTextArray(ids)}::uuid[])`)
  ).rows;
  const byChunk = new Map(rows.map((row) => [row.chunk_id, row]));

  const taken = new Map<string, number>();
  const hits: KbSearchHit[] = [];
  for (const item of fused) {
    const row = byChunk.get(item.id);
    if (row === undefined) continue;
    const count = taken.get(row.article_id) ?? 0;
    if (count >= perArticle) continue;
    taken.set(row.article_id, count + 1);
    hits.push({
      articleId: row.article_id,
      slug: row.slug,
      title: row.title,
      lang: row.lang,
      section: row.section,
      snippet: snippetOf(row.text),
      chunkId: row.chunk_id,
      versionId: row.version_id,
      version: row.version,
      kind: row.kind,
      visibility: row.visibility,
      intentTags: row.intent_tags,
      lastVerifiedAt:
        row.last_verified_at === null ? null : new Date(row.last_verified_at).toISOString(),
      score: item.score,
      keywordRank: item.ranks.keyword ?? null,
      vectorRank: item.ranks.vector ?? null,
    });
    if (hits.length >= input.limit) break;
  }
  return { mode, hits };
}
