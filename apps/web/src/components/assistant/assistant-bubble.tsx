'use client';

import { Button, cn } from '@watchtower/ui';
import { Bot, CirclePause } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useCallback, useId, useRef, useState } from 'react';

import { useI18n } from '@/i18n/provider';
import { useAutonomy } from '@/lib/admin/queries';
import { usePageContext } from '@/lib/assistant/page-context';
import { useSession } from '@/lib/auth/session';
import { useModifierShortcut } from '@/lib/use-modifier-shortcut';

import { AssistantPanel } from './assistant-panel';

/**
 * The floating AI assistant (T-134, docs/design/less-text-ai-assistant.md section 2), mounted once in
 * the console layout so it is on every staff page and never on the public portal. It is quiet: no
 * blinking, no sound, never opens by itself. Ctrl or Cmd + J opens and closes it, also from a text
 * field. Only people who can read tickets (staff, and `dev` with masked tickets) see it; the api
 * refuses everyone else. While the emergency switch is on the icon is a pause sign.
 */
export function AssistantBubble() {
  const { t } = useI18n();
  const { can } = useSession();
  const allowed = can('ticket.read') || can('ticket.read.masked');
  const panelId = useId();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // Mounted on the first open and kept, so folding the panel away keeps the thread and the text.
  const [started, setStarted] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const context = usePageContext(pathname, open);
  const autonomy = useAutonomy(can('ticket.read'));
  const paused = autonomy.data?.switches.find((item) => item.key === 'ai_kill_switch')?.on ?? false;

  const toggle = useCallback(() => {
    setStarted(true);
    setOpen((current) => !current);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    button.current?.focus();
  }, []);
  useModifierShortcut('j', () => {
    if (allowed) toggle();
  });

  if (!allowed) return null;
  const Icon = paused ? CirclePause : Bot;
  const label = paused ? t('assistant.openPaused') : t('assistant.open');
  return (
    <>
      {started ? (
        <AssistantPanel id={panelId} context={context} open={open} onClose={close} />
      ) : null}
      <Button
        ref={button}
        variant="secondary"
        size="icon"
        aria-label={open ? t('assistant.close') : label}
        aria-expanded={open}
        aria-controls={started ? panelId : undefined}
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+J Meta+J"
        title={label}
        data-testid="assistant-bubble"
        onClick={toggle}
        className={cn(
          'fixed right-4 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 size-12 bg-surface text-ai-accent shadow-overlay ring-1 ring-border ring-inset md:bottom-4',
          open && 'max-md:hidden',
        )}
      >
        <Icon aria-hidden className="size-6" strokeWidth={2} />
      </Button>
    </>
  );
}
