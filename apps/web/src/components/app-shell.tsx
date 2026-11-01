'use client';

import { ConsoleShell } from '@/components/console-shell';
import { Workspace } from '@/components/workspace';

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
      <Workspace />
    </ConsoleShell>
  );
}
