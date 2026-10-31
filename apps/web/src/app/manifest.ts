import { COLOR_TOKENS } from '@watchtower/ui';
import type { MetadataRoute } from 'next';
import { cookies, headers } from 'next/headers';

import { getMessages, LOCALE_COOKIE, negotiateLocale } from '@/i18n';

// Read per request so the name follows the visitor's language, like the rest of the app.
export const dynamic = 'force-dynamic';

/**
 * Web app manifest (PWA, ADR-001). Colours come from the design tokens, never typed here. The
 * icons are the brand files in /public/brand. `start_url` is the queue; a signed-out visitor is
 * sent on to the login page by the app itself.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const locale = negotiateLocale(
    cookieStore.get(LOCALE_COOKIE)?.value,
    headerStore.get('accept-language'),
  );
  const messages = getMessages(locale);
  return {
    name: messages.app.name,
    short_name: messages.app.name,
    description: messages.app.description,
    lang: locale,
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: COLOR_TOKENS.light.background,
    theme_color: COLOR_TOKENS.light.primary,
    icons: [
      { src: '/brand/favicon.png', sizes: '64x64', type: 'image/png' },
      { src: '/brand/watchtower-icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
}
