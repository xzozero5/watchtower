import type { ReactNode } from 'react';

import { ConsoleLayout } from '@/components/console-layout';

/**
 * Every signed-in staff page lives in this route group, so the auth gate, the realtime connection,
 * the navigation rail and the command palette are mounted once and stay mounted while the content
 * beside the rail changes. The group adds nothing to the URLs. Public pages (portal, status, csat),
 * the sign-in pages and /start stay outside.
 */
export default function Layout({ children }: { children: ReactNode }) {
  return <ConsoleLayout>{children}</ConsoleLayout>;
}
