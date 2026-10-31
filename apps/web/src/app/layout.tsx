import '@fontsource-variable/inter';
import '@fontsource-variable/noto-sans-thai';
import './globals.css';

import { themeInitScript } from '@watchtower/ui';
import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import type { ReactNode } from 'react';

import { Providers } from '@/components/providers';
import { getMessages, LOCALE_COOKIE, negotiateLocale } from '@/i18n';
import { readRuntimeConfig } from '@/lib/runtime-config';

// Every request reads cookies, headers and runtime environment variables, so nothing here may be
// rendered once at build time. This is what keeps API_URL a runtime setting (ADR-001).
export const dynamic = 'force-dynamic';

async function currentLocale() {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return negotiateLocale(cookieStore.get(LOCALE_COOKIE)?.value, headerStore.get('accept-language'));
}

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
  const locale = await currentLocale();
  return (
    // suppressHydrationWarning: the inline script below sets data-theme before React hydrates.
    <html lang={locale} suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <Providers locale={locale} messages={getMessages(locale)} config={readRuntimeConfig()}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
