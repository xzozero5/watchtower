import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from '../auth.js';
import { QUEUE_NAMES } from '../queues.js';
import {
  KB_AUDIT_ACTIONS,
  KB_CHUNK_DEFAULTS,
  KB_QUEUES,
  createKbArticleSchema,
  embedArticleJobSchema,
  kbSearchQuerySchema,
  kbSlugSchema,
  updateKbArticleSchema,
} from './kb.js';

const ORG = '2f1d6f1e-8d3b-4c52-9f0a-6a2f0a1b3c4d';

describe('knowledge base contracts', () => {
  it('registers its audit actions and queue in the global vocabulary', () => {
    for (const action of Object.values(KB_AUDIT_ACTIONS)) {
      expect(Object.values(AUDIT_ACTIONS)).toContain(action);
    }
    expect(QUEUE_NAMES.kb).toBe(KB_QUEUES.kb);
  });

  it('accepts a slug that is lowercase ASCII with hyphens and refuses the rest', () => {
    for (const ok of ['a', 'reset-password', 'v2-api-keys', 'a1']) {
      expect(kbSlugSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['', 'Reset', '-start', 'end-', 'has space', 'ไทย', 'a'.repeat(121)]) {
      expect(kbSlugSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('creates an internal article by default and needs organizations for visibility "orgs"', () => {
    const parsed = createKbArticleSchema.parse({
      slug: 'a-b',
      title: ' Title ',
      bodyMd: '# Hi',
      lang: 'th',
    });
    expect(parsed).toMatchObject({
      title: 'Title',
      kind: 'article',
      visibility: 'internal',
      orgIds: [],
      intentTags: [],
      sources: [],
    });
    expect(
      createKbArticleSchema.safeParse({
        slug: 'a-b',
        title: 'T',
        bodyMd: '',
        lang: 'en',
        visibility: 'orgs',
      }).success,
    ).toBe(false);
    expect(
      createKbArticleSchema.safeParse({
        slug: 'a-b',
        title: 'T',
        bodyMd: '',
        lang: 'en',
        visibility: 'orgs',
        orgIds: [ORG],
      }).success,
    ).toBe(true);
  });

  it('refuses a language or visibility it does not know and an oversized body', () => {
    const base = { slug: 'a', title: 'T', bodyMd: '', lang: 'en' };
    expect(createKbArticleSchema.safeParse({ ...base, lang: 'fr' }).success).toBe(false);
    expect(createKbArticleSchema.safeParse({ ...base, visibility: 'public' }).success).toBe(false);
    expect(createKbArticleSchema.safeParse({ ...base, bodyMd: 'x'.repeat(30_001) }).success).toBe(
      false,
    );
  });

  it('refuses an update that changes nothing', () => {
    expect(updateKbArticleSchema.safeParse({}).success).toBe(false);
    expect(updateKbArticleSchema.safeParse({ expectedVersion: 2, changeNote: 'x' }).success).toBe(
      false,
    );
    expect(updateKbArticleSchema.safeParse({ title: 'New' }).success).toBe(true);
    expect(updateKbArticleSchema.safeParse({ lastVerifiedAt: null }).success).toBe(true);
  });

  it('searches as staff by default with a bounded limit', () => {
    expect(kbSearchQuerySchema.parse({ q: ' reset ' })).toMatchObject({
      q: 'reset',
      audience: 'staff',
      limit: 8,
    });
    expect(kbSearchQuerySchema.safeParse({ q: '' }).success).toBe(false);
    expect(kbSearchQuerySchema.safeParse({ q: 'x', limit: '21' }).success).toBe(false);
  });

  it('validates the embed job payload and keeps sane chunk defaults', () => {
    expect(embedArticleJobSchema.safeParse({ articleId: ORG, versionId: ORG }).success).toBe(true);
    expect(embedArticleJobSchema.safeParse({ articleId: 'x' }).success).toBe(false);
    expect(KB_CHUNK_DEFAULTS.minChars).toBeLessThan(KB_CHUNK_DEFAULTS.targetChars);
    expect(KB_CHUNK_DEFAULTS.targetChars).toBeLessThan(KB_CHUNK_DEFAULTS.maxChars);
    expect(KB_CHUNK_DEFAULTS.overlapChars).toBeLessThan(KB_CHUNK_DEFAULTS.minChars + 1);
  });
});
