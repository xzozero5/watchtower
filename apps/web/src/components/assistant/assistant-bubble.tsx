'use client';

import { BirddayIcon, Button, cn } from '@watchtower/ui';
import { X } from 'lucide-react';
import { CirclePause } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useCallback, useId, useRef, useState } from 'react';

import { useI18n } from '@/i18n/provider';
import { useAutonomy } from '@/lib/admin/queries';
import { useAssistantHidden, useAssistantOpenRequests } from '@/lib/assistant/assistant-ui';
import { usePageContext, type AskTarget } from '@/lib/assistant/page-context';
import { useBubbleRoom } from '@/lib/assistant/use-bubble-room';
import { isAssistantWorkspace } from '@/lib/assistant/access';
import { useSession } from '@/lib/auth/session';
import { useModifierShortcut } from '@/lib/use-modifier-shortcut';

import { AssistantPanel } from './assistant-panel';

/** The shortcut that opens and closes the assistant (UI-SPEC section 14). Ctrl+J is the browser's Downloads. */
export const ASSISTANT_SHORTCUT_KEY = '/';

/**
 * The floating AI assistant (T-134, docs/design/less-text-ai-assistant.md section 2), mounted once in
 * the console layout so it is on every staff page and never on the public portal. It is quiet: no
 * blinking, no sound, never opens by itself. Ctrl or Cmd + / opens and closes it, also from a text
 * field, and so does the palette command "Ask AI". Only workspace roles with `assistant.use` see it; the api refuses everyone else. While the emergency switch is on
 * the icon is a pause sign.
 *
 * The person can hide the button (user menu); the shortcut and the palette still open the panel.
 * The button lifts itself above a bar at the foot of the window (composer) and steps aside while
 * another dialog is open. Below 768 px the panel is a sheet that holds focus.
 */
export function AssistantBubble() {
  const { t } = useI18n();
  const { can, session } = useSession();
  const allowed = isAssistantWorkspace(session) && can('assistant.use');
  const panelId = useId();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // Mounted on the first open and kept, so folding the panel away keeps the thread and the text.
  const [started, setStarted] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  // Where focus goes back to when the button is hidden (the thing that was focused before opening).
  const returnTo = useRef<HTMLElement | null>(null);
  const pinCount = useRef(0);
  const [pinned, setPinned] = useState<{ target: AskTarget; path: string } | null>(null);
  const context = usePageContext(pathname, open, pinned?.path === pathname ? pinned.target : null);
  const autonomy = useAutonomy(can('ticket.read'));
  const paused = autonomy.data?.switches.find((item) => item.key === 'ai_kill_switch')?.on ?? false;
  const hiddenByChoice = useAssistantHidden();
  const room = useBubbleRoom();

  const remember = () => {
    const active = document.activeElement;
    returnTo.current =
      active instanceof HTMLElement && active !== document.body && active !== button.current
        ? active
        : null;
  };
  const toggle = useCallback(() => {
    if (!open) remember();
    setStarted(true);
    setOpen((current) => !current);
  }, [open]);
  const openPanel = useCallback(() => {
    if (!open) remember();
    setStarted(true);
    setOpen(true);
  }, [open]);
  // The button, or (when it is hidden) the place the person came from.
  const focusBack = useCallback(() => {
    (button.current ?? returnTo.current)?.focus();
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    focusBack();
  }, [focusBack]);
  useModifierShortcut(ASSISTANT_SHORTCUT_KEY, () => {
    if (allowed) toggle();
  });
  useAssistantOpenRequests((target) => {
    if (!allowed) return;
    // An "Ask AI about this" button: its entity becomes the chip, for this page only.
    if (target !== null) {
      pinCount.current += 1;
      setPinned({ target: { ...target, pin: pinCount.current }, path: pathname });
    }
    openPanel();
  });

  if (!allowed) return null;
  const label = paused ? t('assistant.openPaused') : t('assistant.open');
  // Hidden by choice: no button, but the panel is still reachable and still closes with Esc.
  // A dialog is open: no button either, so nothing floats over the dialog.
  const showButton = !hiddenByChoice && !room.modalOpen;
  return (
    <>
      {started ? (
        <AssistantPanel
          id={panelId}
          context={context}
          open={open}
          onClose={close}
          onClosed={focusBack}
        />
      ) : null}
      {showButton ? (
        <Button
          ref={button}
          variant="secondary"
          size="icon"
          aria-label={open ? t('assistant.close') : label}
          aria-expanded={open}
          aria-controls={started ? panelId : undefined}
          aria-haspopup="dialog"
          aria-keyshortcuts="Control+/ Meta+/"
          title={label}
          data-testid="assistant-bubble"
          onClick={toggle}
          style={room.lift > 0 ? { marginBottom: room.lift } : undefined}
          className={cn(
            'group fixed right-4 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 size-11 rounded-full border border-ai-accent/35 bg-surface shadow-overlay hover:border-ai-accent/60 hover:bg-ai-subtle motion-safe:hover:-translate-y-0.5 transition-all md:bottom-4',
            open && 'max-md:hidden',
          )}
        >
          {open ? (
            <X aria-hidden className="size-5" />
          ) : (
            <BirddayIcon
              sleeping={paused}
              className="size-8 transition-transform duration-(--wt-motion-duration-fast) motion-safe:group-hover:scale-110"
            />
          )}
          {paused ? (
            <span
              aria-hidden
              className="absolute -right-0.5 -bottom-0.5 flex size-3.5 items-center justify-center rounded-full bg-surface-muted text-muted-foreground ring-2 ring-surface"
            >
              <CirclePause className="size-3" />
            </span>
          ) : (
            <span
              aria-hidden
              className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full bg-ai-accent ring-2 ring-surface"
            />
          )}
        </Button>
      ) : null}
    </>
  );
}
