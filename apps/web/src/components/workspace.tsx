'use client';

import { Button, cn, SEVERITY_IDS, SeverityBadge } from '@watchtower/ui';
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  X,
} from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { AiSidebar } from '@/components/ai-sidebar';
import { ConversationPane } from '@/components/conversation/conversation-pane';
import { QueuePane } from '@/components/queue/queue-pane';
import { QUEUE_LISTBOX_ID } from '@/components/queue/queue-row';
import { useT } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';
import { type PaneCommand, useShortcut, useShortcutSequence, usePaneKeys } from '@/lib/keyboard';
import { useSelectedTicket } from '@/lib/tickets/selection';

type PaneId = 'queue' | 'conversation' | 'assistant';

const PANE_ORDER: readonly PaneId[] = ['queue', 'conversation', 'assistant'];
const PANE_DOM_ID: Record<PaneId, string> = {
  queue: 'pane-queue',
  conversation: 'pane-conversation',
  assistant: 'pane-assistant',
};
const PANE_TITLE_KEY = {
  queue: 'panes.queue.title',
  conversation: 'panes.conversation.title',
  assistant: 'panes.assistant.title',
} as const;

/** From 48rem (768 px) the queue and the conversation sit side by side. */
const SIDE_BY_SIDE_QUERY = '(min-width: 48rem)';
/** From 64rem (1024 px) the AI assistant is a third column. */
const THREE_PANES_QUERY = '(min-width: 64rem)';

type Layout = 'narrow' | 'medium' | 'wide';

function subscribeLayout(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const lists = [SIDE_BY_SIDE_QUERY, THREE_PANES_QUERY].map((query) => window.matchMedia(query));
  lists.forEach((list) => {
    list.addEventListener('change', onChange);
  });
  return () => {
    lists.forEach((list) => {
      list.removeEventListener('change', onChange);
    });
  };
}

function currentLayout(): Layout {
  // Without matchMedia (tests) behave as the widest layout.
  if (typeof window.matchMedia !== 'function') return 'wide';
  if (window.matchMedia(THREE_PANES_QUERY).matches) return 'wide';
  return window.matchMedia(SIDE_BY_SIDE_QUERY).matches ? 'medium' : 'narrow';
}

/** Which of the three layouts the window is in (docs/06-UI-SPEC.md section 3.2). */
function useLayout(): Layout {
  return useSyncExternalStore(subscribeLayout, currentLayout, () => 'wide');
}

function Pane({
  id,
  title,
  className,
  children,
  footer,
  actions,
  scrolls = true,
  collapsed = false,
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
  /** From 1024 px up the pane shrinks to a rail with only its heading button. */
  collapsed?: boolean;
}) {
  const headingId = `${id}-heading`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      // Focusable by script only (F6, Alt+1..3, g q); the focused pane shows a 2 px ring.
      tabIndex={-1}
      className={cn(
        'flex min-h-64 min-w-0 flex-col rounded-lg border border-border bg-surface outline-hidden focus-within:ring-2 focus-within:ring-ring focus-within:ring-inset md:min-h-0',
        className,
      )}
    >
      <div
        className={cn(
          'flex items-center justify-between gap-2 border-b border-border px-pane py-2',
          collapsed && 'lg:flex-col lg:border-b-0 lg:px-1',
        )}
      >
        <h2
          id={headingId}
          className={cn(
            'text-sm font-semibold tracking-wide text-muted-foreground uppercase',
            collapsed && 'lg:sr-only',
          )}
        >
          {title}
        </h2>
        {actions}
      </div>
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col',
          scrolls && 'overflow-y-auto',
          collapsed && 'lg:hidden',
        )}
      >
        {children}
      </div>
      {footer ? <div className={cn(collapsed && 'lg:hidden')}>{footer}</div> : null}
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

// Complete class names, so Tailwind finds them. Queue and assistant either open or collapsed.
const THREE_COLUMNS = {
  'open-open': 'lg:grid-cols-[minmax(15rem,22rem)_minmax(0,1fr)_minmax(15rem,24rem)]',
  'closed-open': 'lg:grid-cols-[3rem_minmax(0,1fr)_minmax(15rem,24rem)]',
  'open-closed': 'lg:grid-cols-[minmax(15rem,22rem)_minmax(0,1fr)_3rem]',
  'closed-closed': 'lg:grid-cols-[3rem_minmax(0,1fr)_3rem]',
} as const;
const TWO_COLUMNS = {
  open: 'lg:grid-cols-[minmax(15rem,24rem)_minmax(0,1fr)]',
  closed: 'lg:grid-cols-[3rem_minmax(0,1fr)]',
} as const;

