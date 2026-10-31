import type { Locale } from '@/i18n';

/** PRD section 8.4: dates in Asia/Bangkok unless the user overrides it (override comes later). */
export const DISPLAY_TIME_ZONE = 'Asia/Bangkok';

const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "5 minutes ago", "yesterday", in the UI language. Under a minute reads as "now". */
export function formatRelative(iso: string, now: number, locale: Locale): string {
  const diff = Date.parse(iso) - now;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) return formatter.format(Math.trunc(diff / size), unit);
  }
  return formatter.format(0, 'second');
}

const DURATION_UNITS = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
] as const;

/**
 * A length of time as at most two units: "1d 4h", "2h 10m", "42m" (narrow unit names in the UI
 * language). Under a minute reads as zero minutes.
 */
export function formatDuration(ms: number, locale: Locale): string {
  let rest = Math.max(0, ms);
  const parts: string[] = [];
  for (const [unit, size] of DURATION_UNITS) {
    const count = Math.floor(rest / size);
    rest -= count * size;
    if (count > 0 && parts.length < 2) {
      parts.push(
        new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(count),
      );
    }
  }
  if (parts.length > 0) return parts.join(' ');
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'minute',
    unitDisplay: 'narrow',
  }).format(0);
}

/**
 * The time a message was sent, short: "10:42" today, "Nov 2, 10:42" on another day (Bangkok time).
 * The exact date and time sit in the tooltip next to it.
 */
export function formatMessageTime(iso: string, locale: Locale, now = Date.now()): string {
  const day = (ms: number) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: DISPLAY_TIME_ZONE }).format(new Date(ms));
  const sameDay = day(Date.parse(iso)) === day(now);
  return new Intl.DateTimeFormat(
    locale,
    sameDay
      ? { timeStyle: 'short', timeZone: DISPLAY_TIME_ZONE }
      : {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZone: DISPLAY_TIME_ZONE,
        },
  ).format(new Date(iso));
}

/** Absolute date and time for tooltips and the timeline. */
export function formatDateTime(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: DISPLAY_TIME_ZONE,
  }).format(new Date(iso));
}
