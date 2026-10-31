'use client';

import { Button, cn, SEVERITY_IDS, SeverityBadge } from '@watchtower/ui';
import { PanelRight, X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { AiSidebar } from '@/components/ai-sidebar';
import { ConversationPane } from '@/components/conversation/conversation-pane';
import { QueuePane } from '@/components/queue/queue-pane';
import { useT } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';
import { useSelectedTicket } from '@/lib/tickets/selection';

function Pane({
  id,
  title,
  className,
  children,
  footer,
  actions,
  scrolls = true,
}: {
  id: string;
  title: string;
  className?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Buttons at the right end of the pane heading. */
  actions?: ReactNode;
  /** False when the content manages its own scrolling (a pinned composer, a sticky pill). */
  scrolls?: boolean;
}) {
  const headingId = `${id}-heading`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn(
        'flex min-h-64 min-w-0 flex-col rounded-lg border border-border bg-surface md:min-h-0',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-pane py-2">
        <h2
          id={headingId}
          className="text-sm font-semibold tracking-wide text-muted-foreground uppercase"
        >
          {title}
        </h2>
        {actions}
      </div>
      <div className={cn('flex min-h-0 flex-1 flex-col', scrolls && 'overflow-y-auto')}>
        {children}
      </div>
      {footer}
    </section>
  );
}

function SeverityKey() {
  const t = useT();
  return (
    <details className="border-t border-border px-pane py-3 text-sm">
      <summary className="cursor-pointer font-medium text-foreground">
        {t('severity.keyTitle')}
      </summary>
      <p className="mt-2 text-muted-foreground">{t('severity.keyHint')}</p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {SEVERITY_IDS.map((id) => (
          <li key={id}>
            <SeverityBadge severity={id} label={t(`severity.${id}`)} />
          </li>
        ))}
      </ul>
    </details>
  );
}

/** From 48rem (768 px) the queue and the conversation sit side by side. */
const SIDE_BY_SIDE_QUERY = '(min-width: 48rem)';

/**
 * Queue | conversation | AI assistant (docs/06-UI-SPEC.md section 3.2):
 *  - 1024 px and wider: three columns;
 *  - 768 to 1023 px: queue and conversation, with the AI assistant as a right-hand drawer that a
 *    button opens (a plain region, not a modal, so the conversation stays readable);
 *  - narrower: the panes stack in reading order and the page scrolls.
 * A user who may not review AI drafts (a customer) never gets the assistant pane.
 */
export function Workspace() {
  const t = useT();
  const { can } = useSession();
  const [selectedKey, select] = useSelectedTicket();
  const showAssistant = can('ai.draft.review');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // Focus follows the drawer: into it when it opens, back to its button when it closes.
  useEffect(() => {
    if (drawerOpen) closeRef.current?.focus();
    else if (wasOpen.current) toggleRef.current?.focus();
    wasOpen.current = drawerOpen;
  }, [drawerOpen]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [drawerOpen]);

  const onSelect = useCallback(
    (key: string) => {
      select(key);
      // Stacked layout: bring the conversation into view, since it is below the queue.
      if (
        typeof window.matchMedia === 'function' &&
        !window.matchMedia(SIDE_BY_SIDE_QUERY).matches
      ) {
        requestAnimationFrame(() => {
          document.getElementById('pane-conversation')?.scrollIntoView({ block: 'start' });
        });
      }
    },
    [select],
  );

  return (
    <main
      className={cn(
        'grid min-h-0 flex-1 grid-cols-1 gap-stack p-stack md:grid-cols-[minmax(15rem,20rem)_minmax(0,1fr)]',
        showAssistant
          ? 'lg:grid-cols-[minmax(15rem,22rem)_minmax(0,1fr)_minmax(15rem,24rem)]'
          : 'lg:grid-cols-[minmax(15rem,24rem)_minmax(0,1fr)]',
      )}
    >
      <Pane
        id="pane-queue"
        title={t('panes.queue.title')}
        footer={<SeverityKey />}
        scrolls={false}
        className="max-h-[75dvh] md:max-h-none"
      >
        <QueuePane selectedKey={selectedKey} onSelect={onSelect} />
      </Pane>
      <Pane
        id="pane-conversation"
        title={t('panes.conversation.title')}
        scrolls={false}
        actions={
          showAssistant ? (
            <Button
              ref={toggleRef}
              variant="secondary"
              aria-expanded={drawerOpen}
              aria-controls="pane-assistant"
              className="hidden md:max-lg:inline-flex"
              onClick={() => {
                setDrawerOpen((open) => !open);
              }}
            >
              <PanelRight aria-hidden className="size-4" />
              {t('workspace.openAssistant')}
            </Button>
          ) : null
        }
      >
        <ConversationPane ticketKey={selectedKey} />
      </Pane>
      {showAssistant ? (
        <Pane
          id="pane-assistant"
          title={t('panes.assistant.title')}
          className={cn(
            drawerOpen
              ? 'md:max-lg:fixed md:max-lg:inset-y-0 md:max-lg:right-0 md:max-lg:z-30 md:max-lg:w-[min(24rem,90vw)] md:max-lg:rounded-none md:max-lg:shadow-lg'
              : 'md:max-lg:hidden',
          )}
          actions={
            <Button
              ref={closeRef}
              variant="ghost"
              size="icon"
              aria-label={t('workspace.closeAssistant')}
              className="hidden md:max-lg:inline-flex"
              onClick={() => {
                setDrawerOpen(false);
              }}
            >
              <X aria-hidden className="size-4" />
            </Button>
          }
        >
          <AiSidebar />
        </Pane>
      ) : null}
    </main>
  );
}