/** The A / E / R bar of the phone layout. The real actions arrive with the AI drafts (T-109). */
function DraftActionBar() {
  const t = useT();
  const hintId = 'draft-bar-hint';
  return (
    <div
      role="group"
      aria-label={t('ai.draftBar.label')}
      aria-describedby={hintId}
      className="sticky bottom-0 z-20 flex flex-col gap-1 border-t border-border bg-surface p-stack md:hidden"
    >
      <p id={hintId} className="text-xs text-muted-foreground">
        {t('ai.draftBar.hint')}
      </p>
      <div className="flex gap-2">
        {(['approve', 'edit', 'reject'] as const).map((action) => (
          <Button
            key={action}
            variant="secondary"
            disabled
            className="min-h-[44px] min-w-[44px] flex-1"
          >
            {t(`ai.draftBar.${action}`)}
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * Queue | conversation | AI assistant (docs/06-UI-SPEC.md sections 3.2 and 14):
 *  - 1024 px and wider: three columns; `[` and `]` collapse the queue / the AI assistant to a rail;
 *  - 768 to 1023 px: queue and conversation, with the AI assistant as a right-hand drawer that a
 *    button (or `]`) opens (a plain region, not a modal, so the conversation stays readable);
 *  - narrower: one pane at a time, chosen with tabs (Queue / Conversation / AI assistant), and a
 *    sticky A / E / R bar with 44 px targets for the AI draft.
 * F6 and Shift+F6 cycle the visible panes, Alt+1/2/3 jump to one, `g q` goes to the queue.
 * A user who may not review AI drafts (a customer) never gets the assistant pane.
 */
export function Workspace() {
  const t = useT();
  const { can } = useSession();
  const layout = useLayout();
  const [selectedKey, select] = useSelectedTicket();
  const showAssistant = can('ai.draft.review');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [queueCollapsed, setQueueCollapsed] = useState(false);
  const [assistantCollapsed, setAssistantCollapsed] = useState(false);
  const [tab, setTab] = useState<PaneId>(selectedKey ? 'conversation' : 'queue');
  const [focusRequest, setFocusRequest] = useState<{ id: string; tick: number } | null>(null);
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

  // Moves keyboard focus once the state change that revealed the target has been rendered.
  useEffect(() => {
    if (focusRequest) document.getElementById(focusRequest.id)?.focus();
  }, [focusRequest]);
  const requestFocus = useCallback((id: string) => {
    setFocusRequest((previous) => ({ id, tick: (previous?.tick ?? 0) + 1 }));
  }, []);

  const panes = PANE_ORDER.filter((pane) => pane !== 'assistant' || showAssistant);

  /** Reveals a pane if it is folded away and moves focus to it. */
  const goToPane = (pane: PaneId) => {
    if (pane === 'assistant' && !showAssistant) return;
    if (layout === 'narrow') setTab(pane);
    if (layout === 'wide') {
      if (pane === 'queue') setQueueCollapsed(false);
      if (pane === 'assistant') setAssistantCollapsed(false);
    }
    if (pane === 'assistant' && layout === 'medium') {
      // The drawer's own effect moves focus to its close button.
      setDrawerOpen(true);
      return;
    }
    requestFocus(pane === 'queue' ? QUEUE_LISTBOX_ID : PANE_DOM_ID[pane]);
  };

  // After revealing the queue the listbox may not exist yet (empty or loading): fall back to the pane.
  useEffect(() => {
    if (focusRequest?.id === QUEUE_LISTBOX_ID && !document.getElementById(QUEUE_LISTBOX_ID)) {
      document.getElementById(PANE_DOM_ID.queue)?.focus();
    }
  }, [focusRequest]);

  const visiblePanes = (): PaneId[] => {
    if (layout === 'wide') {
      return panes.filter(
        (pane) =>
          !(pane === 'queue' && queueCollapsed) && !(pane === 'assistant' && assistantCollapsed),
      );
    }
    if (layout === 'medium') return panes.filter((pane) => pane !== 'assistant' || drawerOpen);
    return panes;
  };

  const currentPane = (): PaneId | null => {
    const holder = document.activeElement?.closest('section[id^="pane-"]');
    const found = PANE_ORDER.find((pane) => PANE_DOM_ID[pane] === holder?.id);
    if (found) return found;
    return layout === 'narrow' ? tab : null;
  };

  const onPaneKey = (command: PaneCommand) => {
    if (command.type === 'jump') {
      const pane = PANE_ORDER[command.index];
      if (pane) goToPane(pane);
      return;
    }
    const order = visiblePanes();
    if (order.length === 0) return;
    const current = currentPane();
    const index = current ? order.indexOf(current) : -1;
    const next =
      index === -1
        ? command.delta === 1
          ? 0
          : order.length - 1
        : (index + command.delta + order.length) % order.length;
    const target = order[next];
    if (target) goToPane(target);
  };
  usePaneKeys(onPaneKey);

  const toggleQueue = () => {
    if (layout !== 'wide') return;
    const next = !queueCollapsed;
    setQueueCollapsed(next);
    requestFocus(next ? 'pane-queue-toggle' : QUEUE_LISTBOX_ID);
  };
  const toggleAssistant = () => {
    if (layout === 'medium' && showAssistant) {
      setDrawerOpen((open) => !open);
      return;
    }
    if (layout !== 'wide' || !showAssistant) return;
    const next = !assistantCollapsed;
    setAssistantCollapsed(next);
    requestFocus(next ? 'pane-assistant-toggle' : PANE_DOM_ID.assistant);
  };
  useShortcut('[', toggleQueue);
  useShortcut(']', toggleAssistant, showAssistant);
  useShortcutSequence('g', {
    q: () => {
      goToPane('queue');
    },
  });

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const edge = event.key === 'Home' ? 0 : event.key === 'End' ? panes.length - 1 : null;
    if (delta === 0 && edge === null) return;
    event.preventDefault();
    const index = panes.indexOf(tab);
    const next = edge ?? (index + delta + panes.length) % panes.length;
    const target = panes[next];
    if (!target) return;
    setTab(target);
    requestFocus(`tab-${target}`);
  };

  const columns = showAssistant
    ? THREE_COLUMNS[
        `${queueCollapsed ? 'closed' : 'open'}-${assistantCollapsed ? 'closed' : 'open'}`
      ]
    : TWO_COLUMNS[queueCollapsed ? 'closed' : 'open'];
  // Below 768 px only the chosen tab's pane is shown.
  const onlyOnTab = (pane: PaneId) => (tab === pane ? undefined : 'max-md:hidden');

  return (
    <>
      <div
        role="tablist"
        aria-label={t('workspace.tabsLabel')}
        onKeyDown={onTabKeyDown}
        className="flex border-b border-border bg-surface md:hidden"
      >
        {panes.map((pane) => (
          <button
            key={pane}
            id={`tab-${pane}`}
            type="button"
            role="tab"
            aria-selected={tab === pane}
            aria-controls={PANE_DOM_ID[pane]}
            tabIndex={tab === pane ? 0 : -1}
            onClick={() => {
              setTab(pane);
            }}
            className={cn(
              'min-h-[44px] flex-1 border-b-4 px-2 text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
              tab === pane
                ? 'border-primary font-semibold text-foreground'
                : 'border-transparent text-muted-foreground',
            )}
          >
            {t(PANE_TITLE_KEY[pane])}
          </button>
        ))}
      </div>
      <main
        className={cn(
          'grid min-h-0 flex-1 grid-cols-1 gap-stack p-stack md:grid-cols-[minmax(15rem,20rem)_minmax(0,1fr)]',
          columns,
        )}
      >
        <Pane
          id="pane-queue"
          title={t('panes.queue.title')}
          footer={<SeverityKey />}
          scrolls={false}
          collapsed={queueCollapsed}
          className={cn('max-h-[75dvh] md:max-h-none', onlyOnTab('queue'))}
          actions={
            <Button
              id="pane-queue-toggle"
              variant="ghost"
              size="icon"
              aria-expanded={!queueCollapsed}
              aria-controls="queue-pane-body"
              aria-keyshortcuts="["
              aria-label={t(queueCollapsed ? 'workspace.expandQueue' : 'workspace.collapseQueue')}
              className="hidden lg:inline-flex"
              onClick={() => {
                setQueueCollapsed((collapsed) => !collapsed);
              }}
            >
              {queueCollapsed ? (
                <PanelLeftOpen aria-hidden className="size-4" />
              ) : (
                <PanelLeftClose aria-hidden className="size-4" />
              )}
            </Button>
          }
        >
          <div id="queue-pane-body" className="flex min-h-0 flex-1 flex-col">
            <QueuePane
              selectedKey={selectedKey}
              onSelect={select}
              onActivate={() => {
                // A tap on a row opens the ticket: on a phone that is the Conversation tab.
                if (layout === 'narrow') goToPane('conversation');
              }}
              onOpenConversation={() => {
                goToPane('conversation');
              }}
            />
          </div>
        </Pane>
        <Pane
          id="pane-conversation"
          title={t('panes.conversation.title')}
          scrolls={false}
          className={onlyOnTab('conversation')}
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
            collapsed={assistantCollapsed}
            className={cn(
              drawerOpen
                ? 'md:max-lg:fixed md:max-lg:inset-y-0 md:max-lg:right-0 md:max-lg:z-30 md:max-lg:w-[min(24rem,90vw)] md:max-lg:rounded-none md:max-lg:shadow-lg'
                : 'md:max-lg:hidden',
              onlyOnTab('assistant'),
            )}
            actions={
              <>
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
                <Button
                  id="pane-assistant-toggle"
                  variant="ghost"
                  size="icon"
                  aria-expanded={!assistantCollapsed}
                  aria-keyshortcuts="]"
                  aria-label={t(
                    assistantCollapsed
                      ? 'workspace.expandAssistant'
                      : 'workspace.collapseAssistant',
                  )}
                  className="hidden lg:inline-flex"
                  onClick={() => {
                    setAssistantCollapsed((collapsed) => !collapsed);
                  }}
                >
                  {assistantCollapsed ? (
                    <PanelRightOpen aria-hidden className="size-4" />
                  ) : (
                    <PanelRightClose aria-hidden className="size-4" />
                  )}
                </Button>
              </>
            }
          >
            <AiSidebar />
          </Pane>
        ) : null}
      </main>
      {showAssistant && tab !== 'queue' ? <DraftActionBar /> : null}
    </>
  );
}
