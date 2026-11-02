import { en, type Messages } from './messages/en';
import { th } from './messages/th';

export const LOCALES = ['th', 'en'] as const;

export type Locale = (typeof LOCALES)[number];

/** Used when neither the cookie nor Accept-Language names a supported language. `[ASSUMED]` */
export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_COOKIE = 'wt-locale';

/** Each language written in itself, so a user can find theirs whatever the UI language is. */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = { th: 'ไทย', en: 'English' };

/** The name of each language in itself, for the flag buttons (the flag is only a picture). */
export const LOCALE_LABELS: Readonly<Record<Locale, string>> = { th: 'ภาษาไทย', en: 'English' };

/** Which flag stands for each language. English uses the United Kingdom's `[ASSUMED]`. */
export const LOCALE_FLAGS = { th: 'th', en: 'gb' } as const satisfies Record<Locale, 'th' | 'gb'>;

const CATALOGS: Readonly<Record<Locale, Messages>> = { en, th };

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((locale) => locale === value);
}

export function getMessages(locale: Locale): Messages {
  return CATALOGS[locale];
}

/**
 * Picks the UI language: an explicit choice (cookie) wins, then the first supported language in
 * the Accept-Language header by quality, then the default.
 */
export function negotiateLocale(
  cookieValue: string | undefined,
  acceptLanguage: string | null | undefined,
): Locale {
  if (isLocale(cookieValue)) return cookieValue;
  if (!acceptLanguage) return DEFAULT_LOCALE;

  const candidates = acceptLanguage
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
      const quality = q === undefined ? 1 : Number(q);
      return { language: tag.trim().toLowerCase().split('-')[0] ?? '', quality, index };
    })
    .filter(
      ({ language, quality }) => isLocale(language) && Number.isFinite(quality) && quality > 0,
    )
    .sort((a, b) => b.quality - a.quality || a.index - b.index);

  const best = candidates[0]?.language;
  return isLocale(best) ? best : DEFAULT_LOCALE;
}

type Join<K extends string, P extends string> = `${K}.${P}`;

type Paths<T> = {
  [K in keyof T & string]: T[K] extends string ? K : Join<K, Paths<T[K]>>;
}[keyof T & string];

/** Every dotted key of the catalogue, for example `panes.queue.title`. */
export type MessageKey = Paths<Messages>;

export type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

/** Looks up a dotted key and fills `{name}` placeholders. A missing key returns the key itself. */
export function translate(
  messages: Messages,
  key: MessageKey,
  values?: Record<string, string | number>,
): string {
  let node: unknown = messages;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return key;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== 'string') return key;
  if (!values) return node;
  return node.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : String(value);
  });
}
