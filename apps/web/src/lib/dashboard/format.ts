import type { Locale } from '@/i18n';
import { formatDuration } from '@/lib/format';

const unit = (locale: Locale, name: 'second', value: number) =>
  new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'narrow' }).format(value);

/**
 * A length of wall-clock seconds as "42s", "5m", "2h 10m" or "1d 4h". Under a minute it names
 * seconds: reading 30 seconds as "0m" would look like a zero.
 */
export function formatSeconds(seconds: number, locale: Locale): string {
  if (seconds < 60) return unit(locale, 'second', Math.round(seconds));
  return formatDuration(seconds * 1000, locale);
}

/** A count with the language's grouping: 1,284 or 1.284. */
export function formatCount(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale).format(value);
}

/** A share as "12%", with one decimal under 10% so 0.4% does not read as 0%. */
export function formatRate(rate: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: rate > 0 && rate < 0.1 ? 1 : 0,
  }).format(rate);
}

/** US dollars; three decimals under one dollar because a ticket's AI cost is often a few cents. */
export function formatUsd(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value < 1 ? 3 : 2,
    minimumFractionDigits: value < 1 ? 3 : 2,
  }).format(value);
}

/** An average score with one decimal ("4.3"). */
export function formatScore(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  }).format(value);
}

const dayFormatter = (locale: Locale, style: 'short' | 'long') =>
  new Intl.DateTimeFormat(
    locale,
    style === 'short'
      ? { month: 'short', day: 'numeric', timeZone: 'UTC' }
      : { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' },
  );

/**
 * A `YYYY-MM-DD` bucket of the api, which is a UTC day, as "Nov 2" (axis) or "Mon, Nov 2" (tooltip).
 * Formatted in UTC so the label is the bucket's own day, whatever zone the browser is in.
 */
export function formatDay(day: string, locale: Locale, style: 'short' | 'long'): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return dayFormatter(locale, style).format(date);
}
