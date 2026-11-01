import type { ReactNode } from 'react';

import { AuthGate } from '@/components/auth-gate';
import { ConsoleShell } from '@/components/console-shell';
import type { RailDestination } from '@/components/nav-rail';
import { RealtimeProvider } from '@/lib/realtime/realtime-provider';

/** A signed-in page of the head console: auth gate, realtime, then the shared shell around it. */
export function ConsolePage({
  destination,
  children,
}: {
  destination: Exclude<RailDestination, 'queue'>;
  children: ReactNode;
}) {
  return (
    <AuthGate>
      <RealtimeProvider>
        <ConsoleShell
          destination={destination}
          skipTo={{ href: '#main-content', label: 'app.skipToMain' }}
        >
          {children}
        </ConsoleShell>
      </RealtimeProvider>
    </AuthGate>
  );
}
