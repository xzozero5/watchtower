import type { AssistantLocale } from '@watchtower/shared';

/**
 * The language of the screen for text the server writes (an AI summary): the `locale` the web names,
 * else the first language of `Accept-Language` we have, else English (the default of the instance,
 * po #17). Only `th` and `en` exist.
 */
export function pickLocale(
  explicit: string | undefined,
  acceptLanguage: string | undefined,
): AssistantLocale {
  const named = explicit?.trim().toLowerCase();
  if (named === 'th' || named === 'en') return named;
  for (const part of (acceptLanguage ?? '').split(',')) {
    const tag = part.split(';')[0]?.trim().toLowerCase() ?? '';
    if (tag === 'th' || tag.startsWith('th-')) return 'th';
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
  }
  return 'en';
}
