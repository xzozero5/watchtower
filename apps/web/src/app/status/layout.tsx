import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import type { ReactNode } from 'react';

import { PortalFrame } from '@/components/portal/portal-frame';
import { getMessages, LOCALE_COOKIE, negotiateLocale } from '@/i18n';

/**
 * The public status page (T-204b): the portal's frame and rules. No AuthGate, no staff navigation,
 * served `Cache-Control: no-store` and `Referrer-Policy: no-referrer` (see next.config.ts); the
 * service worker leaves it alone (public/sw.js). When the instance has the page switched off, the
 * api answers 404 and the pages render the not-found page.
 */
export async function generateMetadata(): Promise<Metadata> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const locale = negotiateLocale(
    cookieStore.get(LOCALE_COOKIE)?.value,
    headerStore.get('accept-language'),
  );
  return {
    title: getMessages(locale).ops.status.title,
    referrer: 'no-referrer',
  };
}

export default function StatusLayout({ children }: { children: ReactNode }) {
  return (
    <PortalFrame
      homeHref="/status"
      brandKey="ops.status.brand"
      mainKey="ops.status.main"
      width="max-w-3xl"
    >
      {children}
    </PortalFrame>
  );
}
