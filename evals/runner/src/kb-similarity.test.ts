import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MockEmbeddingProvider, type EmbeddingProvider } from '@watchtower/ai';
import { describe, expect, it } from 'vitest';

import {
  cosine,
  evaluateThresholds,
  formatSimilarityReport,
  kbQuerySetSchema,
  readKbFile,
  scoreQueries,
  type KbQuerySet,
} from './kb-similarity.js';
import { runKbSimilarity } from './kb-similarity-run.js';

const KB_DIR = fileURLToPath(new URL('../../../examples/kb', import.meta.url));
const QUERIES = fileURLToPath(new URL('../kb-similarity/queries.json', import.meta.url));
const querySet = kbQuerySetSchema.parse(JSON.parse(readFileSync(QUERIES, 'utf8')));

describe('the query set', () => {
  it('has Thai and English queries, on topic and off, and names only slugs that exist in examples/kb', () => {
    const langs = new Set(querySet.queries.map((query) => query.lang));
    expect(langs).toEqual(new Set(['th', 'en']));
    expect(querySet.queries.some((query) => query.relevant.length === 0)).toBe(true);
    expect(new Set(querySet.queries.map((query) => query.id)).size).toBe(querySet.queries.length);
    const text = ['invoices-and-billing', 'reset-your-password', 'reset-your-password-th', 'webhook-not-received', 'runbook-upstream-timeout-th', 'runbook-rotate-api-credentials'];
    for (const slug of querySet.queries.flatMap((query) => query.relevant)) {
      expect(text).toContain(slug);
    }
  });
});

describe('cosine and scoring', () => {
  it('is 1 for the same direction, 0 for orthogonal and refuses different sizes', () => {
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(() => cosine([1], [1, 2])).toThrow();
  });

  const set: KbQuerySet = {
    queries: [
      { id: 'a', lang: 'en', text: 'a', relevant: ['x'] },
      { id: 'b', lang: 'th', text: 'b', relevant: ['y'] },
      { id: 'off', lang: 'en', text: 'off', relevant: [] },
    ],
  };
  const passages = [
    { slug: 'x', vector: [1, 0] },
    { slug: 'y', vector: [0, 1] },
  ];
  const vectors = new Map<string, number[]>([
    ['a', [1, 0.1]],
    ['b', [0.3, 1]],
    ['off', [1, 1]],
  ]);

  it('takes the best relevant and the best other passage per query', () => {
    const scores = scoreQueries(set, vectors, passages);
    expect(scores[0]?.bestRelevant).toBeGreaterThan(0.99);
    expect(scores[0]?.bestOther).toBeLessThan(0.11);
    expect(scores[2]).toMatchObject({ onTopic: false, bestRelevant: null });
  });

  it('recommends the highest floor that keeps recall, and shows noise falling as the floor rises', () => {
    const report = evaluateThresholds(scoreQueries(set, vectors, passages), { minRecall: 1 });
    // a: 0.995, b: 0.958 -> both found up to 0.95; the off-topic query matches both passages at 0.707.
    expect(report.recommended).toBe(0.95);
    const at = (threshold: number) => report.rows.find((row) => row.threshold === threshold);
    expect(at(0.5)?.noise).toBeCloseTo(1 / 3);
    expect(at(0.8)?.noise).toBe(0);
    expect(report.recommended).not.toBeNull();
    expect(formatSimilarityReport('m', report)).toContain('KB_MIN_VECTOR_SIMILARITY=0.95');
  });

  it('says so when no floor keeps the recall', () => {
    const none = evaluateThresholds(
      [{ id: 'a', lang: 'en', onTopic: true, bestRelevant: -0.5, bestOther: 0 }],
      { minRecall: 1 },
    );
    expect(none.recommended).toBeNull();
  });
});

describe('runKbSimilarity on examples/kb with a fake embedder (no model, no network)', () => {
  it('chunks the KB, embeds passages and queries through the redactor, and reports', async () => {
    const mock = new MockEmbeddingProvider(32);
    const seen: string[] = [];
    const provider: EmbeddingProvider = {
      kind: 'mock',
      embed(request) {
        seen.push(...request.values);
        return mock.embed({ ...request, dimensions: 32 });
      },
    };
    const { report, passages } = await runKbSimilarity({
      kbDir: KB_DIR,
      querySet,
      provider,
      model: 'fake',
    });
    expect(passages).toBeGreaterThan(6);
    expect(report.queries).toBe(querySet.queries.length);
    expect(report.rows[0]?.threshold).toBe(0);
    // At floor 0 every on-topic query finds its passage (cosine can be negative for random vectors, so allow either).
    expect(report.rows.length).toBeGreaterThan(10);
    expect(seen.length).toBe(passages + querySet.queries.length);
    // The embedder saw the title and section ahead of the passage, like the worker sends it.
    expect(seen.some((text) => text.startsWith('Your webhook endpoint does not receive events\n'))).toBe(true);
  });
});

describe('readKbFile', () => {
  it('reads slug, title and body, and returns null for a file without a header', () => {
    expect(readKbFile('---\nslug: a-b\ntitle: "Hello"\n---\n# Body\n')).toEqual({
      slug: 'a-b',
      title: 'Hello',
      body: '# Body\n',
    });
    expect(readKbFile('# no header')).toBeNull();
    expect(readKbFile('---\ntitle: only\n---\nx')).toBeNull();
  });
});
