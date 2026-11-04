'use client';

import { hasOutboundChannel } from '@watchtower/shared';
import { Button, Tooltip } from '@watchtower/ui';
import { Lock, Send } from 'lucide-react';
import { type Ref, useImperativeHandle, useRef, useState } from 'react';

import { useI18n } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';
import { useShortcut } from '@/lib/keyboard';
import { usePreferences } from '@/lib/preferences';
import type { TicketItem } from '@/lib/tickets/model';

import { Composer, type ComposerHandle, type ComposerMode } from './composer';

/** What the brief's "Write myself" can ask of the dock. */
export interface ReplyDockHandle {
  open: (mode?: ComposerMode) => void;
}

/**
 * Where the person writes. While the AI is leading a ticket (its brief and draft are on screen)
 * the composer stays out of the way: a slim bar offers "Write a reply" (C) and "Internal note"
 * (N), and the box opens when one is chosen, or when "Write myself" in the brief asks for it.
 * With nothing from the AI to act on (no brief, or it failed) the composer is simply open, as it
 * was before. Once it has been shown it stays: text being typed is never hidden by a late AI
 * answer.
 */
export function ReplyDock({
  ticket,
  aiLed,
  handleRef,
  openRef,
}: {
  ticket: TicketItem;
  /** True while the AI brief leads the ticket. */
  aiLed: boolean;
  /** What the timeline's Quote button calls. */
  handleRef?: Ref<Pick<ComposerHandle, 'quote'>>;
  openRef?: Ref<ReplyDockHandle>;
}) {
  const { t } = useI18n();
  const { can } = useSession();
  const { singleKeyShortcuts } = usePreferences();
  // No reply on a phone, walk-in, chat, other or internal ticket: nothing could be delivered.
  const canReply =
    (can('ticket.reply') || can('ticket.reply.own')) &&
    !('channel' in ticket && !hasOutboundChannel(ticket.channel));
  const canNote = can('ticket.handle');
  const [request, setRequest] = useState<{ mode: ComposerMode; quote?: string } | null>(null);
  const [pinned, setPinned] = useState(false);
  const composerRef = useRef<ComposerHandle>(null);

  if (!aiLed && !pinned) setPinned(true);
  const open = !aiLed || pinned || request !== null;

  useImperativeHandle(openRef, () => ({
    open: (mode = 'reply') => {
      const target = mode === 'reply' && !canReply ? 'note' : mode;
      if (composerRef.current) composerRef.current.focus(target);
      else setRequest({ mode: target });
    },
  }));
  useImperativeHandle(handleRef, () => ({
    quote: (text: string) => {
      if (composerRef.current) composerRef.current.quote(text);
      else if (canReply) setRequest({ mode: 'reply', quote: text });
    },
  }));

  useShortcut(
    'c',
    () => {
      setRequest({ mode: 'reply' });
    },
    !open && canReply,
  );
  useShortcut(
    'n',
    () => {
      setRequest({ mode: 'note' });
    },
    !open && canNote,
  );

  if (open) {
    return (
      <Composer
        ticket={ticket}
        handleRef={composerRef}
        autoFocus={request !== null}
        {...(request ? { initialMode: request.mode } : {})}
        {...(request?.quote !== undefined ? { initialQuote: request.quote } : {})}
        // Opened on request while the AI leads: it can be put away again (the draft is kept).
        {...(aiLed && !pinned
          ? {
              onClose: () => {
                setRequest(null);
              },
            }
          : {})}
      />
    );
  }
  if (!canReply && !canNote) return null;

  return (
    <div
      role="group"
      aria-label={t('composer.label')}
      data-sticky-footer=""
      className="flex shrink-0 gap-2 border-t border-border/60 p-3"
    >
      {canReply ? (
        <Tooltip content={t('ai.dock.reply')} shortcut={singleKeyShortcuts ? ['C'] : []}>
          <Button
            className="rounded-full"
            aria-label={t('ai.dock.reply')}
            aria-keyshortcuts={singleKeyShortcuts ? 'C' : undefined}
            onClick={() => {
              setRequest({ mode: 'reply' });
            }}
          >
            <Send aria-hidden className="size-4" />
            {t('ai.dock.replyShort')}
          </Button>
        </Tooltip>
      ) : null}
      {canNote ? (
        <Tooltip content={t('ai.dock.note')} shortcut={singleKeyShortcuts ? ['N'] : []}>
          <Button
            variant="ghost"
            className="rounded-full"
            aria-label={t('ai.dock.note')}
            aria-keyshortcuts={singleKeyShortcuts ? 'N' : undefined}
            onClick={() => {
              setRequest({ mode: 'note' });
            }}
          >
            <Lock aria-hidden className="size-4" />
            {t('ai.dock.noteShort')}
          </Button>
        </Tooltip>
      ) : null}
    </div>
  );
}
