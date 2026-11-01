import { describe, expect, it } from 'vitest';

import { RRF_K, reciprocalRankFusion } from './rrf.js';
import { audienceWidens, canMove, canPublishFrom } from './rules.js';
import { pgTextArray, queryTerms } from './search.js';

describe('reciprocalRankFusion', () => {
  it('scores 1 / (k + rank) per list and sums across lists', () => {
    const fused = reciprocalRankFusion([
      { name: 'keyword', ids: ['a', 'b', 'c'] },
      { name: 'vector', ids: ['b', 'a', 'd'] },
    ]);
    const score = (id: string) => fused.find((item) => item.id === id)?.score;
    expect(score('a')).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2), 12);
    expect(score('d')).toBeCloseTo(1 / (RRF_K + 3), 12);
    expect(fused.find((item) => item.id === 'b')?.ranks).toEqual({ keyword: 2, vector: 1 });
    expect(fused.find((item) => item.id === 'c')?.ranks).toEqual({ keyword: 3 });
  });

  it('puts an item that both lists like above one that only one list loves', () => {
    const fused = reciprocalRankFusion([
      { name: 'keyword', ids: ['only-keyword', 'both'] },
      { name: 'vector', ids: ['both', 'only-vector'] },
    ]);
    expect(fused.map((item) => item.id)).toEqual(['both', 'only-keyword', 'only-vector']);
  });

  it('breaks ties by the better single rank and then by id, so the order is stable', () => {
    const fused = reciprocalRankFusion([
      { name: 'keyword', ids: ['x', 'y'] },
      { name: 'vector', ids: ['y', 'x'] },
    ]);
    expect(fused.map((item) => item.id)).toEqual(['x', 'y']);
    expect(
      reciprocalRankFusion([{ name: 'keyword', ids: ['m', 'k'] }]).map((item) => item.id),
    ).toEqual(['m', 'k']);
  });

  it('counts a repeated id once, at its first position', () => {
    const fused = reciprocalRankFusion([{ name: 'keyword', ids: ['a', 'a', 'b'] }]);
    expect(fused.find((item) => item.id === 'b')?.ranks.keyword).toBe(2);
  });

  it('returns nothing for no lists or empty lists', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([{ name: 'keyword', ids: [] }])).toEqual([]);
  });
});

describe('audienceWidens', () => {
  const org = (...orgIds: string[]) => ({ visibility: 'orgs' as const, orgIds });
  const internal = { visibility: 'internal' as const, orgIds: [] };
  const customer = { visibility: 'customer' as const, orgIds: [] };

  it('is true when more people can see the article', () => {
    expect(audienceWidens(internal, customer)).toBe(true);
    expect(audienceWidens(internal, org('a'))).toBe(true);
    expect(audienceWidens(org('a'), customer)).toBe(true);
    expect(audienceWidens(org('a'), org('a', 'b'))).toBe(true);
    expect(audienceWidens(org('a'), org('b'))).toBe(true);
  });

  it('is false when the audience stays or shrinks', () => {
    expect(audienceWidens(internal, internal)).toBe(false);
    expect(audienceWidens(customer, customer)).toBe(false);
    expect(audienceWidens(customer, internal)).toBe(false);
    expect(audienceWidens(customer, org('a'))).toBe(false);
    expect(audienceWidens(org('a', 'b'), org('a'))).toBe(false);
    expect(audienceWidens(org('a'), internal)).toBe(false);
  });
});

describe('status moves', () => {
  it('allows the review loop, deprecation and a restart from deprecated', () => {
    expect(canMove('draft', 'in_review')).toBe(true);
    expect(canMove('in_review', 'draft')).toBe(true);
    expect(canMove('published', 'deprecated')).toBe(true);
    expect(canMove('deprecated', 'draft')).toBe(true);
  });

  it('does not allow publishing through a plain move, or leaving deprecated for anywhere but draft', () => {
    expect(canMove('draft', 'published')).toBe(false);
    expect(canMove('in_review', 'published')).toBe(false);
    expect(canMove('deprecated', 'published')).toBe(false);
    expect(canMove('deprecated', 'in_review')).toBe(false);
    expect(canMove('published', 'draft')).toBe(false);
  });

  it('publishes from anything but deprecated', () => {
    expect(canPublishFrom('draft')).toBe(true);
    expect(canPublishFrom('in_review')).toBe(true);
    expect(canPublishFrom('published')).toBe(true);
    expect(canPublishFrom('deprecated')).toBe(false);
  });
});

describe('queryTerms', () => {
  it('splits on spaces and punctuation, drops one-letter terms and repeats, and caps the count', () => {
    expect(queryTerms('How do I reset my password?')).toEqual([
      'How',
      'do',
      'reset',
      'my',
      'password',
    ]);
    expect(queryTerms('a b c')).toEqual([]);
    expect(queryTerms('reset reset RESET')).toEqual(['reset', 'RESET']);
    expect(
      queryTerms(Array.from({ length: 20 }, (_, i) => `term${String(i)}`).join(' ')),
    ).toHaveLength(8);
  });

  it('keeps a Thai phrase whole, as Thai has no spaces', () => {
    expect(queryTerms('ลืมรหัสผ่าน')).toEqual(['ลืมรหัสผ่าน']);
    expect(queryTerms('ลืมรหัสผ่าน ตั้งค่า')).toEqual(['ลืมรหัสผ่าน', 'ตั้งค่า']);
  });

  it('cuts an enormous term', () => {
    expect(queryTerms('x'.repeat(500))[0]).toHaveLength(64);
  });
});

describe('pgTextArray', () => {
  it('quotes and escapes so one parameter carries the whole array', () => {
    expect(pgTextArray(['a', 'b c'])).toBe('{"a","b c"}');
    expect(pgTextArray(['quote"d', 'back\\slash'])).toBe('{"quote\\"d","back\\\\slash"}');
    expect(pgTextArray([])).toBe('{}');
  });
});
