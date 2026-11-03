'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { AuthGate } from '@/components/auth-gate';
import { ConsoleShell } from '@/components/console-shell';
import type { RailDestination } from '@/components/nav-rail';
import { RealtimeProvider } from '@/lib/realtime/realtime-provider';

/** Which rail item a path belongs to. */
export function destinationFor(pathname: string): RailDestination {
  const first = pathname.split('/')[1] ?? '';
  switch (first) {
    case 'home':
      return 'home';
    case 'dashboard':
      return 'dashboard';
    case 'admin':
      return 'admin';
    case 'shift': {
      const second = pathname.split('/')[2] ?? '';
      if (second === 'brief') return 'brief';
      if (second === 'handoff') return 'handoff';
      return 'shift';
    }
    case 'other-mail':
      return 'otherMail';
    case 'alerts':
      return 'alerts';
    case 'incidents':
      return 'incidents';
    case 'status-page':
      return 'status-page';
    case 'tickets':
      return 'newTicket';
    default:
      return 'queue';
  }
}

/**
 * The one shell of the signed-in app (the `(console)` route group layout): auth gate, realtime
 * connection, rail, palette. It stays mounted when the page changes; only its content is replaced.
 */
export function ConsoleLayout({ children }: { children: ReactNode }) {
  const destination = destinationFor(usePathname());
  return (
    <AuthGate>
      <RealtimeProvider>
        <ConsoleShell
          destination={destination}
          skipTo={
            destination === 'queue'
              ? { href: '#pane-conversation', label: 'app.skipToContent' }
              : { href: '#main-content', label: 'app.skipToMain' }
          }
        >
          {children}
        </ConsoleShell>
      </RealtimeProvider>
    </AuthGate>
  );
}
