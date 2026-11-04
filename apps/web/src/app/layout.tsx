// Self-hosted fonts (owner, 2026-11-02): nothing is fetched from a font CDN at runtime. Thai and
// Mono load only the weights the UI uses.
import '@fontsource-variable/plus-jakarta-sans';
import '@fontsource/ibm-plex-sans-thai/thai-300.css';
import '@fontsource/ibm-plex-sans-thai/thai-400.css';
import '@fontsource/ibm-plex-sans-thai/thai-500.css';
import '@fontsource/ibm-plex-sans-thai/thai-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import './globals.css';

import { COLOR_TOKENS, themeInitScript } from '@watchtower/ui';
import type { Metadata, Viewport } from 'next';
import { cookies, headers } from 'next/headers';
import type { ReactNode } from 'react';

import { Providers } from '@/components/providers';
import { getMessages, LOCALE_COOKIE, negotiateLocale } from '@/i18n';
import { readRuntimeConfig } from '@/lib/runtime-config';

// Every request reads cookies, headers and runtime environment variables, so nothing here may be
// rendered once at build time. This is what keeps API_URL a runtime setting (ADR-001).
export const dynamic = 'force-dynamic';

/** The nonce `src/proxy.ts` made for this response; the inline theme script needs it under the CSP. */
async function currentNonce() {
  return (await headers()).get('x-nonce') ?? undefined;
}

async function currentLocale() {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return negotiateLocale(cookieStore.get(LOCALE_COOKIE)?.value, headerStore.get('accept-language'));
}

// Browser chrome follows the OS theme, with the colours from the design tokens.
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: COLOR_TOKENS.light.background },
    { media: '(prefers-color-scheme: dark)', color: COLOR_TOKENS.dark.background },
  ],
};

export async function generateMetadata(): Promise<Metadata> {
  const messages = getMessages(await currentLocale());
  return {
    title: messages.app.name,
    description: messages.app.description,
    icons: {
      icon: { url: '/brand/favicon.png', type: 'image/png', sizes: '64x64' },
      apple: { url: '/brand/watchtower-icon.png', type: 'image/png', sizes: '512x512' },
    },
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [locale, nonce] = await Promise.all([currentLocale(), currentNonce()]);
  return (
    // suppressHydrationWarning: the inline script below sets data-theme before React hydrates.
    <html lang={locale} suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        {/* suppressHydrationWarning: the browser hides a script's nonce from the DOM, React sees none. */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: themeInitScript }}
        />
      </head>
      <body>
        <Providers locale={locale} messages={getMessages(locale)} config={readRuntimeConfig()}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
