import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import type { ReactNode } from 'react';

import { PortalFrame } from '@/components/portal/portal-frame';
import { getMessages, LOCALE_COOKIE, negotiateLocale } from '@/i18n';

/**
 * The public client portal (T-007): no AuthGate, no staff navigation. Everything under /portal is
 * served `Cache-Control: no-store` and `Referrer-Policy: no-referrer` (see next.config.ts), and the
 * service worker leaves it alone (public/sw.js).
 */
export async function generateMetadata(): Promise<Metadata> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const locale = negotiateLocale(
    cookieStore.get(LOCALE_COOKIE)?.value,
    headerStore.get('accept-language'),
  );
  return {
    title: getMessages(locale).portal.frame.brand,
    referrer: 'no-referrer',
  };
}

export default function PortalLayout({ children }: { children: ReactNode }) {
  return <PortalFrame>{children}</PortalFrame>;
}
