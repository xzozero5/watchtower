import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_LOCALE, getMessages, LOCALES, negotiateLocale, translate } from './index';
import { en } from './messages/en';
import { th } from './messages/th';

/** Every leaf of a nested catalogue as [dotted key, text]. */
function flatten(node: unknown, prefix = ''): [string, string][] {
  if (typeof node === 'string') return [[prefix, node]];
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) =>
    flatten(value, prefix ? `${prefix}.${key}` : key),
  );
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('rail labels (QA-19a)', () => {
  it('are unique within each language', () => {
    for (const messages of [en, th]) {
      const labels = [
        messages.rail.queue,
        messages.rail.otherMail,
        messages.rail.home,
        messages.rail.dashboard,
        messages.rail.admin,
        messages.rail.newTicket,
        messages.rail.shift,
        messages.rail.brief,
        messages.rail.handoff,
        messages.rail.notifications,
        messages.ops.rail.alerts,
        messages.ops.rail.incidents,
        messages.ops.rail.statusPage,
      ];
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it('names Alerts and Notifications differently in Thai', () => {
    expect(th.ops.rail.alerts).toBe('แจ้งเตือนระบบ');
    expect(th.rail.notifications).toBe('กล่องแจ้งเตือน');
  });
});

describe('message catalogues', () => {
  const enEntries = flatten(en);
  const thEntries = flatten(th);

  it('have the same keys in Thai and English', () => {
    expect(thEntries.map(([key]) => key)).toEqual(enEntries.map(([key]) => key));
  });

  it('have one file per namespace in both languages, with matching keys in each', () => {
    const files = (lang: string) =>
      readdirSync(join(__dirname, 'messages', lang))
        .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
        .map((f) => f.replace(/\.ts$/, ''))
        .sort();
    const namespaces = files('en');
    expect(files('th')).toEqual(namespaces);
    // Every namespace file is wired into the catalogue, and nothing else is.
    expect(Object.keys(en).sort()).toEqual(namespaces);
    expect(Object.keys(th).sort()).toEqual(namespaces);

    const enTree = en as Record<string, unknown>;
    const thTree = th as Record<string, unknown>;
    for (const ns of namespaces) {
      const keys = (tree: Record<string, unknown>) => flatten(tree[ns], ns).map(([key]) => key);
      expect(keys(thTree), ns).toEqual(keys(enTree));
    }
  });

  it('have no empty text', () => {
    for (const [key, text] of [...enEntries, ...thEntries]) {
      expect(text.trim(), key).not.toBe('');
    }
  });

  it('use the same placeholders in both languages', () => {
    const thByKey = new Map(thEntries);
    for (const [key, text] of enEntries) {
      expect(placeholders(thByKey.get(key) ?? ''), key).toEqual(placeholders(text));
    }
  });

  it('really translate: Thai text differs from English for UI strings', () => {
    const thByKey = new Map(thEntries);
    const untranslated = enEntries.filter(
      ([key, text]) => thByKey.get(key) === text && key !== 'app.name',
    );
    // A few entries legitimately match, such as the language names. Most must differ.
    expect(untranslated.length).toBeLessThan(enEntries.length / 10);
  });

  it('exposes both languages', () => {
    expect([...LOCALES].sort()).toEqual(['en', 'th']);
    expect(getMessages('th')).toBe(th);
    expect(getMessages('en')).toBe(en);
  });
});

describe('translate', () => {
  it('looks up dotted keys', () => {
    expect(translate(en, 'panes.queue.title')).toBe('Queue');
    expect(translate(th, 'panes.queue.title')).toBe('คิวงาน');
  });

  it('fills placeholders and leaves unknown ones visible', () => {
    const messages = { ...en, app: { ...en.app, name: 'Hello {name}, {missing}' } };
    expect(translate(messages, 'app.name', { name: 'Ada' })).toBe('Hello Ada, {missing}');
    expect(translate(messages, 'app.name', { name: 3 })).toBe('Hello 3, {missing}');
  });

  it('returns the key for a path that is not a string', () => {
    // @ts-expect-error a group of messages is not itself a message key
    expect(translate(en, 'panes.queue')).toBe('panes.queue');
    // @ts-expect-error this key does not exist in the catalogue
    expect(translate(en, 'no.such.key')).toBe('no.such.key');
  });
});

describe('negotiateLocale', () => {
  it('prefers the saved choice over the browser', () => {
    expect(negotiateLocale('th', 'en-US,en;q=0.9')).toBe('th');
    expect(negotiateLocale('en', 'th-TH,th;q=0.9')).toBe('en');
  });

  it('ignores an unsupported cookie value', () => {
    expect(negotiateLocale('fr', 'th')).toBe('th');
    expect(negotiateLocale('', undefined)).toBe(DEFAULT_LOCALE);
  });

  it('follows Accept-Language by quality, then by order', () => {
    expect(negotiateLocale(undefined, 'th-TH,th;q=0.9,en;q=0.8')).toBe('th');
    expect(negotiateLocale(undefined, 'en;q=0.5,th;q=0.9')).toBe('th');
    expect(negotiateLocale(undefined, 'fr,de;q=0.9,en;q=0.1')).toBe('en');
    expect(negotiateLocale(undefined, 'th;q=0.5,en;q=0.5')).toBe('th');
  });

  it('falls back to the default for anything it cannot use', () => {
    expect(negotiateLocale(undefined, null)).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale(undefined, 'fr,de')).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale(undefined, '*')).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale(undefined, 'th;q=0,en;q=abc')).toBe(DEFAULT_LOCALE);
  });
});
