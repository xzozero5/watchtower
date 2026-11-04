import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createLocalNameFinder, createRedactor } from '@watchtower/ai';
import { describe, expect, it } from 'vitest';

import {
  REDACTION_CATEGORIES,
  evaluateRedaction,
  formatRedactionReport,
  leaks,
  redactionCorpusSchema,
  redactionGate,
  type RedactFn,
} from './redaction-eval.js';

const corpus = redactionCorpusSchema.parse(
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../redaction/corpus.json', import.meta.url)), 'utf8'),
  ),
);
const real: RedactFn = (text, names) =>
  createRedactor({ names: () => names })
    .session({ scope: 'eval:test' })
    .redact(text);

describe('redaction eval (T-302e)', () => {
  it('has Thai and English cases in every category, and ids are unique', () => {
    const ids = corpus.cases.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const category of REDACTION_CATEGORIES) {
      const inCategory = corpus.cases.filter((item) => item.category === category);
      expect(inCategory.length).toBeGreaterThan(0);
      if (category !== 'csat_link' && category !== 'passport') {
        expect(new Set(inCategory.map((item) => item.lang))).toEqual(new Set(['th', 'en']));
      }
    }
    // every value to redact really is in its text, so a typo cannot make a case pass by accident
    for (const item of corpus.cases) {
      for (const value of [...item.redact, ...item.keep]) expect(item.text).toContain(value);
    }
  });

  it('compares numbers by digits and names by words', () => {
    expect(leaks('phone', '081-234-5678', 'call 0812345678')).toBe(true);
    expect(leaks('phone', '081-234-5678', 'call [PHONE_1]')).toBe(false);
    expect(leaks('national_id', '๑๑๐๑๗๐๐๑๒๓๔๕๖', '1101700123456')).toBe(true);
    expect(leaks('name_cue', 'Somchai Jaidee', 'my name is [NAME_1] jaidee')).toBe(true);
    expect(leaks('name_cue', 'Somchai Jaidee', 'my name is [NAME_1] [NAME_2]')).toBe(false);
    expect(leaks('email', 'a@example.test', 'mail a@example.test')).toBe(true);
  });

  it('scores a redactor that does nothing as zero recall, and one that blanks everything as all false positives', () => {
    const none = evaluateRedaction('identity', corpus.cases, (text) => text);
    expect(none.overall.recall.rate).toBe(0);
    expect(none.overall.falsePositives.rate).toBe(1);
    expect(redactionGate(none, { minRecall: 1, maxFalsePositive: 0.02 })).toHaveLength(1);

    const blank = evaluateRedaction('blank', corpus.cases, () => '[X]');
    expect(blank.overall.recall.rate).toBe(1);
    expect(blank.overall.falsePositives.rate).toBe(0);
    expect(redactionGate(blank, { minRecall: 1, maxFalsePositive: 0.02 })).toHaveLength(1);
  });

  it('the shipped redactor has full recall outside the documented gaps and few false positives', () => {
    const report = evaluateRedaction('createRedactor()', corpus.cases, real);
    expect(redactionGate(report, { minRecall: 1, maxFalsePositive: 0.02 })).toEqual([]);
    // the documented gap stays visible: names with no cue and no dictionary entry
    const nocue = report.byCategory.find((row) => row.category === 'name_nocue');
    expect(nocue?.recall.rate).toBe(0);
    expect(report.overall.recall.rate).toBeLessThan(1);
    expect(formatRedactionReport(report)).toContain('name_nocue');
  });

  it('the local name finder (T-153) lifts recall on names with no cue and adds no false positive', () => {
    const finder = createLocalNameFinder();
    const withNer: RedactFn = (text, names) =>
      createRedactor({ names: () => names, nameFinder: finder })
        .session({ scope: 'eval:ner' })
        .redact(text);
    const before = evaluateRedaction('off', corpus.cases, real);
    const after = evaluateRedaction('local', corpus.cases, withNer);
    const nocue = (report: typeof before) =>
      report.byCategory.find((row) => row.category === 'name_nocue')?.recall.rate ?? 0;
    expect(nocue(after)).toBeGreaterThan(nocue(before));
    expect(after.overall.falsePositives.misses).toBeLessThanOrEqual(
      before.overall.falsePositives.misses,
    );
    expect(redactionGate(after, { minRecall: 1, maxFalsePositive: 0.02 })).toEqual([]);
  });
});
