import { LOCALE_COOKIE, type Locale } from '@/i18n';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** The Set-Cookie style value that remembers the chosen language. Not a secret, readable by JS. */
export function localeCookieValue(locale: Locale): string {
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${String(ONE_YEAR_SECONDS)}; SameSite=Lax`;
}

export function saveLocale(locale: Locale, doc: Pick<Document, 'cookie'> = document) {
  doc.cookie = localeCookieValue(locale);
}
