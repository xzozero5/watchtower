import { AppShell } from '@/components/app-shell';
import { AuthGate } from '@/components/auth-gate';
import { RealtimeProvider } from '@/lib/realtime/realtime-provider';

export default function HomePage() {
  return (
    <AuthGate>
      <RealtimeProvider>
        <AppShell />
      </RealtimeProvider>
    </AuthGate>
  );
}
