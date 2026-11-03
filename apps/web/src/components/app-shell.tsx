'use client';

import { ConsoleShell } from '@/components/console-shell';
import { DevHome } from '@/components/dev/dev-home';
import { Workspace } from '@/components/workspace';
import { useSession } from '@/lib/auth/session';

/**
 * The queue workspace (queue, conversation, details panel) inside the shared console shell: the
 * navigation rail, the command palette (Ctrl+K or Cmd+K) and the keyboard map (`?`). Render it
 * inside the auth gate and the realtime provider.
 */
export function AppShell() {
  return (
    <ConsoleShell
      destination="queue"
      skipTo={{ href: '#pane-conversation', label: 'app.skipToContent' }}
    >
      <QueueHome />
    </ConsoleShell>
  );
}

/** What the app root shows inside the shell: the queue workspace, or the developer home. */
export function QueueHome() {
  const { can } = useSession();
  // A developer reads every ticket with personal data masked and has no queue of their own (T-137).
  const developer = can('ticket.read.masked') && !can('ticket.read');
  return developer ? <DevHome /> : <Workspace />;
}
