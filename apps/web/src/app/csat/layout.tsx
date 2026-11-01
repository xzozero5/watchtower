import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import type { ReactNode } from 'react';

import { PortalFrame } from '@/components/portal/portal-frame';
import { getMessages, LOCALE_COOKIE, negotiateLocale } from '@/i18n';

/**
 * The public CSAT survey page (T-110b): the same frame as the client portal and the same rules. No
 * AuthGate, no staff navigation, served `Cache-Control: no-store` and `Referrer-Policy: no-referrer`
 * (see next.config.ts); the service worker leaves it alone (public/sw.js).
 */
export async function generateMetadata(): Promise<Metadata> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const locale = negotiateLocale(
    cookieStore.get(LOCALE_COOKIE)?.value,
    headerStore.get('accept-language'),
  );
  return {
    title: getMessages(locale).csat.title,
    referrer: 'no-referrer',
    robots: { index: false, follow: false },
  };
}

export default function CsatLayout({ children }: { children: ReactNode }) {
  return <PortalFrame>{children}</PortalFrame>;
}
