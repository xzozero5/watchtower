import type { Locale } from '@/i18n';
import { DISPLAY_TIME_ZONE } from '@/lib/format';

/**
 * A wait as one rounded-up unit in words: "30 seconds", "5 minutes", "2 hours" (Thai: "5 นาที").
 * Rounds up so the person never retries too early.
 */
export function formatWait(seconds: number, locale: Locale): string {
  const safe = Math.max(1, Math.ceil(seconds));
  const [unit, count] =
    safe < 60
      ? (['second', safe] as const)
      : safe < 3600
        ? (['minute', Math.ceil(safe / 60)] as const)
        : (['hour', Math.ceil(safe / 3600)] as const);
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(count);
}

/**
 * Date and time with the time zone named ("5 Nov 2026, 14:30 GMT+7"), because a customer can be
 * anywhere and the team's clock is the one in Bangkok (PRD section 8.4).
 */
export function formatPortalTime(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    // dateStyle and timeStyle cannot be combined with timeZoneName, so the parts are spelled out.
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: DISPLAY_TIME_ZONE,
    timeZoneName: 'short',
  }).format(new Date(iso));
}
